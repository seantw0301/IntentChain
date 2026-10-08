import { emit } from './audit';
import { CATEGORIES } from './catalog';
import { get, put } from './db';
import { ApiError } from './types';
import type { CatalogItem, Category, Check, CompanyPolicy } from './types';

// The company policy is the owner's side of the bargain: which kinds of
// purchase agents may make, how much a trip may cost, and how large a payment
// may be before a manager has to approve it. It is the root that every
// employee request and every delegation has to fit inside.

const POLICY_ID = 'company';

function defaults(): CompanyPolicy {
  return {
    id: POLICY_ID,
    company: 'Acme Studio',
    travel_budget: 800,
    hotel_limit: 500,
    auto_pay_limit: 150,
    allowed_categories: ['lodging', 'connectivity', 'transport', 'meals', 'office'],
    blocked_categories: ['entertainment', 'subscription', 'gaming'],
    created_at: new Date().toISOString(),
  };
}

export function getPolicy(session: string): CompanyPolicy {
  return get<CompanyPolicy>('policies', session, POLICY_ID) ?? defaults();
}

const money = (v: unknown, name: string, max: number): number => {
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0 || n > max) throw new ApiError(400, 'POLICY_INVALID', `${name} must be between 0 and ${max}.`);
  return Math.round(n * 100) / 100;
};

/** The owner edits the policy. Categories are either allowed or blocked, never both. */
export function updatePolicy(session: string, input: Record<string, unknown>): CompanyPolicy {
  const policy = getPolicy(session);
  if (input.auto_pay_limit !== undefined) policy.auto_pay_limit = money(input.auto_pay_limit, 'Auto-pay limit', 10000);
  if (input.travel_budget !== undefined) policy.travel_budget = money(input.travel_budget, 'Travel budget', 100000);
  if (input.hotel_limit !== undefined) policy.hotel_limit = money(input.hotel_limit, 'Hotel limit', 100000);
  if (typeof input.toggle === 'string') {
    const category = input.toggle as Category;
    if (!CATEGORIES.includes(category) || category === 'other') throw new ApiError(400, 'POLICY_INVALID', 'Unknown category.');
    const blocked = policy.blocked_categories.includes(category);
    policy.blocked_categories = policy.blocked_categories.filter((c) => c !== category);
    policy.allowed_categories = policy.allowed_categories.filter((c) => c !== category);
    (blocked ? policy.allowed_categories : policy.blocked_categories).push(category);
  }
  put('policies', session, policy);
  emit(session, 'policy.updated', 'owner', {}, {
    auto_pay_limit: policy.auto_pay_limit,
    allowed: policy.allowed_categories,
    blocked: policy.blocked_categories,
  });
  return policy;
}

/** Policy asks only one thing: is this kind of purchase allowed at this company? */
export function checkPolicy(policy: CompanyPolicy, item: CatalogItem): Check {
  if (policy.blocked_categories.includes(item.category)) {
    return { pass: false, detail: `${policy.company} blocks ${item.category} purchases` };
  }
  if (!policy.allowed_categories.includes(item.category)) {
    return { pass: false, detail: `${item.category} is not on ${policy.company}'s allowed list` };
  }
  return { pass: true, detail: `${item.category} is allowed by ${policy.company}` };
}
