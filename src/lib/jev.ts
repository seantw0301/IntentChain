import { reserveAiCall } from './db';

// JEV (TypeSafe System One) client. The API takes a state object plus a set of
// named questions and returns one answer per question. It classifies and rates;
// it does not generate text. Three question types exist:
//   noul   — yes/no, answered with the probability of yes
//   choice — pick one of the named options, with per-option probabilities
//   score  — rate against an ordered rubric; the answer is the expected level

type Instructions = string | Record<string, unknown>;

export type JevQuestion =
  | { type: 'noul'; instructions: Instructions; criteria?: { true: string; false: string } }
  | { type: 'choice'; instructions: Instructions; criteria: Record<string, string> }
  | { type: 'score'; instructions: Instructions; criteria: string[] };

export interface JevChoice {
  choice: string;
  probabilities: Record<string, number>;
  confidence: number;
}

export function aiMode(): 'live' | 'cached' {
  return process.env.JEV_API_KEY ? 'live' : 'cached';
}

function timeoutMs(): number {
  const n = Number(process.env.JEV_TIMEOUT || 8);
  return (Number.isFinite(n) && n > 0 ? n : 8) * 1000;
}

async function post(body: unknown): Promise<Record<string, unknown>> {
  const res = await fetch(process.env.JEV_API_URL || 'https://api.typesafe.ai/v1/systemone', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.JEV_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs()),
  });
  if (!res.ok) throw new Error(`JEV responded ${res.status}`);
  const json = (await res.json()) as { answers?: Record<string, unknown> };
  return json.answers ?? {};
}

/**
 * Asks JEV a set of questions. Returns null when the AI is not configured, the
 * usage cap is reached, or the call fails twice — callers then fall back to
 * reference data and label the result as cached.
 */
export async function ask(
  session: string,
  state: Record<string, unknown>,
  questions: Record<string, JevQuestion>,
): Promise<Record<string, unknown> | null> {
  if (aiMode() !== 'live') return null;
  if (!reserveAiCall(session)) return null;
  const body = { state, model: process.env.JEV_MODEL || 'jev-latest', questions };
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      return await post(body);
    } catch (err) {
      if (attempt === 1) console.warn('[jev] falling back to cached data:', (err as Error).message);
    }
  }
  return null;
}

export function asChoice(answer: unknown): JevChoice | null {
  if (!answer || typeof answer !== 'object') return null;
  const a = answer as Record<string, unknown>;
  if (typeof a.choice !== 'string') return null;
  const probabilities: Record<string, number> = {};
  if (a.probabilities && typeof a.probabilities === 'object') {
    for (const [k, v] of Object.entries(a.probabilities as Record<string, unknown>)) {
      const n = Number(v);
      if (Number.isFinite(n)) probabilities[k] = n;
    }
  }
  const confidence = Number(a.confidence);
  return { choice: a.choice, probabilities, confidence: Number.isFinite(confidence) ? confidence : 0 };
}

/** A rubric answer scaled to 0–100, where 100 is the top rubric level. */
export function asScore(answer: unknown, levels: number): number | null {
  if (!answer || typeof answer !== 'object') return null;
  const n = Number((answer as Record<string, unknown>).score);
  if (!Number.isFinite(n) || levels < 2) return null;
  return Math.max(0, Math.min(100, Math.round((n / (levels - 1)) * 100)));
}

/** Probability of "yes" for a noul answer, 0–1. */
export function asNoul(answer: unknown): number | null {
  if (!answer || typeof answer !== 'object') return null;
  const n = Number((answer as Record<string, unknown>).noul);
  return Number.isFinite(n) ? n : null;
}
