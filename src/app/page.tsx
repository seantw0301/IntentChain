'use client';

import { useCallback, useEffect, useState } from 'react';
import type { AppState } from '@/lib/types';
import { ActivityPanel } from '@/components/ActivityPanel';
import { AuditPanel } from '@/components/AuditPanel';
import { ChainPanel } from '@/components/ChainPanel';
import { GuideBar } from '@/components/GuideBar';
import { IntentPanel } from '@/components/IntentPanel';
import { PolicyPanel } from '@/components/PolicyPanel';
import { ValidationCard } from '@/components/ValidationCard';

const BASE = '/intentchain';

export type Call = (path: string, body?: Record<string, unknown>, method?: 'POST' | 'PUT') => Promise<boolean>;

export default function Home() {
  const [state, setState] = useState<AppState | null>(null);
  const [focus, setFocus] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [toast, setToast] = useState<{ text: string; ok: boolean } | null>(null);

  const notify = useCallback((text: string, ok = false) => {
    setToast({ text, ok });
    window.setTimeout(() => setToast(null), 6000);
  }, []);

  const refresh = useCallback(async () => {
    const res = await fetch(`${BASE}/api/audit`, { cache: 'no-store' });
    setState((await res.json()) as AppState);
  }, []);

  // POSTs to the API; every endpoint answers with the full, fresh state.
  const call = useCallback<Call>(
    async (path, body = {}, method = 'POST') => {
      setBusy(path);
      try {
        const res = await fetch(`${BASE}/api/${path}`, {
          method,
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
        const json = await res.json();
        if (!res.ok) {
          notify(json?.error?.message ?? 'Request failed.');
          await refresh();
          return false;
        }
        setState(json as AppState);
        if (json.focus) setFocus(json.focus as string);
        return true;
      } catch {
        notify('Network error. Please try again.');
        return false;
      } finally {
        setBusy(null);
      }
    },
    [notify, refresh],
  );

  useEffect(() => {
    refresh().catch(() => notify('Could not load the demo state.'));
    // coming back from the PayPal approval page
    const q = new URLSearchParams(window.location.search);
    const tx = q.get('tx');
    const paypal = q.get('paypal');
    if (tx) setFocus(tx);
    if (paypal === 'paid') notify('PayPal payment captured.', true);
    if (paypal === 'cancelled') notify('PayPal approval was cancelled. The order is still open.');
    if (paypal === 'failed') notify('PayPal capture did not complete. See the transaction for details.');
    if (tx || paypal) window.history.replaceState(null, '', `${BASE}/`);
  }, [refresh, notify]);

  if (!state) {
    return (
      <main className="shell">
        <p className="empty">Loading IntentChain…</p>
      </main>
    );
  }

  const active = state.intent?.status === 'ACTIVE';
  const focused =
    state.transactions.find((t) => t.id === focus) ?? state.transactions.at(-1) ?? null;

  return (
    <main className="shell">
      <header className="top">
        <div className="brand">
          <div className="logo" aria-hidden>IC</div>
          <div>
            <h1>IntentChain</h1>
            <p>Autonomous travel &amp; procurement for small businesses</p>
          </div>
        </div>
        <div className="badges">
          <span className={`badge ${state.config.paypal_mode === 'sandbox' ? 'live' : 'sim'}`}>
            PayPal: <b>{state.config.paypal_mode === 'sandbox' ? 'Sandbox — no real money' : 'Simulated — no PayPal call'}</b>
          </span>
          <span className={`badge ${state.config.ai_mode === 'live' ? 'live' : 'sim'}`}>
            Intent AI: <b>{state.config.ai_mode === 'live' ? 'Live' : 'Cached reference scores'}</b>
          </span>
          {state.config.agent_model && (
            <span className="badge live">
              Agent LLM: <b>{state.config.agent_model}</b>
            </span>
          )}
        </div>
        <button
          className="btn danger small"
          disabled={busy !== null}
          onClick={async () => {
            if (await call('demo/reset')) {
              setFocus(null);
              notify('Demo reset. Your session is empty again.', true);
            }
          }}
        >
          Reset demo
        </button>
      </header>

      <section className="hero" aria-label="What IntentChain is">
        <div className="hero-main">
          <h2>Let AI spend. Keep your business in control.</h2>
          <p>
            A ten-person company has no travel desk and no procurement team. IntentChain lets AI agents book and buy through
            PayPal — inside limits the owner sets, and checked at <em>every hand-off between agents</em>.
          </p>
        </div>
        <div className="versus">
          <div className="vs them">
            <span className="vs-label">Expense policies ask</span>
            <span className="vs-q">“Is this purchase allowed?”</span>
            <span className="vs-flow">Policy → Pay</span>
          </div>
          <div className="vs us">
            <span className="vs-label">IntentChain also asks</span>
            <span className="vs-q">“After three hand-offs between agents, is it still what the employee was sent to do?”</span>
            <span className="vs-flow">Trust the chain, not just the agent.</span>
          </div>
        </div>
      </section>

      <GuideBar state={state} call={call} busy={busy} />

      {/* panels appear as the story reaches them, so the first screen stays simple */}
      <div className="grid two">
        <PolicyPanel state={state} call={call} busy={busy} />
        <IntentPanel state={state} call={call} busy={busy} />
      </div>

      {state.delegations.length > 0 && (
        <div className="grid">
          <ChainPanel state={state} call={call} busy={busy} />
        </div>
      )}

      {active && (
        <div className="grid mid">
          <ActivityPanel state={state} call={call} busy={busy} active={active} />
          <ValidationCard state={state} tx={focused} call={call} busy={busy} />
        </div>
      )}

      {state.events.length > 0 && (
        <div className="grid">
          <AuditPanel state={state} focus={focused?.id ?? null} onFocus={setFocus} call={call} busy={busy} />
          <section className="panel">
            <h2>Audit timeline</h2>
            <ol className="timeline">
              {[...state.events].reverse().map((e) => (
                <li key={e.seq}>
                  <time>{new Date(e.at).toLocaleTimeString('en-GB')}</time>
                  <span>
                    <span className={`dot ${tone(e.type)}`} />
                    {describe(e.type, e.data)}
                    <span className="who"> · {e.actor}</span>
                  </span>
                </li>
              ))}
            </ol>
          </section>
        </div>
      )}

      <p className="foot">
        IntentChain is a hackathon demo.{' '}
        {state.config.paypal_mode === 'sandbox'
          ? 'Payments run in the PayPal sandbox through the PayPal Agent Toolkit — no real money moves.'
          : 'PayPal credentials are not configured on this server, so payments are simulated.'}{' '}
        Hotels and products are fixed demo data. Each browser session has its own isolated state.
      </p>

      {toast && <div className={`toast ${toast.ok ? 'ok' : ''}`} role="status">{toast.text}</div>}
    </main>
  );
}

function tone(type: string): string {
  if (type.endsWith('.blocked') || type.endsWith('failed') || type.endsWith('.rejected') || type.endsWith('.forged')) return 'block';
  if (type.endsWith('.warning') || type.endsWith('.drift')) return 'warn';
  if (type.endsWith('.approved') || type.endsWith('.captured') || type.endsWith('.refunded')) return 'pass';
  return 'info';
}

function describe(type: string, d: Record<string, unknown>): string {
  const item = d.item ? `${d.item}` : '';
  const amount = d.amount !== undefined ? ` $${d.amount}` : '';
  switch (type) {
    case 'policy.updated': return `Company policy updated — auto-pay up to $${d.auto_pay_limit}`;
    case 'intent.created': return `Request received — ${d.goal}, $${d.budget}`;
    case 'intent.confirmed': return 'Request confirmed';
    case 'delegation.created': return `Delegated to ${d.agent} agent — up to $${d.budget}`;
    case 'delegation.rejected': {
      const added = (d.new_capabilities as string[] | undefined) ?? [];
      return added.length
        ? `Delegation rejected — new capability: ${added.join(', ')}`
        : `Delegation rejected — requested $${d.requested_budget}, parent holds $${d.parent_budget}`;
    }
    case 'delegation.drift': return `Intent drift detected — ${d.agent} agent's task scores ${d.fidelity}% fidelity`;
    case 'delegation.forged': return `Forged grant rejected — claimed $${d.claimed_budget}, signed $${d.signed_budget}`;
    case 'decision.recorded': return `Decision recorded — selected ${d.selected}`;
    case 'transaction.proposed': return `Proposed ${item}${amount}`;
    case 'transaction.approved':
      return `${item}${amount} passed the firewall — ${d.payment_route === 'AUTO_PAY' ? 'auto-pay' : d.payment_route === 'MANAGER_APPROVAL' ? 'manager approval required' : 'approved'}`;
    case 'transaction.warning': return `${item}${amount} needs human review`;
    case 'transaction.blocked': return `${item}${amount} blocked — ${String(d.reason ?? '').replace(/_/g, ' ').toLowerCase()}`;
    case 'payment.order_created': return `PayPal order created for ${item}${d.mode === 'mock' ? ' (simulated)' : ''}`;
    case 'payment.captured': return `PayPal ${d.auto ? 'auto-paid' : 'captured'}${amount} for ${item}${d.mode === 'mock' ? ' (simulated)' : ''}`;
    case 'payment.failed': return `Payment failed for ${item}`;
    case 'outcome.failed': return `Outcome failed — ${item} was cancelled`;
    case 'payment.refunded': return `Refunded${amount} for ${item}${d.mode === 'mock' ? ' (simulated)' : ''}`;
    case 'payment.refund_failed': return `Refund failed for ${item}`;
    case 'agent.run': return `${d.agent} planned with ${d.model}: “${String(d.instruction).slice(0, 70)}”`;
    case 'audit.reconciled': return `Reconciled with PayPal — ${d.checked} checked, ${d.mismatches} mismatch${d.mismatches === 1 ? '' : 'es'}`;
    case 'paypal.webhook': return `PayPal webhook ${String(d.event_type ?? '').toLowerCase()} for ${item}`;
    case 'recovery.proposed': return `Recovery proposed — ${d.replacement} $${d.amount}`;
    default: return type;
  }
}
