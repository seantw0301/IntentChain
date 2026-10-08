import crypto from 'node:crypto';
import { propose } from './agents';
import { CATEGORIES, ITEMS } from './catalog';
import { channel3Item } from './channel3';
import { get, newId, sessionOfDelegation } from './db';
import { verifyChain } from './delegation';
import { capturePayment, createPayment } from './payments';
import { toolsFor } from './paypal';
import { ApiError } from './types';
import type { CatalogItem, Category, Delegation, Intent, Transaction } from './types';

// The agent gateway lets an agent that lives outside this app — any language,
// any model — use PayPal through IntentChain. It authenticates with a grant
// token (a signed delegation) instead of a browser session, sees only the tools
// that grant carries, and every call it makes goes through the firewall.

/** A grant token is a signed delegation: its id and signature. It never contains the session id. */
export function grantToken(d: Delegation): string {
  return `ic_${Buffer.from(`${d.id}.${d.signature}`).toString('base64url')}`;
}

export interface Grant {
  session: string;
  intent: Intent;
  delegation: Delegation;
}

export function authenticate(authorization: string | null): Grant {
  const token = (authorization ?? '').replace(/^Bearer\s+/i, '').trim();
  if (!token.startsWith('ic_')) {
    throw new ApiError(401, 'GRANT_REQUIRED', 'Send a grant token: Authorization: Bearer ic_…');
  }
  const [id, signature] = Buffer.from(token.slice(3), 'base64url').toString().split('.');
  const session = id ? sessionOfDelegation(id) : null;
  const delegation = session && id ? get<Delegation>('delegations', session, id) : null;
  const presented = Buffer.from(signature ?? '');
  const expected = Buffer.from(delegation?.signature ?? '');
  if (!session || !delegation || presented.length !== expected.length || !crypto.timingSafeEqual(presented, expected)) {
    throw new ApiError(401, 'GRANT_INVALID', 'Unknown or forged grant token.');
  }
  const intent = get<Intent>('intents', session, delegation.intent_id);
  if (!intent || intent.status !== 'ACTIVE') throw new ApiError(401, 'GRANT_INVALID', 'The intent behind this grant is not active.');
  const chain = verifyChain(session, intent, delegation);
  if (!chain.ok) throw new ApiError(401, 'GRANT_INVALID', chain.reason);
  return { session, intent, delegation };
}

