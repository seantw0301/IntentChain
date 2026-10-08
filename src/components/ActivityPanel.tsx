'use client';

import { useState } from 'react';
import type { AppState } from '@/lib/types';
import type { Call } from '@/app/page';

type Step = { key: string; item?: string; title: string; who: string; price?: number; delegate?: string };

const STEPS: Step[] = [
  { key: 'esim', item: 'esim', title: 'Japan eSIM', who: 'Travel Agent', price: 18 },
  { key: 'luxury-hotel', item: 'luxury-hotel', title: 'Luxury hotel', who: 'Booking Agent goes over its limit', price: 780 },
  { key: 'experience', delegate: 'experience', title: 'Delegate “improve the travel experience”', who: 'Travel Agent → Experience Agent' },
  { key: 'theme-park', item: 'theme-park', title: 'Theme park ticket', who: 'Experience Agent', price: 120 },
  { key: 'hotel', item: 'hotel-b', title: 'Compare hotels and book', who: 'Hotel Agent → Booking Agent', price: 486 },
  { key: 'airport-transfer', item: 'airport-transfer', title: 'Airport transfer', who: 'Travel Agent', price: 110 },
];

const CATEGORIES = ['lodging', 'connectivity', 'transport', 'entertainment', 'subscription', 'other'];

export function ActivityPanel({
  state,
  call,
  busy,
  active,
}: {
  state: AppState;
  call: Call;
  busy: string | null;
  active: boolean;
}) {
  const [name, setName] = useState('Noise-cancelling headphones');
  const [amount, setAmount] = useState('60');
  const [category, setCategory] = useState('other');

  const bought = new Set(state.transactions.map((t) => t.item.id));
  const delegated = new Set(state.delegations.map((d) => d.agent as string));
  const isDone = (s: Step) => (s.item ? bought.has(s.item) : delegated.has(s.delegate as string));
  const next = STEPS.find((s) => !isDone(s))?.key;
  // an approved transaction should be paid before the story moves on
  const unpaid = state.transactions.some((t) => t.status === 'APPROVED' || t.status === 'ORDER_CREATED');
  const hotel = state.transactions.find((t) => t.item.id === 'hotel-b' && t.status === 'CAPTURED');

  return (
    <section className="panel">
      <h2><span className="step">3</span>Agent activity</h2>
      {!active ? (
        <p className="empty">Agents start working once the intent is confirmed.</p>
      ) : (
        <>
          <div className="steps">
            {STEPS.map((s, i) => (
              <button
                key={s.key}
                className={`stepbtn ${s.key === next && !unpaid ? 'next' : ''}`}
                disabled={busy !== null}
                onClick={() =>
                  s.delegate ? call('delegate', { simulate: s.delegate }) : call('transaction/evaluate', { step: s.key })
                }
              >
                <span className="n">{isDone(s) ? '✓' : i + 1}</span>
                <span className="t">
                  {s.title}
                  <span className="s">{s.who}</span>
                </span>
                <span className="p">{s.price !== undefined ? `$${s.price}` : '↳'}</span>
              </button>
            ))}
            <button
              className={`stepbtn ${hotel ? 'next' : ''}`}
              disabled={busy !== null || !hotel}
              onClick={() => hotel && call('outcome/event', { transaction_id: hotel.id, type: 'booking_cancelled' })}
              title={hotel ? '' : 'Available after the hotel payment is captured'}
            >
              <span className="n">7</span>
              <span className="t">
                Hotel cancels the booking
                <span className="s">Outcome event after payment</span>
              </span>
              <span className="p">!</span>
            </button>
          </div>
          {unpaid && <p className="hint" style={{ marginTop: 10 }}>An approved purchase is waiting for payment on the right.</p>}

          <details className="custom">
            <summary>Try your own purchase</summary>
            <div className="form">
              <div className="wide">
                <label htmlFor="c-name">What should the Travel Agent buy?</label>
                <input id="c-name" type="text" value={name} maxLength={80} onChange={(e) => setName(e.target.value)} />
              </div>
              <div>
                <label htmlFor="c-cat">Category</label>
                <select id="c-cat" value={category} onChange={(e) => setCategory(e.target.value)}>
                  {CATEGORIES.map((c) => <option key={c}>{c}</option>)}
                </select>
              </div>
              <div>
                <label htmlFor="c-amt">USD</label>
                <input id="c-amt" type="number" min="1" value={amount} onChange={(e) => setAmount(e.target.value)} />
              </div>
              <div className="wide row end">
                <button
                  className="btn small"
                  disabled={busy !== null || !name.trim() || !(Number(amount) > 0)}
                  onClick={() => call('transaction/evaluate', { name, amount: Number(amount), category })}
                >
                  Propose
                </button>
              </div>
            </div>
          </details>
        </>
      )}
    </section>
  );
}
