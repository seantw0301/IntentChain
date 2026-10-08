import crypto from 'node:crypto';
import type { AgentRole, Payment } from './types';

// All PayPal access goes through the PayPal Agent Toolkit. Each agent role gets
// its own toolkit instance with only the actions that role is allowed to use,
// so the PayPal permissions shrink along the delegation chain exactly like the
// spending authority does.

type Actions = Record<string, Record<string, boolean>>;

const ROLE_ACTIONS: Record<AgentRole, Actions> = {
  travel: { orders: { create: true, get: true, capture: true } },
  hotel: {},
  booking: { orders: { create: true, get: true, capture: true } },
  experience: { orders: { create: true, get: true, capture: true } },
  custom: { orders: { create: true, get: true, capture: true } },
  recovery: { orders: { get: true }, payments: { createRefund: true, getRefunds: true } },
};

const ACTION_TOOLS: Record<string, Record<string, string>> = {
  orders: { create: 'create_order', get: 'get_order', capture: 'pay_order' },
  payments: { createRefund: 'create_refund', getRefunds: 'get_refund' },
};

export function toolsFor(role: AgentRole): string[] {
  const out: string[] = [];
  for (const [product, actions] of Object.entries(ROLE_ACTIONS[role])) {
    for (const action of Object.keys(actions)) out.push(ACTION_TOOLS[product][action]);
  }
  return out;
}

export function paypalMode(): 'sandbox' | 'mock' {
  const configured = Boolean(process.env.PAYPAL_CLIENT_ID && process.env.PAYPAL_CLIENT_SECRET);
  const mode = (process.env.PAYPAL_MODE || '').toLowerCase();
  if (mode === 'mock') return 'mock';
  return configured ? 'sandbox' : 'mock';
}

type ToolMap = Record<string, { execute?: (args: unknown, opts: unknown) => Promise<unknown> }>;
const toolkits = new Map<AgentRole, ToolMap>();
let tokenSource: { getAccessToken(): Promise<string>; getBaseUrl(): string } | null = null;

async function toolkit(role: AgentRole): Promise<ToolMap> {
  const cached = toolkits.get(role);
  if (cached) return cached;
  const { PayPalAgentToolkit } = await import('@paypal/agent-toolkit/ai-sdk');
  const instance = new PayPalAgentToolkit({
    clientId: process.env.PAYPAL_CLIENT_ID as string,
    clientSecret: process.env.PAYPAL_CLIENT_SECRET as string,
    // sandbox is hard-wired: this demo can never reach live PayPal
    configuration: { actions: ROLE_ACTIONS[role], context: { sandbox: true } },
  });
  const tools = instance.getTools() as unknown as ToolMap;
  tokenSource = instance.client;
  toolkits.set(role, tools);
  return tools;
}

async function call(role: AgentRole, tool: string, args: Record<string, unknown>): Promise<any> {
  if (!toolsFor(role).includes(tool)) {
    throw new Error(`The ${role} agent has no permission to use the PayPal tool "${tool}".`);
  }
  const tools = await toolkit(role);
  const t = tools[tool];
  if (!t?.execute) throw new Error(`PayPal tool "${tool}" is not available in the toolkit.`);
  const raw = await t.execute(args, { toolCallId: crypto.randomUUID(), messages: [] });
  let out: any = raw;
  if (typeof raw === 'string') {
    try {
      out = JSON.parse(raw);
    } catch {
      throw new Error(`PayPal ${tool} failed: ${raw.slice(0, 300)}`);
    }
  }
  // the toolkit reports failures as { ok: false, code, status, message } or { error: { message } }
  if (out && typeof out === 'object' && (out.ok === false || out.error)) {
    const message = out.message ?? out.error?.message ?? JSON.stringify(out.error ?? out);
    throw new Error(`PayPal ${tool} failed: ${String(message).slice(0, 300)}`);
  }
  return out;
}

const sim = (prefix: string) => `SIM-${prefix}-${crypto.randomBytes(5).toString('hex').toUpperCase()}`;

