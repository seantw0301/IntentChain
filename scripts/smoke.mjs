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
      body: method === 'POST' ? JSON.stringify(body ?? {}) : undefined,
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

r = await api('POST', 'intent', {
  prompt: 'I have a client meeting in Tokyo next week. Find me a hotel and an eSIM. Total budget: $600. This is a business trip.',
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

// 1. legitimate purchase
r = await api('POST', 'transaction/evaluate', { step: 'esim' });
let tx = last(r.json);
check('Test 1 — eSIM $18 approved, all four checks pass',
  tx.status === 'APPROVED' && tx.validation.budget.pass && tx.validation.authority.pass && tx.validation.scope.pass && tx.validation.intent.status === 'pass',
  JSON.stringify(tx.validation));
if (mock) {
  const s = await pay(api, tx.id);
  check('eSIM captured through PayPal (simulated)', last(s).status === 'CAPTURED' && s.metrics.spent === 18);
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

// 3. intent drift across hops — the key case
r = await api('POST', 'delegate', { simulate: 'experience' });
const exp = r.json.delegations?.find((x) => x.agent === 'experience');
check('drifting delegation is a valid subset, so it is accepted', r.status === 200 && exp?.budget === 150 && exp?.parent === d[0].id, JSON.stringify(r.json.error ?? exp));
check('…but its purpose is flagged as intent drift', exp?.drift === true && exp.fidelity.score < 65, JSON.stringify(exp?.fidelity));
r = await api('POST', 'transaction/evaluate', { step: 'theme-park' });
tx = last(r.json);
check('theme park is proposed by the Experience Agent over a verified 2-hop chain', tx.agent === 'experience' && tx.validation.chain_hops === 2);
check('responsibility: traced to the Travel → Experience delegation hop',
  /Travel Agent → Experience Agent/.test(tx.validation.violation?.source ?? '') && /Intent drift/.test(tx.validation.violation?.type ?? '') && tx.validation.violation.delegation_id === exp?.id,
  JSON.stringify(tx.validation.violation));
check('Test 4 — theme park $120: budget, authority, scope PASS; intent FAIL',
  tx.status === 'BLOCKED' && tx.validation.reason_code === 'INTENT_MISMATCH' &&
  tx.validation.budget.pass && tx.validation.authority.pass && tx.validation.scope.pass && tx.validation.intent.status === 'fail',
  JSON.stringify(tx.validation));

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
  check('gateway: an outside agent is blocked by the same firewall, traced to the drifting hop',
    g.status === 200 && g.json.blocked === true && g.json.reason_code === 'INTENT_MISMATCH' && /Experience Agent/.test(g.json.violation?.source ?? ''),
    JSON.stringify(g.json));
  g = await agent(tokenOf('experience'), '/create_refund', { transaction_id: 'x' });
  check('gateway: a tool outside the grant is refused', g.status === 403 && g.json.error?.code === 'TOOL_NOT_GRANTED', JSON.stringify(g.json));
  g = await agent(tokenOf('travel'), '/create_order', { item_name: 'Pocket Wi-Fi rental for the meeting days', amount_usd: 25, category: 'connectivity' });
  check('gateway: a legitimate purchase gets a PayPal order',
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
check('Hotel B $486 approved', tx.status === 'APPROVED' && tx.item.amount === 486, JSON.stringify(tx.validation));
const hotelId = tx.id;

if (mock) {
  let s = await pay(api, hotelId);
  check('hotel captured, $504 spent', last(s).status === 'CAPTURED' && s.metrics.spent === 504, `spent ${s.metrics.spent}`);
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
  check('every audit event carries the intent id', s.events.every((e) => e.intent_id === intent.id));
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

console.log(failures ? `\n${failures} check(s) failed.` : '\nAll checks passed.');
process.exit(failures ? 1 : 0);
