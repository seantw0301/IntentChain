'use client';

import { useState } from 'react';
import type { AppState, Check, Transaction } from '@/lib/types';
import type { Call } from '@/app/page';

import { AGENT_NAMES as AGENT } from './ChainPanel';

function RuleCheck({ name, check }: { name: string; check: Check }) {
  return (
    <div className={`check ${check.pass ? 'pass' : 'fail'}`}>
      <div className="name">{name}</div>
      <div className="state">{check.pass ? 'PASS' : 'FAIL'}</div>
      <div className="why">{check.detail}</div>
    </div>
  );
}

export function ValidationCard({
  state,
  tx,
  call,
  busy,
}: {
  state: AppState;
  tx: Transaction | null;
  call: Call;
  busy: string | null;
}) {
  const [why, setWhy] = useState(false);
  const [approving, setApproving] = useState(false);

  if (!tx) {
    return (
      <section className="panel">
        <h2><span className="step">4</span>IntentChain firewall</h2>
        <p className="empty">
          Each purchase an agent proposes is checked against the whole delegation chain here — before any PayPal tool is called.
        </p>
      </section>
    );
  }

  const v = tx.validation;
  const decision = state.decisions.find((d) => d.id === tx.decision_id);
  const recovery = state.recoveries.find((r) => r.failed_transaction_id === tx.id);
  const simulated = tx.payment?.mode === 'mock';
  const intentState = { pass: 'PASS', fail: 'FAIL', warning: 'REVIEW', skipped: '—' }[v.intent.status];

  // lineage: the transaction's grant and every ancestor, root first
  const byId = new Map(state.delegations.map((d) => [d.id, d]));
  const lineage = [];
  for (let d = tx.delegation_id ? byId.get(tx.delegation_id) : undefined; d; d = d.parent === 'human' ? undefined : byId.get(d.parent)) {
    lineage.unshift(d);
  }

  const pay = async () => {
    const ok = await call('paypal/order', { transaction_id: tx.id });
    if (ok) setApproving(true);
  };

  let banner: { tone: string; label: string; msg: string };
  switch (tx.status) {
    case 'BLOCKED':
      banner = { tone: 'block', label: `BLOCKED — ${v.reason_code.replace(/_/g, ' ')}`, msg: v.headline };
      break;
    case 'WARNING':
      banner = { tone: 'warn', label: 'WARNING — HUMAN REVIEW', msg: v.headline };
      break;
    case 'APPROVED':
      banner = { tone: 'pass', label: 'APPROVED', msg: 'Cleared by IntentChain. The agent may now call PayPal.' };
      break;
    case 'ORDER_CREATED':
      banner = { tone: 'pass', label: 'APPROVED — AWAITING BUYER', msg: 'PayPal order created. Approve it as the buyer to capture the payment.' };
      break;
    case 'CAPTURED':
      banner = { tone: 'pass', label: simulated ? 'PAYMENT CAPTURED (SIMULATED)' : 'PAYMENT CAPTURED', msg: 'Paid through PayPal and linked to the human intent.' };
      break;
    case 'OUTCOME_FAILED':
      banner = { tone: 'block', label: 'PAYMENT SUCCESS · OUTCOME FAILED', msg: 'The booking was cancelled after payment. Recovery required.' };
      break;
    case 'REFUNDED':
      banner = { tone: 'warn', label: 'PAYMENT SUCCESS · OUTCOME FAILED · REFUNDED', msg: 'The payment succeeded but the goal was not met. Refunded; recovery is in progress.' };
      break;
    default:
      banner = { tone: 'block', label: tx.status.replace(/_/g, ' '), msg: tx.payment?.error ?? 'PayPal reported an error.' };
  }

  return (
    <section className="panel">
      <h2><span className="step">4</span>IntentChain firewall</h2>
      <div className="verdict">
        <div className="what">
          <h3>{tx.item.name}</h3>
          <p>
            Proposed by {AGENT[tx.agent]} · {tx.item.merchant} · {tx.item.category} · traces to <code>{tx.intent_id}</code>
          </p>
        </div>
        <div className="price">${tx.item.amount}</div>
      </div>

      <div className="checks">
        <RuleCheck name="Budget" check={v.budget} />
        <RuleCheck name="Authority" check={v.authority} />
        <RuleCheck name="Scope" check={v.scope} />
        <div className={`check ${v.intent.status}`}>
          <div className="name">
            Intent {v.intent.source && <span className={`tag ${v.intent.source}`}>{v.intent.source === 'jev' ? 'AI' : 'cached'}</span>}
          </div>
          <div className="state">
            {intentState}
            {v.intent.score !== null && <span style={{ fontSize: 13, fontWeight: 600 }}> · {v.intent.score}/100</span>}
          </div>
          <div className="why">{v.intent.detail}</div>
        </div>
      </div>

      <div className={`banner ${banner.tone}`}>
        <span className="label">{banner.label}</span>
        <span className="msg">{banner.msg}</span>
        <span className="row">
          {decision && <button className="btn small" onClick={() => setWhy(true)}>Why this payment?</button>}
          {tx.status === 'WARNING' && (
            <>
              <button className="btn small" disabled={busy !== null} onClick={() => call(`transaction/${tx.id}/confirm`, { approve: false })}>Reject</button>
              <button className="btn small primary" disabled={busy !== null} onClick={() => call(`transaction/${tx.id}/confirm`, { approve: true })}>Confirm as human</button>
            </>
          )}
          {tx.status === 'APPROVED' && (
            <button className="btn paypal" disabled={busy !== null} onClick={pay}>
              {busy === 'paypal/order' ? 'Creating order…' : 'Pay with PayPal'}
            </button>
          )}
          {tx.status === 'ORDER_CREATED' && (
            <button className="btn paypal" disabled={busy !== null} onClick={() => setApproving(true)}>Approve in PayPal</button>
          )}
          {tx.status === 'CAPTURED' && tx.item.category === 'lodging' && (
            <button className="btn small danger" disabled={busy !== null} onClick={() => call('outcome/event', { transaction_id: tx.id, type: 'booking_cancelled' })}>
              Simulate booking cancelled
            </button>
          )}
          {tx.status === 'REFUND_FAILED' && (
            <button className="btn small" disabled={busy !== null} onClick={() => call('outcome/event', { transaction_id: tx.id, type: 'booking_cancelled' })}>Retry refund</button>
          )}
        </span>
      </div>

      {v.violation && tx.status !== 'APPROVED' && (
        <div className="meta responsibility">
          <span>Violation source <b>{v.violation.source}</b></span>
          <span>Type <b>{v.violation.type}</b></span>
          {v.violation.delegation_id && <span>Grant <code>{v.violation.delegation_id}</code></span>}
        </div>
      )}

      <details className="lineage">
        <summary>
          Intent lineage — {lineage.length} signed hop{lineage.length === 1 ? '' : 's'} back to the human intent
        </summary>
        <ol>
          <li>
            <b>Human intent</b> <code>{tx.intent_id}</code> — “{state.intent?.goal}”
          </li>
          {lineage.map((d) => (
            <li key={d.id} className={d.drift ? 'drifted' : ''}>
              <b>{AGENT[d.from]} → {AGENT[d.agent]}</b> <code>{d.id}</code> — “{d.purpose}”, up to ${d.budget}
              {d.fidelity && <> · fidelity {d.fidelity.score}%{d.drift ? ' ⚠ drift' : ''}</>}
            </li>
          ))}
          {decision && (
            <li>
              <b>Decision</b> <code>{decision.id}</code> — {decision.options.length} options compared, 1 selected
            </li>
          )}
          <li>
            <b>Transaction</b> <code>{tx.id}</code> — {tx.item.name}, ${tx.item.amount} → {tx.status.replace(/_/g, ' ')}
          </li>
        </ol>
      </details>

      {tx.payment?.order_id && (
        <div className="meta">
          <span>PayPal order <code>{tx.payment.order_id}</code></span>
          {tx.payment.capture_id && <span>Capture <code>{tx.payment.capture_id}</code></span>}
          {tx.payment.refund_id && <span>Refund <code>{tx.payment.refund_id}</code></span>}
          <span>{simulated ? 'Simulated — no PayPal call was made' : 'PayPal sandbox via Agent Toolkit'}</span>
        </div>
      )}

      {recovery?.proposal && (
        <div className="note warn">
          <b>RECOVERY REQUIRED.</b> Recovery Agent proposes <b>{recovery.proposal.item.name}</b> at ${recovery.proposal.item.amount}.{' '}
          {recovery.proposal.reason} Validator result: <b>{recovery.proposal.validation.decision}</b>. Waiting for human approval —
          nothing is paid until you grant new authority.
        </div>
      )}

      {why && decision && (
        <div className="scrim" onClick={() => setWhy(false)}>
          <div className="modal" role="dialog" aria-label="Decision provenance" onClick={(e) => e.stopPropagation()}>
            <h3>Why this payment?</h3>
            <p className="sub">Decision provenance recorded by the Hotel Agent before any money moved.</p>
            {decision.options.map((o) => (
              <div key={o.item.id} className={`opt ${o.outcome === 'SELECTED' ? 'sel' : 'rej'}`}>
                <b>{o.item.name} — ${o.item.amount}</b>
                <span className="o">{o.outcome}</span>
                <span className="r">{o.reason}</span>
              </div>
            ))}
            <b>Selected because</b>
            <ul className="because">
              {decision.because.map((b) => <li key={b}>{b}</li>)}
            </ul>
            <div className="row end" style={{ marginTop: 14 }}>
              <button className="btn" onClick={() => setWhy(false)}>Close</button>
            </div>
          </div>
        </div>
      )}

      {approving && tx.status === 'ORDER_CREATED' && (
        <div className="scrim">
          <div className="modal" role="dialog" aria-label="PayPal approval">
            <h3>{simulated ? 'Simulated PayPal approval' : 'Approve in PayPal'}</h3>
            <p className="sub">
              {simulated
                ? 'PayPal credentials are not configured, so no PayPal call is made. This stands in for the buyer approval step.'
                : 'You will be sent to the PayPal sandbox to approve as the buyer, then returned here. Use a sandbox personal account.'}
            </p>
            <dl className="kv">
              <dt>Item</dt><dd>{tx.item.name}</dd>
              <dt>Amount</dt><dd>${tx.item.amount} USD</dd>
              <dt>Order</dt><dd><code>{tx.payment?.order_id}</code></dd>
            </dl>
            <div className="row end" style={{ marginTop: 16 }}>
              <button className="btn" onClick={() => setApproving(false)}>Not now</button>
              {simulated ? (
                <button
                  className="btn paypal"
                  disabled={busy !== null}
                  onClick={async () => {
                    await call('paypal/capture', { transaction_id: tx.id });
                    setApproving(false);
                  }}
                >
                  Approve &amp; capture
                </button>
              ) : (
                <a className="btn paypal" href={tx.payment?.approve_url ?? '#'}>Continue to PayPal</a>
              )}
            </div>
          </div>
        </div>
      )}
    </section>
  );
}
