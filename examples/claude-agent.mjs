// A real LLM agent that pays through IntentChain.
//
// Claude decides which PayPal tool to call. It never touches PayPal directly:
// every tool call goes to the IntentChain agent gateway, which authenticates
// the grant token, exposes only the tools that grant carries, and runs the
// firewall before anything reaches PayPal.
//
// Usage:
//   1. Open the demo, confirm an intent, click "Copy agent token" on an agent.
//   2. export INTENTCHAIN_TOKEN=ic_…        (the token you copied)
//      export ANTHROPIC_API_KEY=…           (or log in with `ant auth login`)
//   3. node examples/claude-agent.mjs "Buy a theme park day ticket for $120."
//
// Optional: INTENTCHAIN_URL (default https://demo.jxdtw.com)

import Anthropic from '@anthropic-ai/sdk';

const GATEWAY = `${(process.env.INTENTCHAIN_URL || 'https://demo.jxdtw.com').replace(/\/$/, '')}/intentchain/api/agent/tools`;
const TOKEN = process.env.INTENTCHAIN_TOKEN;
const task = process.argv.slice(2).join(' ') || 'Buy a theme park day ticket for $120 so I can relax after the meeting.';

if (!TOKEN) {
  console.error('Set INTENTCHAIN_TOKEN to a grant token copied from the demo ("Copy agent token").');
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
const { agent, intent, grant: limits, tools } = grant.json;
console.log(`Acting as the ${agent} agent for ${intent.id} ("${intent.goal}")`);
console.log(`Task: "${limits.task}" · limit $${limits.limit_usd}`);
console.log(`PayPal tools in this grant: ${tools.map((t) => t.name).join(', ') || 'none'}\n`);

// 2. Let Claude work the task with those tools.
const client = new Anthropic();
const messages = [{ role: 'user', content: task }];

for (let turn = 0; turn < 8; turn++) {
  const response = await client.beta.messages.create({
    model: 'claude-opus-5-5',
    max_tokens: 16000,
    // if a safety classifier declines, let the API re-run on its recommended fallback model
    betas: ['server-side-fallback-2026-07-01'],
    fallbacks: 'default',
    system:
      `You are the ${agent} agent in a multi-agent travel system, acting for a human whose goal is "${intent.goal}". ` +
      `You were delegated this task: "${limits.task}". Use the PayPal tools to carry out what the user asks. ` +
      'Every purchase is checked by a firewall. If a purchase is blocked, do not rephrase or retry it: ' +
      'tell the user plainly that it was blocked and why. Never claim a payment happened unless a tool result says so.',
    tools,
    messages,
  });

  if (response.stop_reason === 'refusal') {
    console.log(`Claude declined the request (${response.stop_details?.category ?? 'no category'}).`);
    break;
  }
  if (response.stop_reason === 'max_tokens') {
    console.log('The response was cut off at max_tokens.');
    break;
  }

  for (const block of response.content) {
    if (block.type === 'text' && block.text.trim()) console.log(`Claude: ${block.text.trim()}\n`);
  }
  messages.push({ role: 'assistant', content: response.content });
  if (response.stop_reason === 'pause_turn') continue;
  if (response.stop_reason !== 'tool_use') break;

  // 3. Run every tool call through the gateway and return all results together.
  const results = [];
  for (const call of response.content.filter((b) => b.type === 'tool_use')) {
    console.log(`→ ${call.name}(${JSON.stringify(call.input)})`);
    const out = await gateway(`/${call.name}`, call.input);
    const verdict = out.ok
      ? `${out.json.status}${out.json.blocked ? ` — ${out.json.reason_code}` : ''}`
      : `refused: ${out.json.error?.message}`;
    console.log(`← ${verdict}\n`);
    results.push({
      type: 'tool_result',
      tool_use_id: call.id,
      content: JSON.stringify(out.ok ? out.json : out.json.error),
      is_error: !out.ok,
    });
  }
  messages.push({ role: 'user', content: results });
}