export interface OrderInput {
  role: AgentRole;
  name: string;
  description: string;
  amount: number;
  /** written into the PayPal order so the PayPal record links back to the human intent */
  lineage: string;
  returnUrl: string;
  cancelUrl: string;
}

export async function createOrder(input: OrderInput): Promise<Payment> {
  if (paypalMode() === 'mock') {
    if (!toolsFor(input.role).includes('create_order')) {
      throw new Error(`The ${input.role} agent has no permission to use the PayPal tool "create_order".`);
    }
    return { mode: 'mock', via: 'checkout', order_id: sim('ORDER'), approve_url: null };
  }
  const order = await call(input.role, 'create_order', {
    currencyCode: 'USD',
    items: [
      {
        name: input.name.slice(0, 120),
        description: `${input.description} | ${input.lineage}`.slice(0, 120),
        quantity: 1,
        itemCost: input.amount,
        itemTotal: input.amount,
      },
    ],
    returnUrl: input.returnUrl,
    cancelUrl: input.cancelUrl,
  });
  const links: { rel: string; href: string }[] = order?.links ?? [];
  const approve = links.find((l) => l.rel === 'payer-action') ?? links.find((l) => l.rel === 'approve');
  if (!order?.id || !approve) throw new Error('PayPal did not return an order id and approval link.');
  return { mode: 'sandbox', via: 'checkout', order_id: order.id, approve_url: approve.href };
}

export async function captureOrder(
  role: AgentRole,
  orderId: string,
): Promise<{ capture_id: string; capture_status: string }> {
  if (paypalMode() === 'mock' || orderId.startsWith('SIM-')) {
    if (!toolsFor(role).includes('pay_order')) {
      throw new Error(`The ${role} agent has no permission to use the PayPal tool "pay_order".`);
    }
    return { capture_id: sim('CAP'), capture_status: 'COMPLETED' };
  }
  const out = await call(role, 'pay_order', { id: orderId });
  const data = out?.response ?? out;
  if (out?.status === 'error') throw new Error(`PayPal capture failed: ${JSON.stringify(data).slice(0, 300)}`);
  const capture = data?.purchase_units?.[0]?.payments?.captures?.[0];
  if (!capture?.id) throw new Error('PayPal did not return a capture id. Has the buyer approved the order?');
  return { capture_id: capture.id, capture_status: String(capture.status ?? 'COMPLETED') };
}

export async function orderStatus(role: AgentRole, orderId: string): Promise<string> {
  if (paypalMode() === 'mock' || orderId.startsWith('SIM-')) return 'APPROVED';
  const out = await call(role, 'get_order', { id: orderId });
  return String(out?.status ?? 'UNKNOWN');
}

export async function refundCapture(
  role: AgentRole,
  captureId: string,
  amount: number,
  note: string,
): Promise<{ refund_id: string }> {
  if (paypalMode() === 'mock' || captureId.startsWith('SIM-')) {
    if (!toolsFor(role).includes('create_refund')) {
      throw new Error(`The ${role} agent has no permission to use the PayPal tool "create_refund".`);
    }
    return { refund_id: sim('REF') };
  }
  const out = await call(role, 'create_refund', {
    capture_id: captureId,
    amount: { currency_code: 'USD', value: amount.toFixed(2) },
    note_to_payer: note.slice(0, 250),
  });
  if (!out?.id) throw new Error('PayPal did not return a refund id.');
  return { refund_id: out.id };
}

export interface PayPalOrderState {
  order: string;
  capture: string | null;
  capture_id: string | null;
}

/** Reads the order back from PayPal: its status and the status of its capture. */
export async function readOrder(role: AgentRole, orderId: string): Promise<PayPalOrderState> {
  const out = await call(role, 'get_order', { id: orderId });
  const capture = out?.purchase_units?.[0]?.payments?.captures?.[0];
  return { order: String(out?.status ?? 'UNKNOWN'), capture: capture?.status ?? null, capture_id: capture?.id ?? null };
}