interface ToolDefinition {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

const DEFINITIONS: Record<string, ToolDefinition> = {
  create_order: {
    name: 'create_order',
    description:
      'Propose a purchase and, if the IntentChain firewall approves it, create a PayPal order for it. ' +
      'The firewall checks company policy, budget, authority, scope and whether the purchase serves the human intent. ' +
      'Small approved purchases are auto-paid; larger ones need a manager to approve in PayPal. ' +
      'A blocked purchase returns blocked=true with the reason; do not retry it with different wording.',
    input_schema: {
      type: 'object',
      properties: {
        item_name: { type: 'string', description: 'What is being bought, e.g. "Japan eSIM 5GB".' },
        amount_usd: { type: 'number', description: 'Total price in US dollars.' },
        category: { type: 'string', enum: CATEGORIES, description: 'The kind of purchase.' },
        nights: { type: 'integer', description: 'Number of nights, for lodging only.' },
        option_id: { type: 'string', description: 'The option_id of a catalogue option, when buying one found by search_options.' },
      },
      required: ['item_name', 'amount_usd', 'category'],
      additionalProperties: false,
    },
  },
  get_order: {
    name: 'get_order',
    description: 'Look up a transaction created through this grant: firewall decision, PayPal order and payment status.',
    input_schema: {
      type: 'object',
      properties: { transaction_id: { type: 'string' } },
      required: ['transaction_id'],
      additionalProperties: false,
    },
  },
  pay_order: {
    name: 'pay_order',
    description: 'Capture the PayPal payment for an approved transaction, after the buyer has approved the order in PayPal.',
    input_schema: {
      type: 'object',
      properties: { transaction_id: { type: 'string' } },
      required: ['transaction_id'],
      additionalProperties: false,
    },
  },
};

/** Only the tools this grant's role was given — the same list its PayPal toolkit is built with. */
export function toolsForGrant(grant: Grant): ToolDefinition[] {
  return toolsFor(grant.delegation.agent)
    .map((name) => DEFINITIONS[name])
    .filter(Boolean);
}

function summarize(tx: Transaction) {
  const v = tx.validation;
  return {
    transaction_id: tx.id,
    item: tx.item.name,
    amount_usd: tx.item.amount,
    status: tx.status,
    blocked: tx.status === 'BLOCKED',
    needs_human_review: tx.status === 'WARNING',
    decision: v.decision,
    reason_code: v.reason_code,
    explanation: v.headline,
    payment_route: v.payment_route ?? null,
    checks: {
      policy: v.policy.pass ? 'pass' : `fail: ${v.policy.detail}`,
      budget: v.budget.pass ? 'pass' : `fail: ${v.budget.detail}`,
      authority: v.authority.pass ? 'pass' : `fail: ${v.authority.detail}`,
      scope: v.scope.pass ? 'pass' : `fail: ${v.scope.detail}`,
      intent: `${v.intent.status}${v.intent.score !== null ? ` (alignment ${v.intent.score}/100)` : ''}: ${v.intent.detail}`,
    },
    violation: v.violation ?? null,
    paypal: tx.payment
      ? {
          mode: tx.payment.mode,
          order_id: tx.payment.order_id ?? null,
          approve_url: tx.payment.approve_url ?? null,
          capture_id: tx.payment.capture_id ?? null,
          error: tx.payment.error ?? null,
        }
      : null,
    next_step:
      tx.status === 'ORDER_CREATED'
        ? 'This is above the auto-pay limit. A manager must approve it in PayPal (approve_url). Then call pay_order.'
        : tx.status === 'CAPTURED'
          ? 'Paid.'
        : tx.status === 'WARNING'
          ? 'A human must confirm this purchase in IntentChain before it can be paid.'
          : tx.status === 'BLOCKED'
            ? 'This purchase is not allowed under your grant. Report the reason to the user.'
            : null,
  };
}

export async function callTool(grant: Grant, name: string, input: Record<string, unknown>, origin: string) {
  const { session, intent, delegation } = grant;
  if (!toolsForGrant(grant).some((t) => t.name === name)) {
    throw new ApiError(403, 'TOOL_NOT_GRANTED', `The ${delegation.agent} agent's grant does not include the PayPal tool "${name}".`);
  }

  if (name === 'create_order') {
    const item_name = String(input.item_name ?? '').trim().slice(0, 80);
    const amount = Number(input.amount_usd);
    const category = String(input.category ?? 'other') as Category;
    const picked = typeof input.option_id === 'string' && Boolean(ITEMS[input.option_id] ?? channel3Item(input.option_id));
    if (!picked && !item_name) throw new ApiError(400, 'INVALID_INPUT', 'item_name is required.');
    if (!picked && (!Number.isFinite(amount) || amount <= 0 || amount > 100000)) throw new ApiError(400, 'INVALID_INPUT', 'amount_usd must be between 0 and 100,000.');
    if (!picked && !CATEGORIES.includes(category)) throw new ApiError(400, 'INVALID_INPUT', `category must be one of: ${CATEGORIES.join(', ')}.`);
    const nights = Number.isInteger(input.nights) && (input.nights as number) > 0 ? (input.nights as number) : undefined;
    // a catalogue option keeps its identity; anything else is taken as described
    const known = typeof input.option_id === 'string' ? (ITEMS[input.option_id] ?? channel3Item(input.option_id) ?? undefined) : undefined;
    const item: CatalogItem = known ?? {
      id: newId('ext'),
      name: item_name,
      merchant: 'External agent',
      description: 'Proposed through the agent gateway',
      amount: Math.round(amount * 100) / 100,
      category,
      location: intent.location,
      day_offset: 0,
      nights: category === 'lodging' ? (nights ?? intent.nights) : undefined,
    };
    let tx = await propose(session, intent, delegation.agent, item);
    if (tx.status === 'APPROVED') tx = await createPayment(session, tx.id, origin);
    return summarize(tx);
  }

  const id = String(input.transaction_id ?? '');
  const tx = get<Transaction>('transactions', session, id);
  // an agent may only touch transactions made under its own grant
  if (!tx || tx.delegation_id !== delegation.id) throw new ApiError(404, 'TX_NOT_FOUND', 'No such transaction under this grant.');
  if (name === 'pay_order') return summarize(await capturePayment(session, id));
  return summarize(tx);
}
