'use client';

import type { AppState } from '@/lib/types';
import type { Call } from '@/app/page';

export const EXAMPLE_PROMPT =
  'I have a client meeting in Tokyo next week. Find me a hotel and an eSIM. Total budget: $600. This is a business trip.';

interface Step {
  title: string;
  notice: string;
  button?: string;
  run?: () => void;
}

const TOTAL = 10;

/** Works out where the visitor is in the story and what the next move is. */
function nextStep(state: AppState, call: Call): { n: number; step: Step } {
  const { intent, transactions, delegations, events } = state;
  const tx = (item: string) => transactions.find((t) => t.item.id === item);
  const awaitingPayment = (item: string) => ['APPROVED', 'ORDER_CREATED'].includes(tx(item)?.status ?? '');
  const happened = (type: string) => events.some((e) => e.type === type);
  const evaluate = (step: string) => () => void call('transaction/evaluate', { step });

  if (!intent) {
    return {
      n: 1,
      step: {
        title: 'Tell your agents what you need',
        notice: 'One sentence becomes a structured intent that every later step has to trace back to. Write your own below, or use the example.',
        button: 'Use the example request',
        run: () => void call('intent', { prompt: EXAMPLE_PROMPT }),
      },
    };
  }
  if (intent.status === 'DRAFT') {
    return {
      n: 2,
      step: {
        title: 'Confirm it and delegate',
        notice: 'Watch the chain: each agent gets less money, a narrower scope, and fewer PayPal tools than the one before.',
        button: 'Confirm & delegate',
        run: () => void call(`intent/${intent.id}/confirm`),
      },
    };
  }
  if (!tx('esim')) {
    return {
      n: 3,
      step: {
        title: 'A legitimate purchase',
        notice: 'The Travel Agent buys an eSIM. All four checks pass, so the firewall lets it reach PayPal.',
        button: 'Buy the eSIM',
        run: evaluate('esim'),
      },
    };
  }
  if (awaitingPayment('esim')) {
    return { n: 3, step: { title: 'Pay for the eSIM', notice: 'Press “Pay with PayPal” in the firewall panel and approve as the sandbox buyer.' } };
  }
  if (!happened('delegation.rejected')) {
    return {
      n: 4,
      step: {
        title: 'Delegation attack',
        notice: 'A grant is requested with the same $500 but one extra capability. Same amount — still not a subset.',
        button: 'Simulate the attack',
        run: () => void call('delegate', { simulate: 'escalation' }),
      },
    };
  }
  if (!tx('luxury-hotel')) {
    return {
      n: 5,
      step: {
        title: 'An agent goes over its limit',
        notice: 'The Booking Agent tries a $780 suite. The firewall names the agent responsible.',
        button: 'Try the luxury hotel',
        run: evaluate('luxury-hotel'),
      },
    };
  }
  if (!delegations.some((d) => d.agent === 'experience')) {
    return {
      n: 6,
      step: {
        title: 'A hand-off that drifts',
        notice: 'The Travel Agent delegates “improve the overall travel experience”. It is a valid subset, so no rule rejects it. Watch its intent fidelity.',
        button: 'Delegate the task',
        run: () => void call('delegate', { simulate: 'experience' }),
      },
    };
  }
  if (!tx('theme-park')) {
    return {
      n: 7,
      step: {
        title: 'Affordable, in scope, within authority — and wrong',
        notice: 'The Experience Agent buys a theme park ticket. Three checks pass. See where the firewall traces the problem to.',
        button: 'Buy the theme park ticket',
        run: evaluate('theme-park'),
      },
    };
  }
  if (!tx('hotel-b')) {
    return {
      n: 8,
      step: {
        title: 'Book the hotel, with reasons',
        notice: 'The Hotel Agent compares three options and records why two were rejected. Open “Why this payment?”.',
        button: 'Compare hotels and book',
        run: evaluate('hotel'),
      },
    };
  }
  if (awaitingPayment('hotel-b')) {
    return { n: 8, step: { title: 'Pay for the hotel', notice: 'Press “Pay with PayPal” in the firewall panel and approve as the sandbox buyer.' } };
  }
  const hotel = tx('hotel-b');
  if (hotel?.status === 'CAPTURED') {
    return {
      n: 9,
      step: {
        title: 'The payment succeeds. The goal does not.',
        notice: 'The hotel cancels. IntentChain marks the outcome failed, refunds through PayPal and proposes a replacement that needs your approval.',
        button: 'Hotel cancels the booking',
        run: () => void call('outcome/event', { transaction_id: hotel.id, type: 'booking_cancelled' }),
      },
    };
  }
  if (transactions.some((t) => t.payment?.order_id) && !happened('audit.reconciled')) {
    return {
      n: 10,
      step: {
        title: 'Check the books against PayPal',
        notice: 'Every order and refund is read back from PayPal and compared with IntentChain’s own ledger.',
        button: 'Reconcile with PayPal',
        run: () => void call('audit/reconcile'),
      },
    };
  }
  return {
    n: TOTAL,
    step: {
      title: 'That is the story. Now break it yourself.',
      notice: 'Delegate a task in your own words, copy an agent token for your own agent, or propose any purchase.',
    },
  };
}

export function GuideBar({ state, call, busy }: { state: AppState; call: Call; busy: string | null }) {
  const { n, step } = nextStep(state, call);
  return (
    <section className="guide" aria-label="Guided walkthrough">
      <div className="guide-progress" aria-hidden>
        <span>Step {n} of {TOTAL}</span>
        <span className="bar"><i style={{ width: `${(n / TOTAL) * 100}%` }} /></span>
      </div>
      <div className="guide-text">
        <b>{step.title}</b>
        <span>{step.notice}</span>
      </div>
      {step.button && (
        <button className="btn primary" disabled={busy !== null} onClick={step.run}>
          {busy !== null ? 'Working…' : step.button}
        </button>
      )}
    </section>
  );
}
