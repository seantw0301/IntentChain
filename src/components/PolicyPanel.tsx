'use client';

import { useEffect, useState } from 'react';
import type { AppState, Category } from '@/lib/types';
import type { Call } from '@/app/page';

const LABELS: Record<string, string> = {
  lodging: 'Hotels',
  connectivity: 'eSIM & data',
  transport: 'Ground transport',
  meals: 'Business meals',
  office: 'Office supplies',
  entertainment: 'Entertainment',
  subscription: 'Subscriptions',
  gaming: 'Gaming gear',
};

/** The owner's side: what agents may buy, how much, and when a manager must approve. */
export function PolicyPanel({ state, call, busy }: { state: AppState; call: Call; busy: string | null }) {
  const { policy, autopay } = state;
  const [limit, setLimit] = useState(String(policy.auto_pay_limit));
  useEffect(() => setLimit(String(policy.auto_pay_limit)), [policy.auto_pay_limit]);

  const toggle = (category: Category) => call('company/policy', { toggle: category }, 'PUT');
  const chip = (category: Category, allowed: boolean) => (
    <button
      key={category}
      className={`chip toggle ${allowed ? 'yes' : 'no'}`}
      disabled={busy !== null}
      onClick={() => toggle(category)}
      title={allowed ? 'Allowed — click to block' : 'Blocked — click to allow'}
    >
      {allowed ? '✓' : '✕'} {LABELS[category] ?? category}
    </button>
  );

  return (
    <section className="panel">
      <h2><span className="step">1</span>{policy.company} — AI spending policy</h2>
      <p className="hint" style={{ marginBottom: 12 }}>
        Set by the owner. Agents act on their own inside these limits, and nowhere else.
      </p>
      <dl className="kv">
        <dt>Allowed</dt>
        <dd className="chips">{policy.allowed_categories.map((c) => chip(c, true))}</dd>
        <dt>Blocked</dt>
        <dd className="chips">{policy.blocked_categories.map((c) => chip(c, false))}</dd>
        <dt>Trip budget</dt>
        <dd>up to ${policy.travel_budget} · hotel up to ${policy.hotel_limit}</dd>
        <dt>Auto-pay</dt>
        <dd className="row">
          up to $
          <input
            aria-label="Auto-pay limit in USD"
            className="inline"
            type="number"
            min="0"
            value={limit}
            onChange={(e) => setLimit(e.target.value)}
            onBlur={() => Number(limit) !== policy.auto_pay_limit && call('company/policy', { auto_pay_limit: Number(limit) }, 'PUT')}
          />
          <span className="hint">above this, a manager approves</span>
        </dd>
        <dt>Delegation</dt>
        <dd>Agents may re-delegate · child ⊆ parent, always</dd>
        <dt>PayPal</dt>
        <dd>
          {autopay.mode === 'mock' ? (
            <span className="hint">Auto-pay is simulated (no PayPal credentials on this server)</span>
          ) : autopay.connected ? (
            <>
              Auto-pay connected <span className="tag jev">billing agreement</span>{' '}
              <code title="The owner approved this PayPal billing agreement once">{autopay.agreement_id}</code>
            </>
          ) : (
            <span className="hint">Auto-pay not connected — every payment goes to checkout</span>
          )}
        </dd>
      </dl>
    </section>
  );
}
