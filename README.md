# IntentChain

**An intent integrity firewall for multi-agent commerce**, built on PayPal.

> Trust the chain, not just the agent.

Live demo: **https://demo.jxdtw.com/intentchain**

Built for the PayPal AI Hackathon.

## The problem

Agentic commerce is not one agent with a wallet. One agent breaks the job down and hands pieces
to other agents, and those agents hand pieces on again. Every hand-off is a chance for the
original request to change: a little more authority here, a slightly broader task there.

Spending limits and policy rules check the last step — is this payment allowed? They do not
check the path that led to it. So what happens when an agent delegates your task to another
agent, and that one delegates it again? Who makes sure it is still what you asked for?

## What IntentChain does

IntentChain sits between the agents and PayPal and verifies the **whole delegation chain** before
any PayPal tool can be called.

**1. Authority can only shrink.** Every grant from one agent to the next must be a subset of its
parent in amount, per-night rate, place, dates, categories and lifetime. A grant that asks for one
extra capability is rejected at the moment of delegation, even when the amount is unchanged.

**2. The chain is signed.** Each grant is HMAC-signed over its own limits *and its parent's
signature*, back to the human intent. A grant that was altered or invented does not verify, and
the transaction is refused.

**3. PayPal permissions shrink with it.** Each agent role has its own PayPal Agent Toolkit
instance with only the tools it was granted. The Hotel Agent can search but holds no PayPal tools.
The Recovery Agent can refund but cannot pay.

**4. Intent drift is measured at every hop.** A grant can be a perfectly valid subset and still
carry a task the human never asked for. Each grant's stated purpose is scored against the original
intent, so drift is caught where it starts — and anything bought further down is traced back to
that hop.

**5. Four independent checks gate each payment.**

| Check | Question | Decided by |
|---|---|---|
| **Budget** | Is there money left? | Rule |
| **Authority** | May *this* agent spend this much, over a chain that verifies? | Rule + signatures |
| **Scope** | Right place, right dates? | Rule |
| **Intent** | Does this purchase serve the human's original goal? | Stated restrictions + AI |

The AI can block a payment or send it to a human for review. It can never approve one by itself.

**6. Payment is not the finish line.** If the hotel cancels after a successful payment, the
transaction is marked *outcome failed*, refunded through PayPal, and a replacement is proposed
that needs fresh human approval.

Every step is written to an audit log keyed by the intent id, and each transaction can show its
full lineage: human intent → each signed grant → the decision → the payment.

## The demo story

Open the demo and follow the numbered steps.

| # | What happens | Result | What it shows |
|---|---|---|---|
| 1 | Confirm the intent | Chain of three signed grants, each narrower than the last | Authority and PayPal tools shrink per hop |
| 2 | Travel Agent buys a Japan eSIM, $18 | **Approved → paid** | A legitimate purchase flows straight to PayPal |
| 3 | **Simulate delegation attack** | **Delegation rejected** | Same amount, one extra capability — not a subset |
| 4 | Booking Agent tries a luxury hotel, $780 | **Blocked** — authority exceeded | The agent is named as the source |
| 5 | Travel Agent delegates “improve the overall travel experience” | **Accepted, flagged as intent drift** | Structurally valid, semantically off |
| 6 | Experience Agent buys a theme park ticket, $120 | **Blocked** — intent mismatch | Budget, authority and scope all pass. Traced back to the drifting hop |
| 7 | Compare hotels, book Hotel B, $486 | **Approved → paid** | “Why this payment?” shows the rejected alternatives |
| 8 | Hotel cancels the booking | **Outcome failed → refunded → recovery** | Payment success is not intent success |

Also try **Simulate forged grant** (an agent presents a grant whose limit was raised after
signing), the **airport transfer** (relevant but over budget) and **Try your own purchase**
(propose anything and watch the four checks).

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
- **Intent fidelity per hop** — rates how faithfully each grant's stated task stays within the human intent. Below 65 is flagged as drift.
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
| `POST` | `/delegate` | `{ parent, agent, budget, scope, expires_at }` — rejected with `422` if not a subset of the parent. `{ simulate: "escalation" \| "forgery" \| "experience" }` runs the scripted delegation events |
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
  delegation.ts     monotonic rule, signed chain, intent fidelity per hop
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
- Grants are signed with a server-held HMAC key. Agents here run inside one process; in a real deployment each agent would hold its own key.
- No accounts: each browser session gets isolated state that is discarded after 24 idle hours.

## License

Copyright (C) 2026 ChengYuan Chang

IntentChain is licensed under the GNU Affero General Public License v3.0 (AGPL-3.0).
See [LICENSE](LICENSE).

For closed-source or commercial use without AGPL obligations, a commercial license is available.
Contact: admin@esim168.com
