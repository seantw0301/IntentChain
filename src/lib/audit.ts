import { db, list, newId } from './db';
import { channel3Enabled } from './channel3';
import { aiMode } from './jev';
import { llmModel } from './llm';
import { autopayToken, paypalMode } from './paypal';
import { getPolicy } from './policy';
import type {
  AppState,
  AuditEvent,
  Decision,
  Delegation,
  Intent,
  Metrics,
  Recovery,
  Transaction,
} from './types';

/** Every state change is written here. The audit timeline is this table. */
export function emit(
  session: string,
  type: string,
  actor: string,
  ref: { intent_id?: string | null; transaction_id?: string | null },
  data: Record<string, unknown> = {},
): void {
  const event: Omit<AuditEvent, 'seq'> = {
    id: newId('evt'),
    type,
    intent_id: ref.intent_id ?? null,
    transaction_id: ref.transaction_id ?? null,
    actor,
    at: new Date().toISOString(),
    data,
  };
  db()
    .prepare('INSERT INTO audit_events (session_id, data) VALUES (?, ?)')
    .run(session, JSON.stringify(event));
}

export function events(session: string): AuditEvent[] {
  const rows = db()
    .prepare('SELECT seq, data FROM audit_events WHERE session_id = ? ORDER BY seq')
    .all(session) as { seq: number; data: string }[];
  return rows.map((r) => ({ seq: r.seq, ...(JSON.parse(r.data) as Omit<AuditEvent, 'seq'>) }));
}

const HOLDING: Transaction['status'][] = ['CAPTURED', 'OUTCOME_FAILED', 'REFUND_FAILED'];
const EVER_PAID: Transaction['status'][] = [...HOLDING, 'REFUNDED'];

/** Money currently held by merchants: captured and not refunded. */
export function spent(transactions: Transaction[]): number {
  return transactions.filter((t) => HOLDING.includes(t.status)).reduce((s, t) => s + t.item.amount, 0);
}

export function metrics(intent: Intent, transactions: Transaction[], recoveries: Recovery[]): Metrics {
  const paid = transactions.filter((t) => EVER_PAID.includes(t.status));
  const total = paid.reduce((s, t) => s + t.item.amount, 0);
  const scored = paid.filter((t) => t.validation.intent.score !== null);
  const scoredTotal = scored.reduce((s, t) => s + t.item.amount, 0);
  const used = spent(transactions);
  const failed = transactions.some((t) => t.status === 'OUTCOME_FAILED' || t.status === 'REFUND_FAILED');
  return {
    budget: intent.budget,
    spent: used,
    remaining: intent.budget - used,
    // amount-weighted mean alignment score of everything that was actually paid
    intent_integrity: scoredTotal
      ? Math.round(scored.reduce((s, t) => s + (t.validation.intent.score as number) * t.item.amount, 0) / scoredTotal)
      : null,
    // share of paid transactions that were inside the paying agent's authority
    authority_integrity: total
      ? Math.round((paid.filter((t) => t.validation.authority.pass).length / paid.length) * 100)
      : null,
    outcome_status: !paid.length
      ? 'No payments yet'
      : failed || recoveries.length
        ? 'Recovery Active'
        : 'On Track',
  };
}

export function snapshot(session: string): AppState {
  const intent = list<Intent>('intents', session).at(-1) ?? null;
  const transactions = list<Transaction>('transactions', session);
  const recoveries = list<Recovery>('recoveries', session);
  const delegations = list<Delegation>('delegations', session);
  return {
    intent,
    delegations,
    policy: getPolicy(session),
    autopay: {
      connected: paypalMode() === 'mock' || Boolean(autopayToken()),
      mode: paypalMode(),
      token_id: autopayToken(),
    },
    grant_tokens: Object.fromEntries(
      delegations
        .filter((d) => d.signature && d.paypal_tools.length)
        .map((d) => [d.id, `ic_${Buffer.from(`${d.id}.${d.signature}`).toString('base64url')}`]),
    ),
    transactions,
    decisions: list<Decision>('decisions', session),
    recoveries,
    events: events(session),
    metrics: intent ? metrics(intent, transactions, recoveries) : null,
    config: {
      paypal_mode: paypalMode(),
      ai_mode: aiMode(),
      agent_model: llmModel(),
      product_search: channel3Enabled(),
      demo_mode: process.env.DEMO_MODE !== 'false',
    },
  };
}
