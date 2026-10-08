import { emit } from './audit';
import { CATEGORIES, HOTEL_OPTIONS, ITEMS } from './catalog';
import { get, newId, put } from './db';
import { createDelegation, delegationFor } from './delegation';
import { activeIntent } from './intent';
import { asChoice, ask } from './jev';
import { evaluate } from './validator';
import { ApiError } from './types';
import type { AgentRole, CatalogItem, Category, Decision, DecisionOption, Intent, Transaction } from './types';

// The agents are deterministic orchestrators: code decides the workflow, the AI
// supplies judgement (alignment, explanations), and the validator has the final
// word before any PayPal tool is touched.

export const SCENARIO: Record<string, { agent: AgentRole; item: string; label: string }> = {
  esim: { agent: 'travel', item: 'esim', label: 'Travel Agent buys a Japan eSIM' },
  'luxury-hotel': { agent: 'booking', item: 'luxury-hotel', label: 'Booking Agent tries a luxury hotel' },
  'theme-park': { agent: 'travel', item: 'theme-park', label: 'Travel Agent adds a theme park ticket' },
  hotel: { agent: 'booking', item: 'hotel-b', label: 'Hotel Agent compares hotels, Booking Agent books' },
  'airport-transfer': { agent: 'travel', item: 'airport-transfer', label: 'Travel Agent adds an airport transfer' },
};

export async function propose(
  session: string,
  intent: Intent,
  agent: AgentRole,
  item: CatalogItem,
  decision_id?: string,
): Promise<Transaction> {
  emit(session, 'transaction.proposed', `${agent}-agent`, { intent_id: intent.id }, {
    item: item.name,
    amount: item.amount,
  });
  const { validation, delegation } = await evaluate(session, intent, agent, item);
  const now = new Date().toISOString();
  const tx: Transaction = {
    id: newId('txn'),
    intent_id: intent.id,
    agent,
    delegation_id: delegation?.id ?? null,
    item,
    decision_id,
    validation,
    status: validation.decision,
    created_at: now,
    updated_at: now,
  };
  put('transactions', session, tx);
  emit(session, `transaction.${validation.decision.toLowerCase()}`, 'validator', {
    intent_id: intent.id,
    transaction_id: tx.id,
  }, {
    item: item.name,
    amount: item.amount,
    reason: validation.reason_code,
    score: validation.intent.score,
    ai_source: validation.intent.source,
  });
  return tx;
}

/** Hotel Agent: compare the candidates and record why one was chosen. */
async function selectHotel(session: string, intent: Intent): Promise<Decision> {
  const perNight = delegationFor(session, 'booking')?.per_night ?? Infinity;
  const options: DecisionOption[] = HOTEL_OPTIONS.map((o) => {
    const item = ITEMS[o.id];
    let reason = '';
    if (o.minutes_to_meeting > 20) reason = `Too far from the meeting (${o.minutes_to_meeting} min)`;
    else if (!o.refundable) reason = 'Non-refundable';
    else if (item.amount / (item.nights ?? 1) > perNight) reason = 'Above the per-night limit';
    return {
      item,
      minutes_to_meeting: o.minutes_to_meeting,
      refundable: o.refundable,
      outcome: reason ? 'REJECTED' : 'SELECTED',
      reason: reason || `${o.minutes_to_meeting} min from the meeting, refundable`,
    };
  });
  // keep a single winner: the closest acceptable option
  const winners = options.filter((o) => o.outcome === 'SELECTED').sort((a, b) => a.minutes_to_meeting - b.minutes_to_meeting);
  if (!winners.length) throw new ApiError(409, 'NO_HOTEL', 'No hotel satisfies the delegated limits.');
  for (const o of winners.slice(1)) {
    o.outcome = 'REJECTED';
    o.reason = `Further from the meeting than ${winners[0].item.name.split(' — ')[0]}`;
  }
  const selected = winners[0];
  const because = [
    'within the delegated budget',
    `${selected.minutes_to_meeting} minutes from the meeting`,
    'refundable',
    `satisfies the ${intent.purpose}-trip intent`,
  ];

  // independent AI review: which option would the AI pick for this intent?
  const answers = await ask(
    session,
    {
      human_intent: { goal: intent.goal, purpose: intent.purpose_detail },
      options: options.map((o) => ({
        id: o.item.id,
        price_usd: o.item.amount,
        minutes_to_meeting: o.minutes_to_meeting,
        refundable: o.refundable,
      })),
    },
    {
      best: {
        type: 'choice',
        instructions: 'Which option best serves human_intent? Prefer being close to the meeting and refundable.',
        criteria: Object.fromEntries(options.map((o) => [o.item.id, `${o.item.name}, $${o.item.amount}`])),
      },
    },
  );
  const review = asChoice(answers?.best);
  if (review) {
    const pct = Math.round(review.confidence * 100);
    because.push(
      review.choice === selected.item.id
        ? `independent AI review picked the same option (${pct}% confidence)`
        : `independent AI review preferred ${ITEMS[review.choice]?.name ?? review.choice} (${pct}% confidence) — kept the rule-based choice`,
    );
  }

  const decision: Decision = {
    id: newId('dec'),
    intent_id: intent.id,
    agent: 'hotel',
    question: 'Which hotel best serves the trip?',
    options,
    selected_item_id: selected.item.id,
    because,
    source: review ? 'jev' : 'cached',
    created_at: new Date().toISOString(),
  };
  put('decisions', session, decision);
  emit(session, 'decision.recorded', 'hotel-agent', { intent_id: intent.id }, {
    selected: selected.item.name,
    rejected: options.filter((o) => o.outcome === 'REJECTED').map((o) => `${o.item.name}: ${o.reason}`),
  });
  return decision;
}

