import { emit, spent } from './audit';
import { ITEMS, RECOVERY_OPTION } from './catalog';
import { get, list, newId, put } from './db';
import { captureOrder, createOrder, orderStatus, paypalMode, refundCapture } from './paypal';
import { asNoul, ask } from './jev';
import { evaluate } from './validator';
import { ApiError } from './types';
import type { Delegation, Intent, Recovery, Transaction } from './types';

function load(session: string, id: string): Transaction {
  const tx = get<Transaction>('transactions', session, id);
  if (!tx) throw new ApiError(404, 'TX_NOT_FOUND', 'Transaction not found.');
  return tx;
}

function save(session: string, tx: Transaction): Transaction {
  tx.updated_at = new Date().toISOString();
  return put('transactions', session, tx);
}

/**
 * Creates the PayPal order. Only a transaction the validator approved can get
 * here, and the budget is re-checked because other payments may have landed
 * since the approval.
 */
export async function createPayment(session: string, id: string, origin: string): Promise<Transaction> {
  const tx = load(session, id);
  if (tx.status === 'ORDER_CREATED') return tx;
  if (tx.status !== 'APPROVED') {
    throw new ApiError(409, 'NOT_APPROVED', `Only an APPROVED transaction can be paid. This one is ${tx.status}.`);
  }
  const intent = get<Intent>('intents', session, tx.intent_id) as Intent;
  const used = spent(list<Transaction>('transactions', session));
  if (used + tx.item.amount > intent.budget) {
    tx.status = 'BLOCKED';
    tx.validation = {
      ...tx.validation,
      budget: { pass: false, detail: `$${used} spent + $${tx.item.amount} is over the $${intent.budget} budget` },
      decision: 'BLOCKED',
      reason_code: 'BUDGET_EXCEEDED',
      headline: 'Budget exceeded. Other payments were captured after this approval.',
    };
    save(session, tx);
    emit(session, 'transaction.blocked', 'validator', { intent_id: tx.intent_id, transaction_id: tx.id }, {
      item: tx.item.name,
      amount: tx.item.amount,
      reason: 'BUDGET_EXCEEDED',
    });
    return tx;
  }
  const back = `${origin}/intentchain/api/paypal/return?tx=${tx.id}`;
  try {
    tx.payment = await createOrder({
      role: tx.agent,
      name: tx.item.name,
      description: tx.item.description,
      amount: tx.item.amount,
      lineage: `IntentChain ${tx.intent_id} / ${tx.agent}-agent / ${tx.id}`,
      returnUrl: back,
      cancelUrl: `${back}&cancelled=1`,
    });
    tx.status = 'ORDER_CREATED';
    save(session, tx);
    emit(session, 'payment.order_created', `${tx.agent}-agent`, { intent_id: tx.intent_id, transaction_id: tx.id }, {
      item: tx.item.name,
      amount: tx.item.amount,
      order_id: tx.payment.order_id,
      mode: tx.payment.mode,
    });
  } catch (err) {
    tx.status = 'PAYMENT_FAILED';
    tx.payment = { mode: paypalMode(), error: (err as Error).message };
    save(session, tx);
    emit(session, 'payment.failed', `${tx.agent}-agent`, { intent_id: tx.intent_id, transaction_id: tx.id }, {
      item: tx.item.name,
      error: (err as Error).message,
    });
  }
  return tx;
}

/** Captures the order after the buyer approved it in PayPal. */
export async function capturePayment(session: string, id: string): Promise<Transaction> {
  const tx = load(session, id);
  if (tx.status === 'CAPTURED') return tx;
  if (tx.status !== 'ORDER_CREATED' || !tx.payment?.order_id) {
    throw new ApiError(409, 'NO_ORDER', `No open PayPal order for this transaction (${tx.status}).`);
  }
  try {
    // never re-capture blindly: look at the order first
    const status = await orderStatus(tx.agent, tx.payment.order_id);
    if (status !== 'APPROVED' && status !== 'COMPLETED') {
      throw new ApiError(409, 'NOT_APPROVED_BY_BUYER', `The buyer has not approved the PayPal order yet (${status}).`);
    }
    const { capture_id } = await captureOrder(tx.agent, tx.payment.order_id);
    tx.payment.capture_id = capture_id;
    tx.status = 'CAPTURED';
    save(session, tx);
    if (tx.delegation_id) {
      const d = get<Delegation>('delegations', session, tx.delegation_id);
      if (d?.single_use) put('delegations', session, { ...d, status: 'USED' as const });
    }
    emit(session, 'payment.captured', 'paypal', { intent_id: tx.intent_id, transaction_id: tx.id }, {
      item: tx.item.name,
      amount: tx.item.amount,
      capture_id,
      mode: tx.payment.mode,
    });
  } catch (err) {
    if (err instanceof ApiError) throw err;
    tx.payment.error = (err as Error).message;
    tx.status = 'PAYMENT_FAILED';
    save(session, tx);
    emit(session, 'payment.failed', 'paypal', { intent_id: tx.intent_id, transaction_id: tx.id }, {
      item: tx.item.name,
      error: (err as Error).message,
    });
  }
  return tx;
}

