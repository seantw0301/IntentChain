'use client';

import { Fragment } from 'react';
import type { AppState, Delegation } from '@/lib/types';
import type { Call } from '@/app/page';

const NAMES: Record<string, string> = {
  travel: 'Travel Agent',
  hotel: 'Hotel Agent',
  booking: 'Booking Agent',
  recovery: 'Recovery Agent',
};

function expiry(d: Delegation): string {
  const ms = new Date(d.expires_at).getTime() - Date.now();
  if (ms <= 0) return 'expired';
  if (ms < 3600 * 1000) return `in ${Math.max(1, Math.round(ms / 60000))} min`;
  return d.expires_at.slice(0, 10);
}

export function ChainPanel({ state, call, busy }: { state: AppState; call: Call; busy: string | null }) {
  const { intent, delegations } = state;
  const rejected = [...state.events].reverse().find((e) => e.type === 'delegation.rejected');

  return (
    <section className="panel">
      <h2><span className="step">2</span>Delegation chain — authority can only shrink</h2>
      {!intent || delegations.length === 0 ? (
        <p className="empty">Confirm the intent to delegate authority to the agents.</p>
      ) : (
        <>
          <div className="chain">
            <div className="node">
              <h3>You</h3>
              <div className="amount">${intent.budget}</div>
              <ul>
                <li><b>Purpose</b> {intent.purpose_detail}</li>
                <li><b>Scope</b> {intent.location}</li>
                <li><b>Expiry</b> {intent.trip_end}</li>
              </ul>
            </div>
            {delegations.map((d) => (
              <Fragment key={d.id}>
                <div className={`node ${d.status !== 'ACTIVE' ? 'used' : ''}`}>
                  <h3>{NAMES[d.agent]}</h3>
                  <div className="amount">
                    ${d.per_night ?? d.budget}
                    {d.per_night !== undefined && <small> /night</small>}
                  </div>
                  <ul>
                    <li><b>Purpose</b> {d.purpose}</li>
                    {d.per_night !== undefined && <li><b>Total</b> max ${d.budget}</li>}
                    <li><b>Scope</b> {d.scope.location}{d.scope.categories ? `, ${d.scope.categories.join(', ')}` : ''}</li>
                    <li><b>Expiry</b> {expiry(d)}{d.single_use ? ' · single use' : ''}</li>
                    <li>
                      <b>PayPal tools</b> {d.paypal_tools.length === 0 && 'none'}
                      <span className="tools">{d.paypal_tools.map((t) => <code key={t}>{t}</code>)}</span>
                    </li>
                    {d.status !== 'ACTIVE' && <li><b>Status</b> {d.status}</li>}
                  </ul>
                </div>
              </Fragment>
            ))}
          </div>
          <div className="row" style={{ marginTop: 12 }}>
            <span className="hint" style={{ marginRight: 'auto' }}>
              Each grant must be a subset of its parent: amount, scope, expiry and PayPal tools.
            </span>
            <button
              className="btn small ghost"
              disabled={busy !== null || intent.status !== 'ACTIVE'}
              onClick={() => call('delegate', { simulate: 'escalation' })}
              title="The Booking Agent tries to hand out more authority than it holds"
            >
              Simulate escalation attempt
            </button>
          </div>
          {rejected && (
            <div className="note block">
              <b>DELEGATION REJECTED.</b> The Booking Agent tried to grant ${String(rejected.data.requested_budget)} while holding
              ${String(rejected.data.parent_budget)}. {(rejected.data.violations as string[]).join(' ')}
            </div>
          )}
        </>
      )}
    </section>
  );
}
