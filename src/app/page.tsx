'use client';

import { useCallback, useEffect, useState } from 'react';
import type { AppState } from '@/lib/types';
import { ActivityPanel } from '@/components/ActivityPanel';
import { AuditPanel } from '@/components/AuditPanel';
import { ChainPanel } from '@/components/ChainPanel';
import { IntentPanel } from '@/components/IntentPanel';
import { ValidationCard } from '@/components/ValidationCard';

const BASE = '/intentchain';

export type Call = (path: string, body?: Record<string, unknown>) => Promise<boolean>;

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
    async (path, body = {}) => {
      setBusy(path);
      try {
        const res = await fetch(`${BASE}/api/${path}`, {
          method: 'POST',
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
            <p>Every AI payment should prove why it was allowed.</p>
          </div>
        </div>
        <div className="badges">
          <span className={`badge ${state.config.paypal_mode === 'sandbox' ? 'live' : 'sim'}`}>
            PayPal: <b>{state.config.paypal_mode === 'sandbox' ? 'Sandbox — no real money' : 'Simulated — no PayPal call'}</b>
          </span>
          <span className={`badge ${state.config.ai_mode === 'live' ? 'live' : 'sim'}`}>
            Intent AI: <b>{state.config.ai_mode === 'live' ? 'Live' : 'Cached reference scores'}</b>
          </span>
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

      <div className="grid two">
        <IntentPanel state={state} call={call} busy={busy} />
        <ChainPanel state={state} call={call} busy={busy} />
      </div>

      <div className="grid mid">
        <ActivityPanel state={state} call={call} busy={busy} active={active} />
        <ValidationCard state={state} tx={focused} call={call} busy={busy} />
      </div>

      <div className="grid low">
        <AuditPanel state={state} focus={focused?.id ?? null} onFocus={setFocus} />
        <section className="panel">
          <h2>Audit timeline</h2>
          {state.events.length === 0 ? (
            <p className="empty">Every state change will be recorded here.</p>
          ) : (
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
          )}
        </section>
      </div>

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
  if (type.endsWith('.blocked') || type.endsWith('failed') || type.endsWith('.rejected')) return 'block';
  if (type.endsWith('.warning')) return 'warn';
  if (type.endsWith('.approved') || type.endsWith('.captured') || type.endsWith('.refunded')) return 'pass';
  return 'info';
}

function describe(type: string, d: Record<string, unknown>): string {
  const item = d.item ? `${d.item}` : '';
  const amount = d.amount !== undefined ? ` $${d.amount}` : '';
  switch (type) {
    case 'intent.created': return `Intent created — ${d.goal}, $${d.budget}`;
    case 'intent.confirmed': return 'Intent confirmed by the human';
    case 'delegation.created': return `Delegated to ${d.agent} agent — up to $${d.budget}`;
    case 'delegation.rejected': return `Delegation rejected — requested $${d.requested_budget}, parent holds $${d.parent_budget}`;
    case 'decision.recorded': return `Decision recorded — selected ${d.selected}`;
    case 'transaction.proposed': return `Proposed ${item}${amount}`;
    case 'transaction.approved': return `${item}${amount} approved`;
    case 'transaction.warning': return `${item}${amount} needs human review`;
    case 'transaction.blocked': return `${item}${amount} blocked — ${String(d.reason ?? '').replace(/_/g, ' ').toLowerCase()}`;
    case 'payment.order_created': return `PayPal order created for ${item}${d.mode === 'mock' ? ' (simulated)' : ''}`;
    case 'payment.captured': return `PayPal captured${amount} for ${item}${d.mode === 'mock' ? ' (simulated)' : ''}`;
    case 'payment.failed': return `Payment failed for ${item}`;
    case 'outcome.failed': return `Outcome failed — ${item} was cancelled`;
    case 'payment.refunded': return `Refunded${amount} for ${item}${d.mode === 'mock' ? ' (simulated)' : ''}`;
    case 'payment.refund_failed': return `Refund failed for ${item}`;
    case 'recovery.proposed': return `Recovery proposed — ${d.replacement} $${d.amount}`;
    default: return type;
  }
}
