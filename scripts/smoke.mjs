// End-to-end smoke test of the demo story against a running server.
// Usage: node scripts/smoke.mjs [base-url]     (default http://localhost:3100)
// Runs in whatever mode the server is in; the PayPal steps need PAYPAL_MODE=mock
// because a real sandbox order needs a human buyer to approve it.

const ORIGIN = (process.argv[2] || 'http://localhost:3100').replace(/\/$/, '');
const API = `${ORIGIN}/intentchain/api`;

let failures = 0;
function check(name, ok, detail = '') {
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${name}${ok || !detail ? '' : `  → ${detail}`}`);
  if (!ok) failures++;
}

function client() {
  let cookie = '';
  return async (method, path, body) => {
    const res = await fetch(`${API}/${path}`, {
      method,
      headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
      body: method === 'POST' || method === 'PUT' ? JSON.stringify(body ?? {}) : undefined,
    });
    const set = res.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0];
    return { status: res.status, json: await res.json() };
  };
}

const last = (s) => s.transactions.at(-1);

// the agent gateway authenticates with a grant token instead of a session cookie
async function agent(token, path = '', body) {
  const res = await fetch(`${API}/agent/tools${path}`, {
    method: body ? 'POST' : 'GET',
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, json: await res.json() };
}

async function pay(api, id) {
  await api('POST', 'paypal/order', { transaction_id: id });
  return (await api('POST', 'paypal/capture', { transaction_id: id })).json;
}

const api = client();

let r = await api('GET', 'audit');
const mock = r.json.config?.paypal_mode === 'mock';
console.log(`Server: ${ORIGIN}  PayPal: ${r.json.config?.paypal_mode}  AI: ${r.json.config?.ai_mode}\n`);
check('fresh session is empty', r.json.intent === null && r.json.transactions.length === 0);

check('company policy is in place before any request',
  r.json.policy?.auto_pay_limit === 150 && r.json.policy.blocked_categories.includes('entertainment'), JSON.stringify(r.json.policy));
r = await api('POST', 'intent', { prompt: 'Sean needs a week in Tokyo for a client meeting. Trip budget: $2000.' });
check('a request above the company trip budget is refused', r.status === 422 && r.json.error?.code === 'OVER_COMPANY_BUDGET', JSON.stringify(r.json.error));

r = await api('POST', 'intent', {
  prompt: 'Sean from the product team is traveling to Tokyo for a client meeting next week. Arrange his hotel and eSIM under the company travel policy. Trip budget: $600.',
});
const intent = r.json.intent;
check('intent extracted: $600 business trip to Tokyo',
  intent?.budget === 600 && intent?.purpose === 'business' && intent?.location === 'Tokyo' && intent?.status === 'DRAFT',
  JSON.stringify(intent));
check('category limits: lodging $500, connectivity $40',
  intent?.category_caps?.lodging === 500 && intent?.category_caps?.connectivity === 40);

r = await api('POST', 'transaction/evaluate', { step: 'esim' });
check('agents cannot act before the intent is confirmed', r.status === 409);

r = await api('POST', `intent/${intent.id}/confirm`);
const d = r.json.delegations;
check('delegation chain narrows: 600 → 500 → 180/night',
  d?.length === 3 && d[0].budget === 600 && d[1].budget === 500 && d[2].per_night === 180, JSON.stringify(d?.map((x) => [x.agent, x.budget, x.per_night])));
check('Hotel Agent holds no PayPal tools', d?.[1]?.paypal_tools?.length === 0);

check('every grant is signed and scored for intent fidelity',
  d?.every((x) => /^[a-f0-9]{64}$/.test(x.signature) && typeof x.fidelity?.score === 'number' && !x.drift),
  JSON.stringify(d?.map((x) => [x.agent, x.fidelity?.score, x.drift])));

r = await api('POST', 'delegate', { simulate: 'escalation' });
check('delegation attack rejected: same amount, one extra capability',
  r.status === 422 && r.json.error?.code === 'MONOTONIC_VIOLATION' && /entertainment/.test(r.json.error.message) && !/Budget/.test(r.json.error.message),
  JSON.stringify(r.json.error));
r = await api('POST', 'delegate', { simulate: 'forgery' });
check('forged grant rejected: signature chain does not verify',
  r.status === 422 && r.json.error?.code === 'CHAIN_SIGNATURE_INVALID', JSON.stringify(r.json.error));
r = await api('GET', 'audit');
check('rejected and forged grants were never stored', r.json.delegations.length === 3);

// 1. small legitimate purchase → auto-pay
r = await api('POST', 'transaction/evaluate', { step: 'esim' });
let tx = last(r.json);
const v1 = tx.validation;
check('eSIM $18: all five checks pass, routed to auto-pay',
  v1.policy.pass && v1.budget.pass && v1.authority.pass && v1.scope.pass && v1.intent.status === 'pass' && v1.payment_route === 'AUTO_PAY',
  JSON.stringify(v1));
if (r.json.autopay.connected) {
  check('eSIM is paid at once with the saved PayPal account, nobody in the loop',
    tx.status === 'CAPTURED' && tx.payment?.via === 'vault' && r.json.metrics.spent === 18, `${tx.status} ${JSON.stringify(tx.payment)}`);
}

// 2. authority exceeded
r = await api('POST', 'transaction/evaluate', { step: 'luxury-hotel' });
tx = last(r.json);
check('Test 3 — luxury hotel $780 blocked: authority exceeded',
  tx.status === 'BLOCKED' && tx.validation.reason_code === 'AUTHORITY_EXCEEDED' && tx.validation.intent.status === 'skipped',
  JSON.stringify(tx.validation));
check('responsibility: the Booking Agent is named as the source', tx.validation.violation?.source === 'Booking Agent', JSON.stringify(tx.validation.violation));
r = await api('POST', 'paypal/order', { transaction_id: tx.id });
check('a blocked transaction can never reach PayPal', r.status === 409);

// 3. what any expense policy catches: a blocked category
r = await api('POST', 'transaction/evaluate', { step: 'theme-park' });
tx = last(r.json);
check('theme park $120: blocked by company policy (and intent fails too)',
  tx.status === 'BLOCKED' && tx.validation.reason_code === 'POLICY_VIOLATION' && !tx.validation.policy.pass &&
  tx.validation.budget.pass && tx.validation.authority.pass && tx.validation.scope.pass && tx.validation.intent.status === 'fail',
  JSON.stringify(tx.validation));

// the owner unblocks entertainment: policy now passes, intent still says no
r = await api('PUT', 'company/policy', { toggle: 'entertainment' });
check('owner can change the policy', r.status === 200 && r.json.policy.allowed_categories.includes('entertainment'));
r = await api('POST', 'transaction/evaluate', { step: 'theme-park' });
tx = last(r.json);
check('with entertainment allowed, the theme park passes policy but still fails intent',
  tx.status === 'BLOCKED' && tx.validation.policy.pass && tx.validation.reason_code === 'INTENT_MISMATCH', JSON.stringify(tx.validation));
await api('PUT', 'company/policy', { toggle: 'entertainment' });

// 4. the key case: every policy check passes, the chain has drifted
r = await api('POST', 'delegate', { simulate: 'experience' });
const exp = r.json.delegations?.find((x) => x.agent === 'experience');
check('drifting delegation is a valid subset, so it is accepted', r.status === 200 && exp?.budget === 150 && exp?.parent === d[0].id, JSON.stringify(r.json.error ?? exp));
check('…but its purpose is flagged as intent drift', exp?.drift === true && exp.fidelity.score < 65, JSON.stringify(exp?.fidelity));
r = await api('POST', 'transaction/evaluate', { step: 'dinner-cruise' });
tx = last(r.json);
check('dinner cruise $95: policy, budget, authority, scope PASS — intent FAIL',
  tx.status === 'BLOCKED' && tx.validation.policy.pass && tx.validation.budget.pass && tx.validation.authority.pass &&
  tx.validation.scope.pass && tx.validation.intent.status === 'fail' && tx.validation.reason_code === 'INTENT_DRIFT',
  JSON.stringify(tx.validation));
check('proposed by the Experience Agent over a verified 2-hop chain', tx.agent === 'experience' && tx.validation.chain_hops === 2);
check('responsibility: traced to the Travel → Experience delegation hop',
  /Travel Agent → Experience Agent/.test(tx.validation.violation?.source ?? '') && /Intent drift/.test(tx.validation.violation?.type ?? '') && tx.validation.violation.delegation_id === exp?.id,
  JSON.stringify(tx.validation.violation));

// a real LLM as the agent, when the server has one configured: it plans, the firewall decides
if (r.json.config.agent_model) {
  r = await api('POST', 'agent/run', { agent: 'experience', instruction: 'Make Sean’s free evening in Tokyo memorable. Find one option and book it.' });
  const run = r.json.events?.findLast((e) => e.type === 'agent.run');
  const made = r.json.transactions?.filter((t) => t.agent === 'experience').at(-1);
  check(`LLM agent (${r.json.config?.agent_model}) chose its own tool calls`,
    r.status === 200 && run?.data.steps.some((s) => s.kind === 'call' && s.text.startsWith('create_order')), JSON.stringify(r.json.error ?? run?.data.steps));
  check('…and what it tried to buy under the drifted grant was blocked', made?.status === 'BLOCKED', JSON.stringify(made?.validation));
}

// agent gateway: an outside agent acting under a grant token
{
  const s = (await api('GET', 'audit')).json;
  const tokenOf = (role) => s.grant_tokens[s.delegations.find((x) => x.agent === role).id];
  let g = await agent(null);
  check('gateway: no token, no access', g.status === 401);
  g = await agent(`${tokenOf('travel').slice(0, -4)}AAAA`);
  check('gateway: a tampered token is rejected', g.status === 401, JSON.stringify(g.json));
  check('gateway: the Hotel Agent has no token at all (it holds no PayPal tools)',
    s.grant_tokens[s.delegations.find((x) => x.agent === 'hotel').id] === undefined);
  g = await agent(tokenOf('experience'));
  check('gateway: a grant lists only its own PayPal tools',
    g.status === 200 && g.json.agent === 'experience' && g.json.tools.some((t) => t.name === 'create_order'), JSON.stringify(g.json));
  g = await agent(tokenOf('experience'), '/create_order', { item_name: 'Karaoke night', amount_usd: 60, category: 'entertainment' });
  check('gateway: an outside agent is stopped by company policy',
    g.status === 200 && g.json.blocked === true && g.json.reason_code === 'POLICY_VIOLATION', JSON.stringify(g.json));
  g = await agent(tokenOf('experience'), '/create_order', { item_name: 'Evening sightseeing river cruise with dinner', amount_usd: 80, category: 'meals' });
  check('gateway: an allowed category still fails on intent, traced to the drifting hop',
    g.status === 200 && g.json.blocked === true && g.json.reason_code === 'INTENT_DRIFT' && /Experience Agent/.test(g.json.violation?.source ?? ''),
    JSON.stringify(g.json));
  g = await agent(tokenOf('experience'), '/create_refund', { transaction_id: 'x' });
  check('gateway: a tool outside the grant is refused', g.status === 403 && g.json.error?.code === 'TOOL_NOT_GRANTED', JSON.stringify(g.json));
  g = await agent(tokenOf('travel'), '/create_order', { item_name: 'Train pass to reach the client office on the meeting days', amount_usd: 160, category: 'transport' });
  check('gateway: a legitimate purchase above the auto-pay limit waits for a manager',
    g.status === 200 && g.json.blocked === false && (g.json.status === 'ORDER_CREATED' || g.json.status === 'WARNING'), JSON.stringify(g.json));
  const theirs = g.json.transaction_id;
  g = await agent(tokenOf('experience'), '/get_order', { transaction_id: theirs });
  check('gateway: an agent cannot read another agent\'s transaction', g.status === 404);
}

// a visitor delegates a task in their own words
r = await api('POST', 'delegate', { task: 'Find fun things to do in the evenings', budget: 100 });
const own = r.json.delegations?.findLast((x) => x.agent === 'custom');
check('own task: accepted as a subset, scored, and flagged as drift',
  r.status === 200 && own?.budget === 100 && own.drift === true && typeof own.fidelity?.score === 'number', JSON.stringify(r.json.error ?? own?.fidelity));
r = await api('POST', 'delegate', { task: 'Arrange a taxi to the client office', budget: 60 });
const onTask = r.json.delegations?.findLast((x) => x.agent === 'custom');
check('own task: one that serves the goal is not flagged', r.status === 200 && onTask?.drift === false, JSON.stringify(onTask?.fidelity));
r = await api('POST', 'delegate', { task: 'Arrange a taxi to the client office', budget: 9999 });
check('own task: asking for more than the parent holds is rejected', r.status === 422 && r.json.error?.code === 'MONOTONIC_VIOLATION');

// 4. hotel with decision provenance
r = await api('POST', 'transaction/evaluate', { step: 'hotel' });
tx = last(r.json);
const decision = r.json.decisions.at(-1);
check('hotel decision recorded: B selected, A and C rejected',
  decision?.selected_item_id === 'hotel-b' && decision.options.filter((o) => o.outcome === 'REJECTED').length === 2);
check('Hotel B $486: passes all five checks, held for manager approval',
  tx.status === 'APPROVED' && tx.item.amount === 486 && tx.validation.payment_route === 'MANAGER_APPROVAL', JSON.stringify(tx.validation));
const hotelId = tx.id;

if (mock) {
  let s = await pay(api, hotelId);
  check('manager approves: hotel captured through checkout, $504 spent',
    last(s).status === 'CAPTURED' && last(s).payment.via === 'checkout' && s.metrics.spent === 504, `spent ${s.metrics.spent}`);
  check('single-use booking grant is now USED', s.delegations[2].status === 'USED');

  // 5. over budget
  r = await api('POST', 'transaction/evaluate', { step: 'airport-transfer' });
  tx = last(r.json);
  check('Test 2 — airport transfer $110 blocked: budget exceeded, authority still passes',
    tx.status === 'BLOCKED' && tx.validation.reason_code === 'BUDGET_EXCEEDED' && tx.validation.authority.pass,
    JSON.stringify(tx.validation));

  // 6. outcome failure
  r = await api('POST', 'outcome/event', { transaction_id: hotelId, type: 'booking_cancelled' });
  s = r.json;
  const hotel = s.transactions.find((t) => t.id === hotelId);
  const rec = s.recoveries[0];
  check('booking cancelled → refunded, $18 spent', hotel.status === 'REFUNDED' && s.metrics.spent === 18, `${hotel.status} ${s.metrics.spent}`);
  check('recovery proposed and waiting for a human', rec?.status === 'AWAITING_HUMAN' && rec.proposal.validation.decision === 'APPROVED', JSON.stringify(rec?.proposal?.validation));
  check('dashboard: authority integrity 100%, recovery active',
    s.metrics.authority_integrity === 100 && s.metrics.outcome_status === 'Recovery Active', JSON.stringify(s.metrics));
  if (s.config.ai_mode === 'cached') check('dashboard: intent integrity 94%', s.metrics.intent_integrity === 94, `${s.metrics.intent_integrity}`);
  check('every agent and payment event carries the intent id',
    s.events.filter((e) => !e.type.startsWith('policy.')).every((e) => e.intent_id === intent.id));
  r = await api('POST', 'audit/reconcile');
  const recon = r.json.events.findLast((e) => e.type === 'audit.reconciled');
  check('reconciliation lists every transaction that reached PayPal', r.status === 200 && recon?.data.rows.length >= 2, JSON.stringify(recon?.data));
} else {
  console.log('  skip  payment, budget and outcome steps (a sandbox order needs a human buyer)');
}

// session isolation and reset
const other = client();
r = await other('GET', 'audit');
check('another browser session sees none of this', r.json.intent === null && r.json.events.length === 0);
r = await api('POST', 'demo/reset');
check('reset empties the session', r.json.intent === null && r.json.transactions.length === 0 && r.json.events.length === 0);

// the same policy and firewall, a different kind of request: an office purchase
r = await api('POST', 'intent', { prompt: 'Order laptops and monitors for the whole team. Budget: $900.' });
check('office purchase above the company procurement budget is refused', r.status === 422 && r.json.error?.code === 'OVER_COMPANY_BUDGET', JSON.stringify(r.json.error));
r = await api('POST', 'intent', { prompt: 'Order USB-C adapters for the three new hires starting Monday. Budget: $200.' });
const proc = r.json.intent;
check('office purchase request is recognised', proc?.kind === 'procurement' && proc.id === 'PROC-001' && proc.budget === 200, JSON.stringify(proc));
r = await api('POST', `intent/${proc.id}/confirm`);
check('procurement chain: Procurement → Sourcing → Purchasing, office supplies only',
  r.json.delegations?.map((x) => x.label).join(' > ') === 'Procurement Agent > Sourcing Agent > Purchasing Agent' &&
  r.json.delegations.every((x) => x.scope.categories?.join() === 'office'), JSON.stringify(r.json.delegations?.map((x) => x.label)));
r = await api('POST', 'transaction/evaluate', { step: 'usb-adapter' });
tx = last(r.json);
check('adapters $49: all five checks pass, auto-pay',
  tx.validation.decision === 'APPROVED' && tx.validation.payment_route === 'AUTO_PAY' && (!r.json.autopay.connected || tx.status === 'CAPTURED'),
  JSON.stringify(tx.validation));
r = await api('POST', 'transaction/evaluate', { step: 'gaming-gpu' });
tx = last(r.json);
check('gaming graphics card $799: blocked by company policy, Purchasing Agent named',
  tx.status === 'BLOCKED' && tx.validation.reason_code === 'POLICY_VIOLATION' && tx.validation.violation?.source === 'Purchasing Agent',
  JSON.stringify(tx.validation));
await api('POST', 'demo/reset');

console.log(failures ? `\n${failures} check(s) failed.` : '\nAll checks passed.');
process.exit(failures ? 1 : 0);
