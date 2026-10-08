# IntentChain

**Verifiable Human Intent for Agentic Commerce** — a trust layer between AI agents and PayPal.

> Budget tells an AI how much it can spend. IntentChain tells it *why* it is allowed to spend.

Live demo: **https://demo.jxdtw.com/intentchain**

Built for the PayPal AI Hackathon.

## The problem

AI agents are starting to spend money for us. Today's guardrails are spending limits: if the
purchase fits the budget, it goes through. But a budget does not know what the money was *for*.

Ask an agent to arrange a $600 business trip, and a $120 theme park ticket fits the budget just
as well as the hotel does. When one agent delegates to another, the problem compounds: nothing
stops authority from quietly growing on its way down the chain.

## What IntentChain does

IntentChain sits between the agents and PayPal. An agent cannot reach a PayPal tool until its
proposed transaction passes four independent checks:

| Check | Question | Decided by |
|---|---|---|
| **Budget** | Is there money left? | Rule |
| **Authority** | May *this* agent spend this much? | Rule |
| **Scope** | Right place, right dates? | Rule |
| **Intent** | Does this purchase serve the human's original goal? | Stated restrictions + AI |

The AI can block a payment or send it to a human for review. It can never approve one by itself.

Four ideas make this work:

- **Intent lineage** — the human's request becomes a structured intent with an id. Every
  delegation, decision, transaction and audit event carries that id, and it is written into the
  PayPal order itself.
- **Monotonic delegation** — each grant must be a subset of its parent in amount, scope, lifetime
  and PayPal permissions. The Hotel Agent holds no PayPal tools at all; the Recovery Agent can
  refund but not pay.
- **Decision provenance** — before money moves, the agent records which options it rejected and why.
- **Outcome accountability** — a captured payment is not a success until the goal is met. If the
  hotel cancels, the payment is marked *outcome failed*, refunded, and a replacement is proposed
  that needs fresh human approval.

## The demo story

Open the demo and follow the numbered steps.

| # | Agent action | Result | What it shows |
|---|---|---|---|
| 1 | Japan eSIM, $18 | **Approved → paid** | A legitimate purchase flows straight through to PayPal |
| 2 | Luxury hotel, $780 | **Blocked** — authority exceeded | An agent cannot exceed its delegated limit |
| 3 | Theme park ticket, $120 | **Blocked** — intent mismatch | Budget, authority and scope all pass. Only intent catches it |
| 4 | Compare hotels, book Hotel B, $486 | **Approved → paid** | "Why this payment?" shows the rejected alternatives |
| 5 | Airport transfer, $110 | **Blocked** — budget exceeded | Relevant, but not affordable — the mirror image of step 3 |
| 6 | Hotel cancels the booking | **Outcome failed → refunded → recovery** | Payment success is not intent success |

Also try **Simulate escalation attempt** (an agent tries to hand out more authority than it holds)
and **Try your own purchase** (propose anything and watch the four checks).

## How PayPal is used

