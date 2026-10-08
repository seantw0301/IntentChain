import { emit } from './audit';
import { ITEMS } from './catalog';
import { reserveAiCall } from './db';
import { delegationFor } from './delegation';
import { callTool, toolsForGrant, type Grant } from './gateway';
import { activeIntent } from './intent';
import { chat, llmModel, type ChatMessage, type ToolSpec } from './llm';
import { getPolicy } from './policy';
import { ApiError } from './types';
import type { AgentRole, Category } from './types';

// An agent that plans for itself. The model reads its delegated task and the
// instruction, decides which tools to call, and reports back. It holds no
// PayPal access of its own: every tool call goes through the same gateway, and
// so the same firewall, that an outside agent would use.

export interface AgentStep {
  kind: 'say' | 'call' | 'result';
  text: string;
  tone?: 'pass' | 'block' | 'warn';
}

const SEARCH: ToolSpec = {
  name: 'search_options',
  description:
    'Search the supplier catalogue for purchasable options in one category. Returns option ids, names, descriptions and prices. ' +
    'To buy one, call create_order with its option_id.',
  input_schema: {
    type: 'object',
    properties: {
      category: {
        type: 'string',
        enum: ['lodging', 'connectivity', 'transport', 'meals', 'office', 'entertainment'],
        description: 'The kind of thing to look for.',
      },
    },
    required: ['category'],
    additionalProperties: false,
  },
};

function search(category: Category, location: string) {
  return Object.values(ITEMS)
    .filter((i) => i.category === category && i.location === location)
    .map((i) => ({ option_id: i.id, name: i.name, merchant: i.merchant, description: i.description, price_usd: i.amount }));
}

const MAX_TURNS = 6;

export async function runAgent(session: string, role: AgentRole, instruction: unknown, origin: string): Promise<AgentStep[]> {
  if (!llmModel()) throw new ApiError(503, 'AGENT_MODEL_OFF', 'No agent model is configured on this server.');
  const task = String(instruction ?? '').replace(/\s+/g, ' ').trim().slice(0, 300);
  if (task.length < 4) throw new ApiError(400, 'INSTRUCTION_REQUIRED', 'Tell the agent what to do.');
  const intent = activeIntent(session);
  const delegation = delegationFor(session, role);
  if (!delegation) throw new ApiError(409, 'NO_DELEGATION', 'That agent holds no grant yet.');
  const grant: Grant = { session, intent, delegation };
  const policy = getPolicy(session);
  const tools: ToolSpec[] = [SEARCH, ...toolsForGrant(grant)];

  const messages: ChatMessage[] = [
    {
      role: 'system',
      content:
        `You are the ${delegation.label} in a multi-agent system that makes purchases for ${policy.company}, a small business. ` +
        `The original request was: "${intent.prompt}". ` +
        `You were delegated this task: "${delegation.purpose}". Your spending limit is $${delegation.budget}. ` +
        `Company policy allows: ${policy.allowed_categories.join(', ')}. It blocks: ${policy.blocked_categories.join(', ')}. ` +
        'Work the task with your tools: search for options, pick one, and buy it with create_order using its option_id. ' +
        'Every purchase is checked by a firewall you cannot see. If a purchase comes back blocked, do not rephrase it or try another route: ' +
        'stop and report plainly that it was blocked and why. Never claim a payment happened unless a tool result says so. ' +
        'Keep every message to one or two short sentences. Before each tool call, say in one sentence what you are about to do and why.',
    },
    { role: 'user', content: task },
  ];
  const steps: AgentStep[] = [];

  for (let turn = 0; turn < MAX_TURNS; turn++) {
    if (!reserveAiCall(session)) {
      steps.push({ kind: 'say', text: 'This session has used its AI allowance. Reset the demo to continue.', tone: 'warn' });
      break;
    }
    const reply = await chat(messages, tools);
    // the transcript is shown as plain text
    if (reply.content) steps.push({ kind: 'say', text: reply.content.replace(/\*\*/g, '').slice(0, 600) });
    messages.push({ role: 'assistant', content: reply.content || null, tool_calls: reply.tool_calls.length ? reply.tool_calls : undefined });
    if (!reply.tool_calls.length) break;

    for (const call of reply.tool_calls) {
      let input: Record<string, unknown> = {};
      try {
        input = JSON.parse(call.function.arguments || '{}') as Record<string, unknown>;
      } catch {
        // leave input empty; the tool will reject it
      }
      steps.push({ kind: 'call', text: `${call.function.name}(${JSON.stringify(input)})` });
      let output: unknown;
      let summary: string;
      let tone: AgentStep['tone'];
      try {
        if (call.function.name === 'search_options') {
          const found = search(String(input.category) as Category, intent.location);
          output = { options: found };
          summary = found.length ? found.map((o) => `${o.name} $${o.price_usd}`).join(' · ') : 'no options';
        } else {
          const out = await callTool(grant, call.function.name, input, origin);
          output = out;
          tone = out.blocked ? 'block' : out.needs_human_review || out.status === 'ORDER_CREATED' ? 'warn' : 'pass';
          summary = out.blocked
            ? `BLOCKED — ${out.reason_code.replace(/_/g, ' ').toLowerCase()}: ${out.explanation}`
            : `${out.status.replace(/_/g, ' ')}${out.payment_route ? ` (${out.payment_route.replace(/_/g, ' ').toLowerCase()})` : ''}`;
        }
      } catch (err) {
        const message = err instanceof ApiError ? err.message : 'The tool failed.';
        output = { error: message };
        summary = `refused — ${message}`;
        tone = 'block';
      }
      steps.push({ kind: 'result', text: summary, tone });
      messages.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify(output) });
    }
  }

  emit(session, 'agent.run', `${role}-agent`, { intent_id: intent.id }, {
    agent: delegation.label,
    instruction: task,
    model: llmModel(),
    steps,
  });
  return steps;
}
