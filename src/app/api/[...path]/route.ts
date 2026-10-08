import { NextRequest, NextResponse } from 'next/server';
import { proposeCustom, resolveWarning, runStep } from '@/lib/agents';
import { snapshot } from '@/lib/audit';
import { clearSession } from '@/lib/db';
import {
  assessFidelity,
  attemptCapabilityEscalation,
  attemptForgery,
  createDelegation,
  delegateCustom,
  delegateExperience,
} from '@/lib/delegation';
import { activeIntent, confirmIntent, createIntent } from '@/lib/intent';
import { authenticate, callTool, toolsForGrant } from '@/lib/gateway';
import { applyWebhook, capturePayment, createPayment, reconcile, reportOutcome } from '@/lib/payments';
import { verifyWebhook } from '@/lib/paypal';
import { updatePolicy } from '@/lib/policy';
import { publicOrigin, sessionId } from '@/lib/session';
import { ApiError } from '@/lib/types';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

type Body = Record<string, unknown>;
type Handler = (ctx: { session: string; body: Body; params: string[]; req: NextRequest }) => Promise<unknown> | unknown;

// method + path pattern → handler. `:x` matches one path segment.
const ROUTES: [string, string, Handler][] = [
  ['GET', 'audit', ({ session }) => snapshot(session)],
  ['GET', 'audit/:intent', ({ session }) => snapshot(session)],

  // the owner's spending policy
  ['GET', 'company/policy', ({ session }) => snapshot(session).policy],
  ['PUT', 'company/policy', ({ session, body }) => {
    updatePolicy(session, body);
    return snapshot(session);
  }],

  ['POST', 'intent', async ({ session, body }) => {
    await createIntent(session, String(body.prompt ?? ''));
    return snapshot(session);
  }],
  ['POST', 'intent/:id/confirm', async ({ session, params }) => {
    await confirmIntent(session, params[0]);
    return snapshot(session);
  }],

  ['POST', 'delegate', async ({ session, body }) => {
    const intent = activeIntent(session);
    // scripted delegation events for the demo
    if (body.simulate === 'escalation') attemptCapabilityEscalation(session, intent);
    if (body.simulate === 'forgery') attemptForgery(session, intent);
    if (typeof body.task === 'string') {
      // a visitor delegates a task in their own words
      await delegateCustom(session, intent, body.task, body.budget);
      return snapshot(session);
    }
    if (body.simulate === 'experience') {
      await delegateExperience(session, intent);
      return snapshot(session);
    }
    const scope = body.scope as Record<string, unknown> | undefined;
    if (
      typeof body.parent !== 'string' ||
      !['travel', 'hotel', 'booking', 'experience', 'custom', 'recovery'].includes(String(body.agent)) ||
      typeof body.budget !== 'number' ||
      typeof body.expires_at !== 'string' ||
      !scope ||
      typeof scope.location !== 'string' ||
      typeof scope.from !== 'string' ||
      typeof scope.to !== 'string'
    ) {
      throw new ApiError(400, 'INVALID_DELEGATION', 'Required: parent, agent, budget, expires_at, scope { location, from, to }.');
    }
    const created = createDelegation(session, intent, { ...body, purpose: String(body.purpose ?? 'Custom grant').slice(0, 120) } as never);
    await assessFidelity(session, intent, created);
    return snapshot(session);
  }],

  ['POST', 'transaction/evaluate', async ({ session, body }) => {
    const tx = body.step ? await runStep(session, String(body.step)) : await proposeCustom(session, body);
    return { ...snapshot(session), focus: tx.id };
  }],
  ['POST', 'transaction/:id/confirm', ({ session, params, body }) => {
    const tx = resolveWarning(session, params[0], body.approve === true);
    return { ...snapshot(session), focus: tx.id };
  }],

  ['POST', 'paypal/order', async ({ session, body }) => {
    const tx = await createPayment(session, String(body.transaction_id ?? ''), await publicOrigin());
    return { ...snapshot(session), focus: tx.id };
  }],
  ['POST', 'paypal/capture', async ({ session, body }) => {
    const tx = await capturePayment(session, String(body.transaction_id ?? ''));
    return { ...snapshot(session), focus: tx.id };
  }],
  // PayPal sends the buyer back here after approval (or cancellation)
  ['GET', 'paypal/return', async ({ session, req }) => {
    const id = req.nextUrl.searchParams.get('tx') ?? '';
    const cancelled = req.nextUrl.searchParams.get('cancelled') === '1';
    let note = cancelled ? 'cancelled' : 'paid';
    if (!cancelled) {
      try {
        const tx = await capturePayment(session, id);
        if (tx.status !== 'CAPTURED') note = 'failed';
      } catch {
        note = 'failed';
      }
    }
    const target = `${await publicOrigin()}/intentchain/?tx=${encodeURIComponent(id)}&paypal=${note}`;
    return NextResponse.redirect(target, 303);
  }],

  ['POST', 'outcome/event', async ({ session, body }) => {
    const tx = await reportOutcome(session, String(body.transaction_id ?? ''), String(body.type ?? ''));
    return { ...snapshot(session), focus: tx.id };
  }],

  ['POST', 'audit/reconcile', async ({ session }) => {
    await reconcile(session);
    return snapshot(session);
  }],

  ['POST', 'demo/reset', ({ session }) => {
    if (process.env.DEMO_MODE === 'false') throw new ApiError(403, 'RESET_DISABLED', 'Reset is only available in demo mode.');
    clearSession(session);
    return snapshot(session);
  }],
];

