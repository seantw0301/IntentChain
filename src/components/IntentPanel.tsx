'use client';

import { useState } from 'react';
import type { AppState } from '@/lib/types';
import type { Call } from '@/app/page';

import { EXAMPLE_PROMPT as EXAMPLE } from './GuideBar';

export function IntentPanel({ state, call, busy }: { state: AppState; call: Call; busy: string | null }) {
  const [prompt, setPrompt] = useState(EXAMPLE);
  const intent = state.intent;

  if (!intent) {
    return (
      <section className="panel">
        <h2><span className="step">1</span>Human intent</h2>
        <label htmlFor="prompt">Tell your agents what you need</label>
        <textarea id="prompt" value={prompt} maxLength={600} onChange={(e) => setPrompt(e.target.value)} />
        <div className="row end" style={{ marginTop: 10 }}>
          <button className="btn primary" disabled={busy !== null || prompt.trim().length < 8} onClick={() => call('intent', { prompt })}>
            {busy === 'intent' ? 'Reading intent…' : 'Create intent'}
          </button>
        </div>
      </section>
    );
  }

  return (
    <section className="panel">
      <h2>
        <span className="step">1</span>Human intent
        <span className={`tag ${intent.source}`}>{intent.source === 'jev' ? 'AI extracted' : 'cached extraction'}</span>
      </h2>
      <p className="quote">“{intent.prompt}”</p>
      <dl className="kv">
        <dt>Intent ID</dt>
        <dd><code>{intent.id}</code></dd>
        <dt>Goal</dt>
        <dd>{intent.goal}</dd>
        <dt>Purpose</dt>
        <dd>{intent.purpose_detail}</dd>
        <dt>Budget</dt>
        <dd>${intent.budget} {intent.currency}</dd>
        <dt>Limits</dt>
        <dd className="chips">
          {Object.entries(intent.category_caps).map(([k, v]) => (
            <span className="chip" key={k}>{k} ≤ ${v}</span>
          ))}
        </dd>
        <dt>Dates</dt>
        <dd>{intent.trip_start} → {intent.trip_end} ({intent.nights} nights)</dd>
        <dt>Restrictions</dt>
        <dd className="chips">
          {intent.restrictions.map((r) => (
            <span className="chip no" key={r.label}>{r.label}</span>
          ))}
        </dd>
      </dl>
      {intent.status === 'DRAFT' ? (
        <div className="row end" style={{ marginTop: 12 }}>
          <span className="hint" style={{ marginRight: 'auto' }}>Nothing is delegated until you confirm.</span>
          <button className="btn primary" disabled={busy !== null} onClick={() => call(`intent/${intent.id}/confirm`)}>
            Confirm &amp; delegate
          </button>
        </div>
      ) : (
        <div className="note pass" style={{ marginTop: 12 }}>
          Intent active. Every transaction below must trace back to <code>{intent.id}</code>.
        </div>
      )}
    </section>
  );
}
