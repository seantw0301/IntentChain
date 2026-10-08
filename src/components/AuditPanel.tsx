'use client';

import dynamic from 'next/dynamic';
import type { AppState } from '@/lib/types';
import type { Call } from '@/app/page';

// AG Grid touches the DOM on import, so it is loaded in the browser only
const LedgerGrid = dynamic(() => import('./LedgerGrid'), { ssr: false });

interface Row {
  transaction_id: string;
  item: string;
  amount: number;
  local: string;
  paypal: string;
  match: boolean | null;
}

export function AuditPanel({
  state,
  focus,
  onFocus,
  call,
  busy,
}: {
  state: AppState;
  focus: string | null;
  onFocus: (id: string) => void;
  call: Call;
  busy: string | null;
}) {
  const { intent, metrics: m, transactions } = state;
  const reconciled = [...state.events].reverse().find((e) => e.type === 'audit.reconciled');
  const rows = (reconciled?.data.rows as Row[] | undefined) ?? [];
  const reachedPayPal = transactions.some((t) => t.payment?.order_id);

  return (
    <section className="panel">
      <h2><span className="step">6</span>Company activity{intent ? ` — ${intent.goal}` : ''}</h2>
      {!intent || !m ? (
        <p className="empty">No intent, no transactions, no audit.</p>
      ) : (
        <>
          <div className="metrics">
            <div className="metric">
              <div className="k">Spent of ${m.budget}</div>
              <div className="v">${m.spent}</div>
              <div className="bar"><i style={{ width: `${Math.min(100, (m.spent / m.budget) * 100)}%` }} /></div>
            </div>
            <div className="metric" title="Amount-weighted alignment score of every payment that was captured">
              <div className="k">Intent integrity</div>
              <div className="v">{m.intent_integrity === null ? '—' : `${m.intent_integrity}%`}</div>
            </div>
            <div className="metric" title="Share of captured payments that were inside the paying agent's authority">
              <div className="k">Authority integrity</div>
              <div className="v">{m.authority_integrity === null ? '—' : `${m.authority_integrity}%`}</div>
            </div>
            <div className="metric">
              <div className="k">Outcome status</div>
              <div className="v small" style={{ color: m.outcome_status === 'Recovery Active' ? 'var(--warn)' : undefined }}>
                {m.outcome_status}
              </div>
            </div>
          </div>
          {transactions.length === 0 ? (
            <p className="empty">No transactions yet.</p>
          ) : (
            <LedgerGrid state={state} focus={focus} onFocus={onFocus} />
          )}

          {reachedPayPal && (
            <div className="reconcile">
              <div className="row">
                <span className="hint" style={{ marginRight: 'auto' }}>
                  Read every order back from PayPal and compare it with this ledger.
                </span>
                <button className="btn small" disabled={busy !== null} onClick={() => call('audit/reconcile')}>
                  {busy === 'audit/reconcile' ? 'Reading PayPal…' : 'Reconcile with PayPal'}
                </button>
              </div>
              {reconciled && (
                <table>
                  <thead>
                    <tr><th>Transaction</th><th>IntentChain</th><th>PayPal</th><th></th></tr>
                  </thead>
                  <tbody>
                    {rows.map((r) => (
                      <tr key={r.transaction_id}>
                        <td>{r.item} · ${r.amount}</td>
                        <td>{r.local.replace(/_/g, ' ').toLowerCase()}</td>
                        <td>{r.paypal}</td>
                        <td className={r.match === false ? 'no' : r.match ? 'ok' : ''}>
                          {r.match === null ? '—' : r.match ? '✓ match' : '✕ mismatch'}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          )}
        </>
      )}
    </section>
  );
}
