// An LLM agent that pays through IntentChain, for any tool-calling model
// behind an OpenAI-compatible endpoint.
//
// The model decides which PayPal tool to call. It never touches PayPal
// directly: every tool call goes to the IntentChain agent gateway, which
// authenticates the grant token, exposes only the tools that grant carries,
// and runs the firewall before anything reaches PayPal.
//
// Usage:
//   1. Open the demo, confirm an intent, click "Copy agent token" on an agent.
//   2. export INTENTCHAIN_TOKEN=ic_…        (the token you copied)
//      export LLM_BASE_URL=…                (e.g. https://your-endpoint/v1)
//      export LLM_API_KEY=…
//      export LLM_MODEL=…
//   3. node examples/llm-agent.mjs "Buy a theme park day ticket for $120."
//
// Optional: INTENTCHAIN_URL (default https://demo.jxdtw.com)

const GATEWAY = `${(process.env.INTENTCHAIN_URL || 'https://demo.jxdtw.com').replace(/\/$/, '')}/intentchain/api/agent/tools`;
const TOKEN = process.env.INTENTCHAIN_TOKEN;
const { LLM_BASE_URL, LLM_API_KEY, LLM_MODEL } = process.env;
const task = process.argv.slice(2).join(' ') || 'Buy a theme park day ticket for $120 so I can relax after the meeting.';

if (!TOKEN) {
  console.error('Set INTENTCHAIN_TOKEN to a grant token copied from the demo ("Copy agent token").');
  process.exit(1);
}
if (!LLM_BASE_URL || !LLM_MODEL) {
  console.error('Set LLM_BASE_URL and LLM_MODEL (and LLM_API_KEY if your endpoint needs one).');
  process.exit(1);
}

async function gateway(path = '', body) {
  const res = await fetch(`${GATEWAY}${path}`, {
    method: body ? 'POST' : 'GET',
    headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { ok: res.ok, json: await res.json() };
}

// 1. Ask the gateway what this grant allows. The tool list comes from the
//    grant, not from this script: a grant without PayPal tools yields none.
const grant = await gateway();
if (!grant.ok) {
  console.error('The gateway rejected the grant token:', grant.json.error?.message);
  process.exit(1);
}
const { agent, intent, grant: limits } = grant.json;
console.log(`Acting as the ${agent} agent for ${intent.id} ("${intent.goal}")`);
console.log(`Task: "${limits.task}" · limit $${limits.limit_usd}`);
console.log(`PayPal tools in this grant: ${grant.json.tools.map((t) => t.name).join(', ') || 'none'}\n`);

// 2. Let the model work the task with those tools.
const tools = grant.json.tools.map((t) => ({
  type: 'function',
  function: { name: t.name, description: t.description, parameters: t.input_schema },
}));
const messages = [
  {
    role: 'system',
    content:
      `You are the ${agent} agent in a multi-agent system, acting for a human whose goal is "${intent.goal}". ` +
      `You were delegated this task: "${limits.task}". Use the PayPal tools to carry out what the user asks. ` +
      'Every purchase is checked by a firewall. If a purchase is blocked, do not rephrase or retry it: ' +
      'tell the user plainly that it was blocked and why. Never claim a payment happened unless a tool result says so.',
  },
  { role: 'user', content: task },
];

for (let turn = 0; turn < 8; turn++) {
  const res = await fetch(`${LLM_BASE_URL.replace(/\/$/, '')}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(LLM_API_KEY ? { Authorization: `Bearer ${LLM_API_KEY}` } : {}) },
    body: JSON.stringify({ model: LLM_MODEL, messages, ...(tools.length ? { tools } : {}) }),
  });
  const reply = (await res.json()).choices?.[0]?.message;
  if (!res.ok || !reply) {
    console.error(`The model endpoint answered ${res.status} without a message.`);
    process.exit(1);
  }
  if (reply.content?.trim()) console.log(`Agent: ${reply.content.trim()}\n`);
  messages.push(reply);
  if (!reply.tool_calls?.length) break;

  // 3. Run every tool call through the gateway and hand the results back.
  for (const call of reply.tool_calls) {
    let input = {};
    try {
      input = JSON.parse(call.function.arguments || '{}');
    } catch {
      messages.push({ role: 'tool', tool_call_id: call.id, content: 'The arguments were not valid JSON.' });
      continue;
    }
    console.log(`→ ${call.function.name}(${JSON.stringify(input)})`);
    const out = await gateway(`/${call.function.name}`, input);
    const verdict = out.ok
      ? `${out.json.status}${out.json.blocked ? ` — ${out.json.reason_code}` : ''}`
      : `refused: ${out.json.error?.message}`;
    console.log(`← ${verdict}\n`);
    messages.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify(out.ok ? out.json : out.json.error) });
  }
}
