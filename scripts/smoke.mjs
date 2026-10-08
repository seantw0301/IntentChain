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

r = await api('POST', 'delegate', { simulate: 'escalation' });
check('escalation attempt is rejected (monotonic delegation)', r.status === 422 && r.json.error?.code === 'MONOTONIC_VIOLATION');

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
r = await api('POST', 'paypal/order', { transaction_id: tx.id });
check('a blocked transaction can never reach PayPal', r.status === 409);

// 3. intent drift — the key case
r = await api('POST', 'transaction/evaluate', { step: 'theme-park' });
tx = last(r.json);
check('Test 4 — theme park $120: budget, authority, scope PASS; intent FAIL',
  tx.status === 'BLOCKED' && tx.validation.reason_code === 'INTENT_MISMATCH' &&
  tx.validation.budget.pass && tx.validation.authority.pass && tx.validation.scope.pass && tx.validation.intent.status === 'fail',
  JSON.stringify(tx.validation));

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