export async function runStep(session: string, step: string): Promise<Transaction> {
  const intent = activeIntent(session);
  const s = SCENARIO[step];
  if (!s) throw new ApiError(400, 'UNKNOWN_STEP', `Unknown step "${step}".`);
  if (step === 'hotel') {
    const decision = await selectHotel(session, intent);
    return propose(session, intent, 'booking', ITEMS[decision.selected_item_id], decision.id);
  }
  return propose(session, intent, s.agent, ITEMS[s.item]);
}

/** Lets a visitor ask the Travel Agent to buy anything, to probe the validator. */
export async function proposeCustom(
  session: string,
  input: { name?: unknown; amount?: unknown; category?: unknown; agent?: unknown },
): Promise<Transaction> {
  const intent = activeIntent(session);
  const name = String(input.name ?? '').trim().slice(0, 80);
  const amount = Number(input.amount);
  const category = String(input.category ?? 'other') as Category;
  const agent = (['travel', 'booking'].includes(String(input.agent)) ? input.agent : 'travel') as AgentRole;
  if (!name) throw new ApiError(400, 'NAME_REQUIRED', 'Name the purchase.');
  if (!Number.isFinite(amount) || amount <= 0 || amount > 100000) {
    throw new ApiError(400, 'AMOUNT_INVALID', 'Enter an amount between 0 and 100,000.');
  }
  if (!CATEGORIES.includes(category)) throw new ApiError(400, 'CATEGORY_INVALID', 'Unknown category.');
  const item: CatalogItem = {
    id: newId('custom'),
    name,
    merchant: 'Custom merchant',
    description: 'Visitor-defined purchase',
    amount: Math.round(amount * 100) / 100,
    category,
    location: intent.location,
    day_offset: 0,
    nights: category === 'lodging' ? intent.nights : undefined,
  };
  return propose(session, intent, agent, item);
}

/** Demonstrates monotonic delegation: the Booking Agent tries to hand out more than it holds. */
export function attemptEscalation(session: string): never {
  const intent = activeIntent(session);
  const booking = delegationFor(session, 'booking');
  if (!booking) throw new ApiError(409, 'NO_DELEGATION', 'No booking delegation exists.');
  createDelegation(session, intent, {
    parent: booking.id,
    agent: 'booking',
    purpose: 'Re-delegate the full trip budget',
    budget: intent.budget + 400,
    scope: { location: intent.location, from: intent.trip_start, to: intent.trip_end },
    expires_at: `${intent.trip_end}T23:59:59.000Z`,
  });
  throw new ApiError(500, 'ESCALATION_SUCCEEDED', 'Escalation unexpectedly succeeded.');
}

/** A human resolves a WARNING: approve it for payment, or reject it. */
export function resolveWarning(session: string, id: string, approve: boolean): Transaction {
  const tx = get<Transaction>('transactions', session, id);
  if (!tx) throw new ApiError(404, 'TX_NOT_FOUND', 'Transaction not found.');
  if (tx.status !== 'WARNING') throw new ApiError(409, 'NOT_A_WARNING', 'Only a WARNING can be confirmed.');
  tx.status = approve ? 'APPROVED' : 'BLOCKED';
  tx.validation = {
    ...tx.validation,
    decision: tx.status,
    reason_code: approve ? 'OK' : 'REJECTED_BY_HUMAN',
    headline: approve ? 'Confirmed by the human. Cleared for payment.' : 'Rejected by the human.',
  };
  tx.updated_at = new Date().toISOString();
  put('transactions', session, tx);
  emit(session, approve ? 'transaction.approved' : 'transaction.blocked', 'human', {
    intent_id: tx.intent_id,
    transaction_id: tx.id,
  }, { item: tx.item.name, amount: tx.item.amount, reason: approve ? 'HUMAN_CONFIRMED' : 'REJECTED_BY_HUMAN' });
  return tx;
}