/** Recovery Agent: propose a replacement and stop for human approval. */
async function proposeRecovery(session: string, intent: Intent, failed: Transaction): Promise<Recovery> {
  const item = ITEMS[RECOVERY_OPTION.id];
  // the replacement is checked against the Hotel Agent's standing authority;
  // the Booking Agent's single-use grant is already spent
  const { validation } = await evaluate(session, intent, 'hotel', item);
  let reason = `${RECOVERY_OPTION.minutes_to_meeting} minutes from the meeting, refundable, within the remaining authority.`;
  const answers = await ask(
    session,
    {
      human_intent: { goal: intent.goal, purpose: intent.purpose_detail },
      cancelled: failed.item.name,
      replacement: { name: item.name, price_usd: item.amount, minutes_to_meeting: RECOVERY_OPTION.minutes_to_meeting, refundable: true },
    },
    {
      suitable: {
        type: 'noul',
        instructions: 'Is `replacement` a suitable substitute for the `cancelled` booking, given human_intent?',
      },
    },
  );
  const suitable = asNoul(answers?.suitable);
  if (suitable !== null) reason += ` AI suitability check: ${Math.round(suitable * 100)}%.`;
  const recovery: Recovery = {
    id: newId('rec'),
    intent_id: intent.id,
    failed_transaction_id: failed.id,
    status: 'AWAITING_HUMAN',
    proposal: { item, validation, reason, source: suitable !== null ? 'jev' : 'cached' },
    created_at: new Date().toISOString(),
  };
  put('recoveries', session, recovery);
  emit(session, 'recovery.proposed', 'recovery-agent', { intent_id: intent.id, transaction_id: failed.id }, {
    replacement: item.name,
    amount: item.amount,
    decision: validation.decision,
  });
  return recovery;
}

/**
 * Outcome accountability: a captured payment whose booking is later cancelled
 * has not achieved the human's goal. Mark it failed, refund it, and propose a
 * replacement — which needs fresh human approval before anything is paid.
 */
export async function reportOutcome(session: string, id: string, type: string): Promise<Transaction> {
  if (type !== 'booking_cancelled') throw new ApiError(400, 'UNKNOWN_EVENT', `Unknown outcome event "${type}".`);
  const tx = load(session, id);
  if (tx.status !== 'CAPTURED' && tx.status !== 'REFUND_FAILED') {
    throw new ApiError(409, 'NOT_CAPTURED', 'Only a captured payment can have a failed outcome.');
  }
  const intent = get<Intent>('intents', session, tx.intent_id) as Intent;
  if (tx.status === 'CAPTURED') {
    tx.status = 'OUTCOME_FAILED';
    save(session, tx);
    emit(session, 'outcome.failed', 'outcome-monitor', { intent_id: tx.intent_id, transaction_id: tx.id }, {
      item: tx.item.name,
      event: type,
    });
  }
  try {
    const { refund_id } = await refundCapture('recovery', tx.payment!.capture_id!, tx.item.amount, `Booking cancelled — ${tx.intent_id}`);
    tx.payment!.refund_id = refund_id;
    tx.status = 'REFUNDED';
    save(session, tx);
    emit(session, 'payment.refunded', 'recovery-agent', { intent_id: tx.intent_id, transaction_id: tx.id }, {
      item: tx.item.name,
      amount: tx.item.amount,
      refund_id,
      mode: tx.payment!.mode,
    });
  } catch (err) {
    tx.payment!.error = (err as Error).message;
    tx.status = 'REFUND_FAILED';
    save(session, tx);
    emit(session, 'payment.refund_failed', 'recovery-agent', { intent_id: tx.intent_id, transaction_id: tx.id }, {
      item: tx.item.name,
      error: (err as Error).message,
    });
    return tx;
  }
  if (tx.item.category === 'lodging' && !list<Recovery>('recoveries', session).some((r) => r.failed_transaction_id === tx.id)) {
    await proposeRecovery(session, intent, tx);
  }
  return tx;
}
