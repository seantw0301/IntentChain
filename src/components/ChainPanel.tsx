'use client';

import { useState } from 'react';
import type { AppState, Delegation } from '@/lib/types';
import type { Call } from '@/app/page';

export const AGENT_NAMES: Record<string, string> = {
  human: 'You',
  travel: 'Travel Agent',
  hotel: 'Hotel Agent',
  booking: 'Booking Agent',
  experience: 'Experience Agent',
  recovery: 'Recovery Agent',
};

function expiry(d: Delegation): string {
  const ms = new Date(d.expires_at).getTime() - Date.now();
  if (ms <= 0) return 'expired';
  if (ms < 3600 * 1000) return `in ${Math.max(1, Math.round(ms / 60000))} min`;
  return d.expires_at.slice(0, 10);
}

function Fidelity({ d }: { d: Delegation }) {
  if (!d.fidelity) return null;
  const tone = d.drift ? 'drift' : 'ok';
  return (
    <div className={`fidelity ${tone}`} title="How faithfully this grant's purpose stays within your original intent">
      <span>
        Intent fidelity <b>{d.fidelity.score}%</b>
        <span className={`tag ${d.fidelity.source}`}>{d.fidelity.source === 'jev' ? 'AI' : 'cached'}</span>
      </span>
      <span className="bar"><i style={{ width: `${d.fidelity.score}%` }} /></span>
    </div>
  );
}

function Node({ d, token }: { d: Delegation; token?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className={`node ${d.status !== 'ACTIVE' ? 'used' : ''} ${d.drift ? 'drifted' : ''}`}>
      <h3>{AGENT_NAMES[d.agent]}</h3>
      <div className="amount">
        ${d.per_night ?? d.budget}
        {d.per_night !== undefined && <small> /night</small>}
      </div>
      <Fidelity d={d} />
      <ul>
        <li><b>Task</b> “{d.purpose}”</li>
        {d.per_night !== undefined && <li><b>Total</b> max ${d.budget}</li>}
        <li><b>Scope</b> {d.scope.location}{d.scope.categories ? `, ${d.scope.categories.join(', ')} only` : ''}</li>
        <li><b>Expiry</b> {expiry(d)}{d.single_use ? ' · single use' : ''}</li>
        <li>
          <b>PayPal tools</b> {d.paypal_tools.length === 0 && 'none'}
          <span className="tools">{d.paypal_tools.map((t) => <code key={t}>{t}</code>)}</span>
        </li>
        {d.signature && <li title={d.signature}><b>Signed</b> <code>{d.signature.slice(0, 10)}…</code></li>}
        {d.status !== 'ACTIVE' && <li><b>Status</b> {d.status}</li>}
      </ul>
      {token && (
        <button
          className="btn small ghost token"
          title="Copy this grant as a token your own agent can use on the gateway"
          onClick={async () => {
            await navigator.clipboard?.writeText(token).catch(() => undefined);
            setCopied(true);
            window.setTimeout(() => setCopied(false), 1500);
          }}
        >
          {copied ? 'Copied' : 'Copy agent token'}
        </button>
      )}
    </div>
  );
}

export function ChainPanel({ state, call, busy }: { state: AppState; call: Call; busy: string | null }) {
  const { intent, delegations } = state;
  const main = delegations.filter((d) => d.agent !== 'experience');
  const branches = delegations.filter((d) => d.agent === 'experience');
  // the most recent delegation attack, if any
  const attack = [...state.events].reverse().find((e) => e.type === 'delegation.rejected' || e.type === 'delegation.forged');
  const active = intent?.status === 'ACTIVE';
  const origin = typeof window === 'undefined' ? '' : window.location.origin;

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
                <li><b>Goal</b> “{intent.goal}”</li>
                <li><b>Purpose</b> {intent.purpose_detail}</li>
                <li><b>Scope</b> {intent.location}</li>
                <li><b>Expiry</b> {intent.trip_end}</li>
              </ul>
            </div>
            {main.map((d) => <Node key={d.id} d={d} token={state.grant_tokens?.[d.id]} />)}
          </div>

          {branches.map((d) => (
            <div className="branch" key={d.id}>
              <div className="branch-from">
                {AGENT_NAMES[d.from]} also delegated →
                {d.drift && <span className="drift-flag">⚠ INTENT DRIFT DETECTED</span>}
              </div>
              <Node d={d} token={state.grant_tokens?.[d.id]} />
              {d.drift && (
                <p className="hint">
                  This grant is a valid subset of its parent — smaller budget, same place and dates — so no rule rejects it.
                  Only its purpose has moved away from “{intent.goal}”. Anything it tries to buy is traced back to this hop.
                </p>
              )}
            </div>
          ))}

          <div className="row" style={{ marginTop: 12 }}>
            <span className="hint" style={{ marginRight: 'auto' }}>
              Every grant is signed over its parent&apos;s signature and must be a subset of it.
            </span>
            <button
              className="btn small ghost"
              disabled={busy !== null || !active}
              onClick={() => call('delegate', { simulate: 'escalation' })}
              title="A Booking grant is requested with one extra capability. The amount is unchanged."
            >
              Simulate delegation attack
            </button>
            <button
              className="btn small ghost"
              disabled={busy !== null || !active}
              onClick={() => call('delegate', { simulate: 'forgery' })}
              title="An agent presents a grant whose limit was raised after it was signed"
            >
              Simulate forged grant
            </button>
          </div>

          <details className="byo">
            <summary>Bring your own agent — call PayPal through the firewall with a grant token</summary>
            <p className="hint">
              Any agent, in any language, can act under one of these grants. It sees only the PayPal tools the grant carries,
              and every call passes the same four checks. Copy a token above, then:
            </p>
            <pre>{`# which tools does this grant carry?
curl -H "Authorization: Bearer $TOKEN" ${origin}/intentchain/api/agent/tools

# try to buy something — the firewall decides
curl -X POST -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \\
  -d '{"item_name":"Theme park ticket","amount_usd":120,"category":"entertainment"}' \\
  ${origin}/intentchain/api/agent/tools/create_order`}</pre>
            <p className="hint">
              A complete LLM agent that does this is in <code>examples/claude-agent.mjs</code> in the repository.
            </p>
          </details>

          {attack?.type === 'delegation.rejected' && (
            <div className="note block">
              <b>DELEGATION REJECTED.</b>{' '}
              {(attack.data.new_capabilities as string[] | undefined)?.length ? (
                <>
                  New capability detected: <b>{(attack.data.new_capabilities as string[]).join(', ')}</b>. The requested amount
                  (${String(attack.data.requested_budget)}) was within the parent limit — the child scope is simply not a subset of
                  the {AGENT_NAMES[String(attack.data.parent_agent)]}&apos;s authority.
                </>
              ) : (
                (attack.data.violations as string[]).join(' ')
              )}
            </div>
          )}
          {attack?.type === 'delegation.forged' && (
            <div className="note block">
              <b>FORGED GRANT REJECTED.</b> The {AGENT_NAMES[String(attack.data.agent)]} claimed a limit of $
              {String(attack.data.claimed_budget)}; the signed grant says ${String(attack.data.signed_budget)}.{' '}
              {String(attack.data.reason)}
            </div>
          )}
        </>
      )}
    </section>
  );
}
