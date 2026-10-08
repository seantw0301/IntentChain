// A tool-calling LLM for agents that plan for themselves. Any OpenAI-compatible
// chat-completions endpoint works; it is configured by environment and is
// optional — without it the agents fall back to their fixed workflows.

export interface ToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

export type ChatMessage =
  | { role: 'system' | 'user'; content: string }
  | { role: 'assistant'; content: string | null; tool_calls?: ToolCall[] }
  | { role: 'tool'; tool_call_id: string; content: string };

export interface ToolSpec {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

export function llmModel(): string | null {
  return process.env.LLM_BASE_URL && process.env.LLM_API_KEY ? process.env.LLM_MODEL || 'opus' : null;
}

/** One turn: the model either answers in text or asks for tool calls. */
export async function chat(messages: ChatMessage[], tools: ToolSpec[]): Promise<{ content: string; tool_calls: ToolCall[] }> {
  const res = await fetch(`${(process.env.LLM_BASE_URL as string).replace(/\/$/, '')}/chat/completions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${process.env.LLM_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: llmModel(),
      max_tokens: 1500,
      messages,
      tools: tools.map((t) => ({
        type: 'function',
        function: { name: t.name, description: t.description, parameters: t.input_schema },
      })),
    }),
    signal: AbortSignal.timeout(Number(process.env.LLM_TIMEOUT || 75) * 1000),
  });
  if (!res.ok) throw new Error(`The agent model responded ${res.status}`);
  const json = (await res.json()) as { choices?: { message?: { content?: string | null; tool_calls?: ToolCall[] } }[] };
  const message = json.choices?.[0]?.message;
  if (!message) throw new Error('The agent model returned no message.');
  return { content: (message.content ?? '').trim(), tool_calls: message.tool_calls ?? [] };
}
