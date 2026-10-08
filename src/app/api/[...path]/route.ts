import { NextRequest, NextResponse } from 'next/server';
import { attemptEscalation, proposeCustom, resolveWarning, runStep } from '@/lib/agents';
import { snapshot } from '@/lib/audit';
import { clearSession } from '@/lib/db';
import { createDelegation } from '@/lib/delegation';
import { activeIntent, confirmIntent, createIntent } from '@/lib/intent';
import { capturePayment, createPayment, reportOutcome } from '@/lib/payments';
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

  ['POST', 'intent', async ({ session, body }) => {
    await createIntent(session, String(body.prompt ?? ''));
    return snapshot(session);
  }],
  ['POST', 'intent/:id/confirm', ({ session, params }) => {
    confirmIntent(session, params[0]);
    return snapshot(session);
  }],

  ['POST', 'delegate', ({ session, body }) => {
    if (body.simulate === 'escalation') attemptEscalation(session);
    const intent = activeIntent(session);
    const scope = body.scope as Record<string, unknown> | undefined;
    if (
      typeof body.parent !== 'string' ||
      !['travel', 'hotel', 'booking', 'recovery'].includes(String(body.agent)) ||
      typeof body.budget !== 'number' ||
      typeof body.expires_at !== 'string' ||
      !scope ||
      typeof scope.location !== 'string' ||
      typeof scope.from !== 'string' ||
      typeof scope.to !== 'string'
    ) {
      throw new ApiError(400, 'INVALID_DELEGATION', 'Required: parent, agent, budget, expires_at, scope { location, from, to }.');
    }
    createDelegation(session, intent, { ...body, purpose: String(body.purpose ?? 'Custom grant') } as never);
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

async function handle(req: NextRequest, path: string[]): Promise<Response> {
  try {
    for (const [method, pattern, handler] of ROUTES) {
      if (method !== req.method) continue;
      const params = match(pattern, path);
      if (!params) continue;
      const session = await sessionId();
      let body: Body = {};
      if (req.method === 'POST') {
        const text = await req.text();
        if (text.length > 4000) throw new ApiError(413, 'BODY_TOO_LARGE', 'Request body too large.');
        if (text) {
          try {
            body = JSON.parse(text) as Body;
          } catch {
            throw new ApiError(400, 'INVALID_JSON', 'Request body must be JSON.');
          }
        }
      }
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
