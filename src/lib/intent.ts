import { emit } from './audit';
import { get, list, put } from './db';
import { buildChain } from './delegation';
import { asChoice, ask } from './jev';
import { getPolicy } from './policy';
import { addDays } from './validator';
import { ApiError } from './types';
import type { Delegation, Intent, Restriction } from './types';

const CITIES = ['Tokyo', 'Osaka', 'Kyoto', 'Seoul', 'Singapore', 'London', 'Paris', 'New York'];

interface Extracted {
  kind: 'travel' | 'procurement';
  goal: string;
  purpose: 'business' | 'leisure';
  purpose_detail: string;
  location: string;
  budget: number;
}

function parseAmount(text: string): number | null {
  const m = text.match(/(?:US\$|\$)\s*([\d,]+(?:\.\d+)?)|([\d,]+(?:\.\d+)?)\s*(?:usd|dollars?)/i);
  const raw = m?.[1] ?? m?.[2];
  if (!raw) return null;
  const n = Number(raw.replace(/,/g, ''));
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** Deterministic fallback used when the AI is offline. */
function extractByRules(prompt: string): Extracted | null {
  const budget = parseAmount(prompt);
  if (!budget) return null;
  // buying things for the office, with no travel involved
  if (/\b(order|buy|purchase|restock|procure\w*|suppl\w+|adapters?|keyboards?|monitors?|equipment)\b/i.test(prompt) && !/\b(trip|travel\w*|hotel|flight)\b/i.test(prompt)) {
    return { kind: 'procurement', goal: 'Office procurement', purpose: 'business', purpose_detail: 'Equipment for the team', location: 'Office', budget };
  }
  const location = CITIES.find((c) => new RegExp(`\\b${c}\\b`, 'i').test(prompt)) ?? 'Tokyo';
  const business = /\b(business|client|meeting|conference|work)\b/i.test(prompt);
  const detail = /client meeting/i.test(prompt) ? 'Client meeting' : business ? 'Business travel' : 'Leisure travel';
  return {
    kind: 'travel',
    goal: `${location} ${business ? 'business' : 'leisure'} trip`,
    purpose: business ? 'business' : 'leisure',
    purpose_detail: detail,
    location,
    budget,
  };
}

const PURPOSES: Record<string, { type: 'business' | 'leisure'; label: string; when: string; procurement?: boolean }> = {
  office_purchase: { type: 'business', label: 'Equipment for the team', when: 'Not a trip: buying equipment or supplies for the office or team.', procurement: true },
  client_meeting: { type: 'business', label: 'Client meeting', when: 'Meeting a client or customer.' },
  conference: { type: 'business', label: 'Conference', when: 'Attending a conference, trade show or training.' },
  business_other: { type: 'business', label: 'Business travel', when: 'Other work travel.' },
  holiday: { type: 'leisure', label: 'Holiday', when: 'Vacation, sightseeing or a family holiday.' },
  personal_other: { type: 'leisure', label: 'Personal travel', when: 'Other personal travel, such as visiting friends.' },
};

/**
 * The AI classifies what the trip is for and where it goes. Amounts are never
 * taken from the AI: the budget is always parsed from the text by rule.
 */
async function extractByAi(session: string, prompt: string, budget: number): Promise<Extracted | null> {
  const answers = await ask(
    session,
    { request: prompt },
    {
      purpose: {
        type: 'choice',
        instructions: 'What is `request` for?',
        criteria: Object.fromEntries(Object.entries(PURPOSES).map(([k, v]) => [k, v.when])),
      },
      city: {
        type: 'choice',
        instructions: 'Which city is the trip in `request` to?',
        criteria: {
          ...Object.fromEntries(CITIES.map((c) => [c, `The trip is to ${c}.`])),
          unknown: 'Another city, or no city is stated.',
        },
      },
    },
  );
  const purpose = PURPOSES[asChoice(answers?.purpose)?.choice ?? ''];
  const city = asChoice(answers?.city)?.choice;
  if (!purpose || !city) return null; // fails structural validation → fall back to rules
  if (purpose.procurement) {
    return { kind: 'procurement', goal: 'Office procurement', purpose: 'business', purpose_detail: purpose.label, location: 'Office', budget };
  }
  const location = city === 'unknown' ? 'Tokyo' : city;
  return {
    kind: 'travel',
    goal: `${location} ${purpose.type} trip`,
    purpose: purpose.type,
    purpose_detail: purpose.label,
    location,
    budget,
  };
}

/** What the requester sees as limits: the company's blocked categories. */
function restrictionsFrom(blocked: string[]): Restriction[] {
  return blocked.map((c) => ({ label: `No ${c}`, category: c as Restriction['category'] }));
}

/** Tuesday of next week, so "next week" always resolves to a real date. */
function nextWeekTuesday(): string {
  const today = new Date().toISOString().slice(0, 10);
  const dow = new Date(`${today}T00:00:00.000Z`).getUTCDay(); // 0 = Sunday
  const daysToNextMonday = ((8 - dow) % 7) || 7;
  return addDays(today, daysToNextMonday + 1);
}

export async function createIntent(session: string, prompt: string): Promise<Intent> {
  const text = prompt.trim();
  if (text.length < 8) throw new ApiError(400, 'PROMPT_TOO_SHORT', 'Describe what is needed and the budget.');
  if (text.length > 600) throw new ApiError(400, 'PROMPT_TOO_LONG', 'Keep the request under 600 characters.');
  if (list<Intent>('intents', session).some((i) => i.status === 'ACTIVE')) {
    throw new ApiError(409, 'INTENT_ACTIVE', 'An intent is already active. Reset the demo to start again.');
  }

  const byRules = extractByRules(text);
  if (!byRules) {
    throw new ApiError(422, 'BUDGET_MISSING', 'No budget found. Include a total budget, e.g. "Total budget: $600".');
  }
  const fromAi = await extractByAi(session, text, byRules.budget);
  const extracted = fromAi ?? byRules;
  // the request must fit inside the company policy, the same way every grant must fit inside its parent
  const policy = getPolicy(session);
  const procurement = extracted.kind === 'procurement';
  const ceiling = procurement ? policy.procurement_budget : policy.travel_budget;
  if (extracted.budget > ceiling) {
    throw new ApiError(
      422,
      'OVER_COMPANY_BUDGET',
      `${policy.company} allows up to $${ceiling} per ${procurement ? 'purchase request' : 'trip'}. This request asks for $${extracted.budget}.`,
    );
  }

  const today = new Date().toISOString().slice(0, 10);
  const nights = procurement ? 0 : 3;
  // a trip is next week; an office order must arrive within two weeks
  const trip_start = procurement ? today : nextWeekTuesday();
  const intent: Intent = {
    id: procurement ? 'PROC-001' : 'TRIP-001',
    status: 'DRAFT',
    prompt: text,
    ...extracted,
    currency: 'USD',
    category_caps: procurement
      ? { office: extracted.budget }
      : {
          // lodging is capped by the company hotel limit and by 5/6 of this trip's budget; connectivity at $40
          lodging: Math.min(policy.hotel_limit, Math.round((extracted.budget * 5) / 6)),
          connectivity: Math.min(40, extracted.budget),
        },
    restrictions: restrictionsFrom(policy.blocked_categories),
    trip_start,
    trip_end: addDays(trip_start, procurement ? 14 : nights),
    nights,
    source: fromAi ? 'jev' : 'cached',
    created_at: new Date().toISOString(),
  };
  put('intents', session, intent);
  emit(session, 'intent.created', 'human', { intent_id: intent.id }, {
    goal: intent.goal,
    budget: intent.budget,
    source: intent.source,
  });
  return intent;
}

/** The human confirms the structured intent; only then is authority delegated. */
export async function confirmIntent(session: string, id: string): Promise<{ intent: Intent; delegations: Delegation[] }> {
  const intent = get<Intent>('intents', session, id);
  if (!intent) throw new ApiError(404, 'INTENT_NOT_FOUND', 'Intent not found.');
  if (intent.status === 'ACTIVE') {
    return { intent, delegations: list<Delegation>('delegations', session) };
  }
  intent.status = 'ACTIVE';
  put('intents', session, intent);
  emit(session, 'intent.confirmed', 'human', { intent_id: intent.id }, {});
  return { intent, delegations: await buildChain(session, intent) };
}

export function activeIntent(session: string): Intent {
  const intent = list<Intent>('intents', session).find((i) => i.status === 'ACTIVE');
  if (!intent) throw new ApiError(409, 'NO_ACTIVE_INTENT', 'Create and confirm an intent first.');
  return intent;
}