function match(pattern: string, path: string[]): string[] | null {
  const parts = pattern.split('/');
  if (parts.length !== path.length) return null;
  const params: string[] = [];
  for (let i = 0; i < parts.length; i++) {
    if (parts[i].startsWith(':')) params.push(path[i]);
    else if (parts[i] !== path[i]) return null;
  }
  return params;
}

/** Reads a JSON object body, with a size cap. */
async function jsonBody(req: NextRequest): Promise<Body> {
  const text = await req.text();
  if (text.length > 4000) throw new ApiError(413, 'BODY_TOO_LARGE', 'Request body too large.');
  if (!text) return {};
  try {
    return JSON.parse(text) as Body;
  } catch {
    throw new ApiError(400, 'INVALID_JSON', 'Request body must be JSON.');
  }
}

/**
 * Agent gateway: for agents outside this app. Authenticated by a grant token
 * (a signed delegation) rather than a browser session.
 *   GET  agent/tools          the PayPal tools this grant carries
 *   POST agent/tools/{name}   call one — through the firewall
 */
async function agentGateway(req: NextRequest, path: string[]): Promise<Response | null> {
  if (path[0] !== 'agent' || path[1] !== 'tools') return null;
  const grant = authenticate(req.headers.get('authorization'));
  if (req.method === 'GET' && path.length === 2) {
    return NextResponse.json({
      agent: grant.delegation.agent,
      intent: { id: grant.intent.id, goal: grant.intent.goal },
      grant: { id: grant.delegation.id, task: grant.delegation.purpose, limit_usd: grant.delegation.budget },
      tools: toolsForGrant(grant),
    });
  }
  if (req.method === 'POST' && path.length === 3) {
    return NextResponse.json(await callTool(grant, path[2], await jsonBody(req), await publicOrigin()));
  }
  return null;
}

/** PayPal webhook deliveries. Only events PayPal itself confirms as genuine are applied. */
async function paypalWebhook(req: NextRequest, path: string[]): Promise<Response | null> {
  if (req.method !== 'POST' || path.join('/') !== 'paypal/webhook') return null;
  const raw = await req.text();
  if (raw.length > 100000) throw new ApiError(413, 'BODY_TOO_LARGE', 'Request body too large.');
  if (!(await verifyWebhook(req.headers, raw))) {
    throw new ApiError(401, 'WEBHOOK_UNVERIFIED', 'PayPal did not verify this webhook delivery.');
  }
  return NextResponse.json({ applied: applyWebhook(JSON.parse(raw)) });
}

async function handle(req: NextRequest, path: string[]): Promise<Response> {
  try {
    const special = (await paypalWebhook(req, path)) ?? (await agentGateway(req, path));
    if (special) return special;
    for (const [method, pattern, handler] of ROUTES) {
      if (method !== req.method) continue;
      const params = match(pattern, path);
      if (!params) continue;
      const session = await sessionId();
      const body: Body = req.method === 'POST' || req.method === 'PUT' ? await jsonBody(req) : {};
      const out = await handler({ session, body, params, req });
      return out instanceof Response ? out : NextResponse.json(out);
    }
    throw new ApiError(404, 'NOT_FOUND', 'No such endpoint.');
  } catch (err) {
    if (err instanceof ApiError) {
      return NextResponse.json({ error: { code: err.code, message: err.message } }, { status: err.status });
    }
    console.error('[api]', err);
    return NextResponse.json({ error: { code: 'INTERNAL', message: 'Unexpected server error.' } }, { status: 500 });
  }
}

type Ctx = { params: Promise<{ path: string[] }> };

export async function GET(req: NextRequest, ctx: Ctx) {
  return handle(req, (await ctx.params).path);
}

export async function POST(req: NextRequest, ctx: Ctx) {
  return handle(req, (await ctx.params).path);
}

export async function PUT(req: NextRequest, ctx: Ctx) {
  return handle(req, (await ctx.params).path);
}
