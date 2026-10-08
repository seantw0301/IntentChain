# IntentChain

**Autonomous travel & procurement for small businesses** — AI agents that book and buy through
PayPal, inside limits the owner sets, checked at every hand-off between agents.

> Let AI spend. Keep your business in control.

Live demo: **https://demo.jxdtw.com/intentchain**

Built for the PayPal AI Hackathon.

## The problem

A ten-person company has no travel desk and no procurement team. AI agents could do that work:
find the hotel, buy the eSIM, order the adapters, and pay for them. But no owner wants to hand an
AI the company's money.

Expense policies help — allowed categories, budgets, approval limits — but they check one thing:
*is this purchase allowed?* Agents do not work alone. One agent breaks the job down and hands
pieces to other agents, which hand pieces on again. A purchase can be an allowed category, within
budget and within authority, and still not be what the employee was sent to do, because the task
changed shape somewhere along the way.

## What IntentChain does

**For the owner:** set a spending policy once — what agents may buy, a trip budget, and an
auto-pay limit. Connect PayPal once.

**For the team:** ask in one sentence. Agents arrange it and pay.

**Under the hood:** an intent integrity firewall sits between every agent and PayPal.

| Outcome | When | What happens |
|---|---|---|
| **Auto-pay** | Passes all five checks and is at or under the auto-pay limit | Paid at once through the company's PayPal billing agreement. Nobody in the loop |
| **Manager approval** | Passes all five checks but is over the limit | A manager approves it in PayPal; then it is captured |
| **Blocked** | Any check fails | Nothing reaches PayPal. The firewall names the agent, or the delegation hop, responsible |

The five checks are independent, and all five are shown for every transaction:

| Check | Question | Decided by |
|---|---|---|
| **Policy** | Does the company allow this kind of purchase at all? | Rule |
| **Budget** | Is there money left for this request? | Rule |
| **Authority** | May *this* agent spend this much, over a chain that verifies? | Rule + signatures |
| **Scope** | Right place, right dates? | Rule |
| **Intent** | Does it serve what the employee was actually sent to do? | AI, attributed to the delegation chain |

The first four are what an expense policy can do. The fifth, and the chain behind it, is what
makes this different:

- **Authority can only shrink.** Every grant from one agent to the next must be a subset of its
  parent in amount, per-night rate, place, dates, categories and lifetime. A grant that asks for
  one extra capability is rejected at the moment of delegation, even when the amount is unchanged.
- **The chain is signed.** Each grant is HMAC-signed over its own limits *and its parent's
  signature*. A grant that was altered or invented does not verify.
- **PayPal permissions shrink with it.** Each agent role has its own PayPal Agent Toolkit instance
  with only the tools it was granted. The Hotel Agent can search but holds no PayPal tools. The
  Recovery Agent can refund but cannot pay.
- **Intent drift is measured at every hop.** A grant can be a perfectly valid subset and still
  carry a task nobody asked for. Each grant's wording is scored against the original request, so
  drift is caught where it starts — and anything bought further down is traced back to that hop.
- **Payment is not the finish line.** If the hotel cancels after a successful payment, the
  transaction is marked *outcome failed*, refunded through PayPal, and a replacement is proposed
  that needs fresh approval.

The AI can block a payment or send it to a human. It can never approve one by itself.

## The demo story

Open the demo and press the button in the guide bar; it walks through the story one step at a time.

| Purchase | Policy | Budget | Authority | Scope | Intent | Result |
|---|---|---|---|---|---|---|
| eSIM, $18 | pass | pass | pass | pass | pass | **Auto-paid** through PayPal |
| Hotel, $486 | pass | pass | pass | pass | pass | **Manager approval**, then captured |
| Luxury suite, $780 | pass | fail | fail | pass | — | **Blocked** — authority exceeded |
| Theme park ticket, $120 | fail | pass | pass | pass | fail | **Blocked** — company policy |
| Sunset dinner cruise, $95 | pass | pass | pass | pass | fail | **Blocked** — intent drift |

The last row is the point. The cruise is booked as a business meal by an agent that was handed a
vague task (“improve the overall travel experience”). Every policy check passes. The firewall
blocks it anyway and traces it to the hand-off where the task drifted.

Along the way the demo also shows a **delegation attack** (same amount, one extra capability —
rejected), a **forged grant**, **decision provenance** for the hotel (“Why this payment?”), the
hotel **cancelling after payment** (refund and recovery), and **reconciliation** against PayPal.

The story ends with a short **office purchase** under the same policy: USB-C adapters for new
hires are auto-paid, a gaming graphics card is blocked. The roles are the same three, renamed —
Procurement, Sourcing and Purchasing.