All PayPal access goes through the [PayPal Agent Toolkit](https://github.com/paypal/agent-toolkit)
(`@paypal/agent-toolkit`), in the sandbox:

| Toolkit tool | Used for |
|---|---|
| `create_order` | Creating the order once a transaction is approved. The intent id, agent and transaction id are written into the order's line-item description |
| `get_order` | Checking the buyer approved before capturing — a capture is never retried blindly |
| `pay_order` | Capturing the payment |
| `create_refund` | Refunding when the outcome fails |

Each agent role gets its own toolkit instance with only the actions it is allowed
([`src/lib/paypal.ts`](src/lib/paypal.ts)), so PayPal permissions narrow along the delegation
chain exactly as spending authority does. Sandbox mode is hard-wired; the app cannot reach live
PayPal.

The buyer approval step is real: you are redirected to the PayPal sandbox, approve with a sandbox
personal account, and are returned to the app, which then captures.

## How AI is used

Intent analysis runs on JEV (TypeSafe System One), which answers structured questions about a
state object:

- **Intent extraction** — classifies what the trip is for and where it goes. Amounts are parsed by rule, never taken from the AI.
- **Intent alignment** — rates how strongly a purchase serves the stated purpose against a five-level rubric. The expected level, scaled to 0–100, is the alignment score: 65+ passes, 40–64 needs human review, below 40 is blocked. Merchant-supplied text is passed as untrusted data.
- **Independent review** — the AI separately picks the best hotel and rates the recovery proposal, and the result is recorded next to the rule-based decision.

The agents themselves are deterministic orchestrators: code runs the workflow, the AI supplies
judgement, and the validator has the last word.

## Run it yourself

Requires **Node.js 22.13 or newer** (the app uses the built-in `node:sqlite`).

```bash
git clone https://github.com/seantw0301/IntentChain.git
cd IntentChain
scripts/install.sh
scripts/start.sh
```

Then open http://localhost:3100/intentchain

`scripts/install.sh` creates `.env` from [`.env.example`](.env.example). What you get depends on
what you put in it:

| `.env` | Behaviour |
|---|---|
| Nothing | Fully working demo. Payments are **simulated** and AI scores come from bundled **cached** reference data. Both are labelled as such in the UI |
| `PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET` | Real PayPal **sandbox** orders, captures and refunds |
| `JEV_API_KEY` | **Live** AI intent analysis |

To get PayPal sandbox credentials, create a sandbox app at
<https://developer.paypal.com/dashboard/applications/sandbox>. To approve payments as the buyer,
use a sandbox *personal* account from
<https://developer.paypal.com/dashboard/accounts>.

The JEV key is not public. Without it the validator still runs all four checks; only the alignment
score comes from the reference table in [`src/lib/catalog.ts`](src/lib/catalog.ts). The header of
the app always shows which mode PayPal and the AI are running in.

### Verify

With the server running in simulated-payment mode:

```bash
scripts/smoke.sh
```

This drives the whole story through the HTTP API and checks every outcome, including session
isolation and reset.

## API

All paths are under `/intentchain/api`. Every `POST` returns the full, fresh state.

| Method | Path | Body |
|---|---|---|
| `POST` | `/intent` | `{ prompt }` |
| `POST` | `/intent/{id}/confirm` | — |
| `POST` | `/delegate` | `{ parent, agent, budget, scope, expires_at }` — rejected with `422` if not a subset of the parent |
| `POST` | `/transaction/evaluate` | `{ step }` or `{ name, amount, category }` |
| `POST` | `/transaction/{id}/confirm` | `{ approve }` — resolves a human-review warning |
| `POST` | `/paypal/order` | `{ transaction_id }` — only for approved transactions |
| `POST` | `/paypal/capture` | `{ transaction_id }` |
| `POST` | `/outcome/event` | `{ transaction_id, type: "booking_cancelled" }` |
| `GET` | `/audit` | — |
| `POST` | `/demo/reset` | — clears your own session |

## Project layout

```
src/app/            UI and the API route
src/components/     UI panels
src/lib/
  intent.ts         intent extraction and confirmation
  delegation.ts     delegation chain and the monotonic rule
  validator.ts      the four checks
  agents.ts         agent workflows and decision provenance
  paypal.ts         PayPal Agent Toolkit access, per-role permissions
  payments.ts       order, capture, refund, outcome and recovery
  jev.ts            AI client
  audit.ts          event log and dashboard metrics
  db.ts             SQLite storage, keyed by browser session
scripts/            install, start, smoke test, reset
docs/               architecture notes
```

More detail: [docs/architecture.md](docs/architecture.md).

## Tools used

- **PayPal Agent Toolkit** and the PayPal sandbox — orders, captures, refunds
- **JEV (TypeSafe System One)** — intent extraction and alignment scoring
- **Next.js / React / TypeScript** — UI and API in one app
- **SQLite** (`node:sqlite`) — storage

## Limits of the demo

- Hotels and products are fixed demo data; there is no live product search.
- One scenario (a short business trip) is scripted. Custom purchases let you go off-script.
- Recovery stops at a proposal awaiting human approval; it does not pay for the replacement.
- No accounts: each browser session gets isolated state that is discarded after 24 idle hours.

## License

Copyright (C) 2026 ChengYuan Chang

IntentChain is licensed under the GNU Affero General Public License v3.0 (AGPL-3.0).
See [LICENSE](LICENSE).

For closed-source or commercial use without AGPL obligations, a commercial license is available.
Contact: admin@esim168.com
