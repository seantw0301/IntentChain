'use client';

import type { AppState } from '@/lib/types';
import type { Call } from '@/app/page';

export const EXAMPLE_PROMPT =
  'Sean from the product team is traveling to Tokyo for a client meeting next week. Arrange his hotel and eSIM under the company travel policy. Trip budget: $600.';

export const OFFICE_PROMPT =
  'Order USB-C adapters for the three new hires starting Monday. Budget: $200.';

interface Step {
  title: string;
  notice: string;
  button?: string;
  run?: () => void;
}

const TOTAL = 11;

/** Works out where the visitor is in the story and what the next move is. */
function nextStep(state: AppState, call: Call): { n: number; step: Step } {
  const { intent, transactions, delegations, events, policy } = state;
  const tx = (item: string) => transactions.find((t) => t.item.id === item);
  const awaitingManager = (item: string) => ['APPROVED', 'ORDER_CREATED'].includes(tx(item)?.status ?? '');
  const happened = (type: string) => events.some((e) => e.type === type);
  const evaluate = (step: string) => () => void call('transaction/evaluate', { step });

  if (!intent) {
    return {
      n: 1,
      step: {
        title: `The owner has set the rules. Now an employee needs a trip.`,
        notice: `${policy.company} lets agents pay up to $${policy.auto_pay_limit} on their own and blocks entertainment. Submit a request — your own, or the example.`,
        button: 'Use the example request',
        run: () => void call('intent', { prompt: EXAMPLE_PROMPT }),
      },
    };
  }
  if (intent.kind === 'procurement') {
    // the short second story: the same policy and firewall, a different kind of request
    if (intent.status === 'DRAFT') {
      return {
        n: 1,
        step: {
          title: 'Not just travel: an office purchase',
          notice: 'Same company policy, same firewall. The roles are now Procurement, Sourcing and Purchasing.',
          button: 'Confirm & delegate',
          run: () => void call(`intent/${intent.id}/confirm`),
        },
      };
    }
    if (!tx('usb-adapter')) {
      return {
        n: 2,
        step: {
          title: 'Adapters for the new hires',
          notice: `$49, an allowed category, and exactly what was asked for — auto-paid under the $${policy.auto_pay_limit} limit.`,
          button: 'Order the adapters',
          run: evaluate('usb-adapter'),
        },
      };
    }
    if (!tx('gaming-gpu')) {
      return {
        n: 3,
        step: {
          title: 'And something nobody asked for',
          notice: 'The Purchasing Agent tries a $799 gaming graphics card.',
          button: 'Try the graphics card',
          run: evaluate('gaming-gpu'),
        },
      };
    }
    return {
      n: 3,
      step: {
        title: 'Same rules, a different job.',
        notice: 'Reset the demo to run the travel story again, or keep exploring.',
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
        title: 'Small and legitimate: auto-pay',
        notice: `The Travel Agent buys an $18 eSIM. Five checks pass and it is under the $${policy.auto_pay_limit} limit, so it is paid through PayPal with nobody in the loop.`,
        button: 'Buy the eSIM',
        run: evaluate('esim'),
      },
    };
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
  if (!tx('theme-park')) {
    return {
      n: 6,
      step: {
        title: 'What any expense policy would catch',
        notice: 'A theme park ticket. The company blocks entertainment, so policy stops it. Simple — and not the interesting case.',
        button: 'Buy the theme park ticket',
        run: evaluate('theme-park'),
      },
    };
  }
  if (!delegations.some((d) => d.agent === 'experience')) {
    return {
      n: 7,
      step: {
        title: 'A hand-off that drifts',
        notice: 'The Travel Agent delegates “improve the overall travel experience”. It is a valid subset, so no rule rejects it. Watch its intent fidelity.',
        button: 'Delegate the task',
        run: () => void call('delegate', { simulate: 'experience' }),
      },
    };
  }
  // done once the Experience Agent has tried to buy something, scripted or on its own
  if (!tx('dinner-cruise') && !transactions.some((t) => t.agent === 'experience')) {
    const live = state.config.agent_model;
    return {
      n: 8,
      step: {
        title: 'Every policy check passes — and it is still wrong',
        notice: live
          ? 'A real LLM now acts as that agent. It knows the company policy, so it looks for something the policy allows. Watch what it picks — and what the firewall does.'
          : 'That agent books a $95 dinner cruise as a business meal. Allowed category, in budget, within authority. See what catches it, and where it traces the problem to.',
        button: live ? 'Let the agent work' : 'Book the dinner cruise',
        run: live
          ? () => void call('agent/run', { agent: 'experience', instruction: 'Make Sean’s free evening in Tokyo memorable. Find one option and book it.' })
          : evaluate('dinner-cruise'),
      },
    };
  }
  if (!tx('hotel-b')) {
    return {
      n: 9,
      step: {
        title: 'Bigger and legitimate: manager approval',
        notice: `The hotel is $486 — over the $${policy.auto_pay_limit} auto-pay limit. It passes every check, with reasons on record, and waits for a manager.`,
        button: 'Compare hotels and book',
        run: evaluate('hotel'),
      },
    };
  }
  if (awaitingManager('hotel-b')) {
    return { n: 9, step: { title: 'The manager approves', notice: 'Press “Approve & pay with PayPal” in the firewall panel and approve in the PayPal sandbox.' } };
  }
  const hotel = tx('hotel-b');
  if (hotel?.status === 'CAPTURED') {
    return {
      n: 10,
      step: {
        title: 'The payment succeeds. The goal does not.',
        notice: 'The hotel cancels. IntentChain marks the outcome failed, refunds through PayPal and proposes a replacement that needs approval.',
        button: 'Hotel cancels the booking',
        run: () => void call('outcome/event', { transaction_id: hotel.id, type: 'booking_cancelled' }),
      },
    };
  }
  if (transactions.some((t) => t.payment?.order_id) && !happened('audit.reconciled')) {
    return {
      n: 11,
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
      title: 'That is the travel story. It is not just travel.',
      notice: 'Run a short office purchase under the same policy — or change the policy, delegate your own task, and try to break it.',
      button: 'Next: an office purchase',
      // one request at a time: clear this one, then submit the office request
      run: () => void call('demo/reset').then((ok) => ok && call('intent', { prompt: OFFICE_PROMPT })),
    },
  };
}

export function GuideBar({ state, call, busy }: { state: AppState; call: Call; busy: string | null }) {
  const { n, step } = nextStep(state, call);
  const total = state.intent?.kind === 'procurement' ? 3 : TOTAL;
  return (
    <section className="guide" aria-label="Guided walkthrough">
      <div className="guide-progress" aria-hidden>
        <span>Step {n} of {total}</span>
        <span className="bar"><i style={{ width: `${(n / total) * 100}%` }} /></span>
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