With a [Channel3](https://trychannel3.com) key configured, the office purchase is sourced from
**real retailers**: the Sourcing Agent runs a live product search, records which match it chose and
why, and the Purchasing Agent pays for that product. (The PayPal payment is a sandbox payment; no
order is placed with the retailer.) An LLM agent's `search_options` tool uses the same live search.

Every proposed purchase lands in the **company ledger**, an [AG Grid](https://www.ag-grid.com)
table with the firewall's verdict on each of the five checks, sortable and filterable per column,
searchable, and exportable to CSV for the bookkeeper.

Things to try yourself: unblock *Entertainment* in the policy and buy the theme park ticket again
(policy now passes; intent still says no), change the auto-pay limit, delegate a task in your own
words, or propose any purchase.

## How PayPal is used

Everything runs in the PayPal sandbox. Sandbox mode is hard-wired; the app cannot reach live PayPal.

| What | How |
|---|---|
| **Auto-pay** | A PayPal **billing agreement** the owner approves once. Orders under the limit are created and captured in a single Orders API call against that agreement, with the transaction id as the idempotency key — no buyer present |
| **Manager approval** | PayPal Agent Toolkit `create_order` → the manager approves in PayPal → `get_order` → `pay_order` |
| **Refunds** | PayPal Agent Toolkit `create_refund` when an outcome fails |
| **Reconciliation** | PayPal Agent Toolkit `get_order` and `get_refund` read every order back and compare it with IntentChain's ledger |
| **Webhooks** | `POST /intentchain/api/paypal/webhook`. Each delivery is verified with PayPal before it is applied |
| **Lineage** | The intent id, agent and transaction id are written into every order's line-item description, so the PayPal record itself links back to the request |

Each agent role gets its own [PayPal Agent Toolkit](https://github.com/paypal/agent-toolkit)
instance with only the actions it is allowed ([`src/lib/paypal.ts`](src/lib/paypal.ts)), so PayPal
permissions narrow along the delegation chain exactly as spending authority does.

Two calls go to the PayPal REST API directly because the Agent Toolkit does not cover them:
auto-pay against a billing agreement, and webhook signature verification. Both reuse the toolkit's
sandbox client for authentication.

## Bring your own agent

The firewall is not tied to the scripted demo agents. Any agent — any language, any model — can
act under a grant through the **agent gateway**:

```bash
# which PayPal tools does this grant carry?
curl -H "Authorization: Bearer $TOKEN" https://demo.jxdtw.com/intentchain/api/agent/tools

# try to buy something; the firewall decides
curl -X POST -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"item_name":"Theme park ticket","amount_usd":120,"category":"entertainment"}' \
  https://demo.jxdtw.com/intentchain/api/agent/tools/create_order
```

`$TOKEN` is a **grant token**: a signed delegation, copied from the chain with *Copy agent token*.
The gateway verifies the signature chain, lists only the tools that grant carries (the Hotel Agent
has no token because it has no PayPal tools), runs the same five checks, and lets an agent see
only the transactions made under its own grant.

[`examples/claude-agent.mjs`](examples/claude-agent.mjs) is a complete LLM agent built on this:
Claude chooses the tool calls, the gateway decides what reaches PayPal.

```bash
export INTENTCHAIN_TOKEN=ic_…      # copied from the demo
export ANTHROPIC_API_KEY=…
node examples/claude-agent.mjs "Buy a theme park day ticket for $120."
```

## How AI is used

Intent analysis runs on JEV (TypeSafe System One), which answers structured questions about a
state object:

- **Intent extraction** — classifies what the trip is for and where it goes. Amounts are parsed by rule, never taken from the AI.
- **Intent alignment** — rates how strongly a purchase serves the stated purpose against a five-level rubric. The expected level, scaled to 0–100, is the alignment score: 65+ passes, 40–64 needs human review, below 40 is blocked. Merchant-supplied text is passed as untrusted data.
- **Intent fidelity per hop** — rates how faithfully each grant's stated task stays within the human intent. Below 65 is flagged as drift.
- **Independent review** — the AI separately picks the best hotel and rates the recovery proposal, and the result is recorded next to the rule-based decision.

**Agents that plan for themselves.** When the server is given a tool-calling LLM
(`LLM_BASE_URL`, `LLM_API_KEY`, `LLM_MODEL` — any OpenAI-compatible endpoint; the hosted demo uses
Claude), an agent can be handed its delegated task and an instruction and left to work: it reads
the company policy, searches the catalogue, picks an option and calls the PayPal tools. It has no
PayPal access of its own — every call goes through the same gateway and firewall an outside agent
would use. In the demo story this is the drift step: the model, knowing entertainment is blocked,
looks for something the policy allows, books the dinner cruise as a business meal, is blocked, and
reports why. *Ask an agent in your own words* lets you give any agent any instruction.

Without an LLM configured, the agents follow fixed workflows: code runs the steps, the intent AI
supplies judgement, and the firewall has the last word.

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
| `PAYPAL_AUTOPAY_AGREEMENT_ID` | Real **auto-pay**: the id of a sandbox billing agreement a buyer approved for your app. Without it, small purchases fall back to checkout |
| `JEV_API_KEY` | **Live** AI intent analysis |
| `CHANNEL3_API_KEY` | **Live product search** for office purchases, in place of the demo catalogue |
| `LLM_BASE_URL`, `LLM_API_KEY`, `LLM_MODEL` | Agents that **plan for themselves** with a tool-calling LLM (OpenAI-compatible endpoint) |

To connect auto-pay to your own sandbox app, run `node scripts/connect-autopay.mjs`: it creates
the billing agreement request, waits while you approve it as a sandbox buyer, and prints the line
to add to `.env`.

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
| `GET` / `PUT` | `/company/policy` | read the policy; `{ auto_pay_limit }` or `{ toggle: category }` to change it |
| `POST` | `/intent` | `{ prompt }` — refused if it exceeds the company trip budget |
| `POST` | `/intent/{id}/confirm` | — |
| `POST` | `/delegate` | `{ parent, agent, budget, scope, expires_at }` — rejected with `422` if not a subset of the parent. `{ simulate: "escalation" \| "forgery" \| "experience" }` runs the scripted delegation events |
| `POST` | `/transaction/evaluate` | `{ step }` or `{ name, amount, category }` |
| `POST` | `/agent/run` | `{ agent, instruction }` — an LLM agent plans and calls tools; the firewall decides |
| `POST` | `/transaction/{id}/confirm` | `{ approve }` — resolves a human-review warning |
| `POST` | `/paypal/order` | `{ transaction_id }` — only for approved transactions |
| `POST` | `/paypal/capture` | `{ transaction_id }` |
| `POST` | `/outcome/event` | `{ transaction_id, type: "booking_cancelled" }` |
| `GET` | `/audit` | — |
| `POST` | `/audit/reconcile` | — compares the ledger with PayPal |
| `GET` | `/agent/tools` | grant token in `Authorization` — the tools this grant carries |
| `POST` | `/agent/tools/{name}` | grant token — call a PayPal tool through the firewall |
| `POST` | `/paypal/webhook` | PayPal deliveries, signature-verified |
| `POST` | `/demo/reset` | — clears your own session |

## Project layout

```
src/app/            UI and the API route
src/components/     UI panels; LedgerGrid.tsx is the AG Grid company ledger
src/lib/
  intent.ts         intent extraction and confirmation
  delegation.ts     monotonic rule, signed chain, intent fidelity per hop
  policy.ts         the owner's spending policy
  validator.ts      the five checks and payment routing
  agents.ts         agent workflows and decision provenance
  paypal.ts         PayPal Agent Toolkit access, per-role permissions
  payments.ts       order, capture, refund, outcome, recovery, reconciliation, webhooks
  gateway.ts        agent gateway: grant tokens and guarded PayPal tools
  llm-agent.ts      agents that plan for themselves with a tool-calling LLM
  channel3.ts       live product search
  jev.ts            AI client
  audit.ts          event log and dashboard metrics
  db.ts             SQLite storage, keyed by browser session
examples/           a real LLM agent that pays through the gateway
scripts/            install, start, smoke test, reset
docs/               architecture notes
```

More detail: [docs/architecture.md](docs/architecture.md).

## Tools used

- **PayPal Agent Toolkit** and the PayPal sandbox — orders, captures, refunds, reconciliation
- **PayPal billing agreements** — auto-pay without a buyer present
- **PayPal Webhooks** — signature-verified payment events
- **Channel3** — live product search across retailers for office purchases
- **AG Grid** (Community) — the company ledger: per-column sort and filter, quick search, pinned totals row, CSV export
- **Claude** (Anthropic SDK) — the example bring-your-own agent
- **JEV (TypeSafe System One)** — intent extraction and alignment scoring
- **Next.js / React / TypeScript** — UI and API in one app
- **SQLite** (`node:sqlite`) — storage

## Limits of the demo

- Hotels and products are fixed demo data; there is no live product search.
- Two scenarios (a business trip and a short office purchase) are scripted. Most steps follow fixed workflows; the drift step and *Ask an agent* are planned by an LLM when one is configured. Custom purchases, your own delegated tasks and the agent gateway let you go off-script.
- The hosted demo shares one sandbox billing agreement for auto-pay, so every visitor's auto-paid purchases come from the same sandbox buyer.
- Recovery stops at a proposal awaiting human approval; it does not pay for the replacement.
- Grants are signed with a server-held HMAC key. Agents here run inside one process; in a real deployment each agent would hold its own key.
- No accounts: each browser session gets isolated state that is discarded after 24 idle hours.

## License

Copyright (C) 2026 ChengYuan Chang

IntentChain is licensed under the GNU Affero General Public License v3.0 (AGPL-3.0).
See [LICENSE](LICENSE).

For closed-source or commercial use without AGPL obligations, a commercial license is available.
Contact: admin@esim168.com