export async function readRefund(role: AgentRole, refundId: string): Promise<string> {
  const out = await call(role, 'get_refund', { refund_id: refundId });
  return String(out?.status ?? 'UNKNOWN');
}

/**
 * Asks PayPal whether a webhook delivery is genuine. Webhooks are not part of
 * the Agent Toolkit, so this one call goes to the REST API directly, reusing the
 * toolkit's sandbox client for the access token.
 */
export async function verifyWebhook(headers: Headers, rawBody: string): Promise<boolean> {
  const webhookId = process.env.PAYPAL_WEBHOOK_ID;
  if (!webhookId || paypalMode() !== 'sandbox') return false;
  await toolkit('recovery');
  if (!tokenSource) return false;
  let event: unknown;
  try {
    event = JSON.parse(rawBody);
  } catch {
    return false;
  }
  const res = await fetch(`${tokenSource.getBaseUrl()}/v1/notifications/verify-webhook-signature`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${await tokenSource.getAccessToken()}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      auth_algo: headers.get('paypal-auth-algo'),
      cert_url: headers.get('paypal-cert-url'),
      transmission_id: headers.get('paypal-transmission-id'),
      transmission_sig: headers.get('paypal-transmission-sig'),
      transmission_time: headers.get('paypal-transmission-time'),
      webhook_id: webhookId,
      webhook_event: event,
    }),
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) return false;
  return ((await res.json()) as { verification_status?: string }).verification_status === 'SUCCESS';
}

/** The billing agreement the owner approved once, which lets the company pay without a login each time. */
export function autopayAgreement(): string | null {
  return paypalMode() === 'sandbox' ? process.env.PAYPAL_AUTOPAY_AGREEMENT_ID || null : null;
}

/**
 * Auto-pay: creates and captures an order in one call against the owner's
 * billing agreement — no buyer present. The Agent Toolkit's create_order has no
 * way to name a stored payment source, so this is a direct Orders API call
 * using the toolkit's sandbox client for the access token. The transaction id
 * is the idempotency key, so a retry can never charge twice.
 */
export async function autoPay(input: {
  role: AgentRole;
  transactionId: string;
  name: string;
  description: string;
  amount: number;
  lineage: string;
}): Promise<Payment> {
  if (!toolsFor(input.role).includes('create_order')) {
    throw new Error(`The ${input.role} agent has no permission to pay through PayPal.`);
  }
  const agreement = autopayAgreement();
  if (!agreement) {
    return { mode: 'mock', via: 'billing_agreement', order_id: sim('ORDER'), capture_id: sim('CAP'), capture_status: 'COMPLETED' };
  }
  await toolkit(input.role);
  if (!tokenSource) throw new Error('PayPal client is not available.');
  const value = input.amount.toFixed(2);
  const res = await fetch(`${tokenSource.getBaseUrl()}/v2/checkout/orders`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${await tokenSource.getAccessToken()}`,
      'Content-Type': 'application/json',
      'PayPal-Request-Id': `intentchain-${input.transactionId}`,
    },
    body: JSON.stringify({
      intent: 'CAPTURE',
      purchase_units: [
        {
          amount: { currency_code: 'USD', value, breakdown: { item_total: { currency_code: 'USD', value } } },
          items: [
            {
              name: input.name.slice(0, 120),
              description: `${input.description} | ${input.lineage}`.slice(0, 120),
              quantity: '1',
              unit_amount: { currency_code: 'USD', value },
            },
          ],
        },
      ],
      payment_source: { token: { id: agreement, type: 'BILLING_AGREEMENT' } },
    }),
    signal: AbortSignal.timeout(20000),
  });
  const order = (await res.json()) as any;
  const capture = order?.purchase_units?.[0]?.payments?.captures?.[0];
  if (!res.ok || !capture?.id) {
    throw new Error(`PayPal auto-pay failed: ${String(order?.message ?? order?.name ?? res.status).slice(0, 200)}`);
  }
  return {
    mode: 'sandbox',
    via: 'billing_agreement',
    order_id: order.id,
    capture_id: capture.id,
    capture_status: String(capture.status ?? order.status),
  };
}
