import { emit } from './audit';
import { get, list, newId, put } from './db';
import { toolsFor } from './paypal';
import { ApiError } from './types';
import type { AgentRole, Category, Delegation, DelegationScope, Intent } from './types';

export interface DelegationRequest {
  parent: string; // 'human' or a delegation id
  agent: AgentRole;
  purpose: string;
  budget: number;
  category_caps?: Partial<Record<Category, number>>;
  per_night?: number;
  scope: DelegationScope;
  expires_at: string;
  single_use?: boolean;
}

/**
 * Monotonic delegation: a child grant must be a subset of its parent in every
 * dimension — amount, per-night rate, place, dates, categories and lifetime.
 * Returns the list of violations (empty when the grant is valid).
 */
export function monotonicViolations(parent: Delegation, req: DelegationRequest): string[] {
  const v: string[] = [];
  if (req.budget > parent.budget) {
    v.push(`Budget $${req.budget} exceeds the parent limit of $${parent.budget}.`);
  }
  if (parent.per_night !== undefined && (req.per_night === undefined || req.per_night > parent.per_night)) {
    v.push(`Per-night limit must stay at or below $${parent.per_night}.`);
  }
  if (req.scope.location !== parent.scope.location) {
    v.push(`Location "${req.scope.location}" is outside the parent scope "${parent.scope.location}".`);
  }
  if (req.scope.from < parent.scope.from || req.scope.to > parent.scope.to) {
    v.push('Dates extend beyond the parent scope.');
  }
  if (parent.scope.categories) {
    if (!req.scope.categories) {
      v.push(`Categories must stay within: ${parent.scope.categories.join(', ')}.`);
    } else {
      const extra = req.scope.categories.filter((c) => !parent.scope.categories!.includes(c));
      if (extra.length) v.push(`Categories not granted by the parent: ${extra.join(', ')}.`);
    }
  }
  if (req.expires_at > parent.expires_at) {
    v.push('Expiry is later than the parent expiry.');
  }
  if (parent.single_use) v.push('A single-use grant cannot be delegated further.');
  if (parent.status !== 'ACTIVE') v.push(`The parent grant is ${parent.status}.`);
  return v;
}

export function createDelegation(session: string, intent: Intent, req: DelegationRequest): Delegation {
  let from: Delegation['from'] = 'human';
  if (req.parent !== 'human') {
    const parent = get<Delegation>('delegations', session, req.parent);
    if (!parent) throw new ApiError(404, 'PARENT_NOT_FOUND', 'Parent delegation not found.');
    const violations = monotonicViolations(parent, req);
    if (violations.length) {
      emit(session, 'delegation.rejected', `${parent.agent}-agent`, { intent_id: intent.id }, {
        agent: req.agent,
        requested_budget: req.budget,
        parent_budget: parent.budget,
        violations,
      });
      throw new ApiError(422, 'MONOTONIC_VIOLATION', violations.join(' '));
    }
    from = parent.agent;
  } else if (req.budget > intent.budget) {
    throw new ApiError(422, 'MONOTONIC_VIOLATION', 'A grant cannot exceed the intent budget.');
  }
  const delegation: Delegation = {
    id: newId('del'),
    intent_id: intent.id,
    parent: req.parent,
    from,
    agent: req.agent,
    purpose: req.purpose,
    budget: req.budget,
    category_caps: req.category_caps,
    per_night: req.per_night,
    scope: req.scope,
    expires_at: req.expires_at,
    single_use: Boolean(req.single_use),
    status: 'ACTIVE',
    paypal_tools: toolsFor(req.agent),
    created_at: new Date().toISOString(),
  };
  put('delegations', session, delegation);
  emit(session, 'delegation.created', from === 'human' ? 'human' : `${from}-agent`, { intent_id: intent.id }, {
    agent: req.agent,
    budget: req.budget,
    per_night: req.per_night ?? null,
    expires_at: req.expires_at,
  });
  return delegation;
}

/** Builds the standard chain: Human → Travel → Hotel → Booking. */
export function buildChain(session: string, intent: Intent): Delegation[] {
  const lodging = intent.category_caps.lodging ?? intent.budget;
  const endOfTrip = `${intent.trip_end}T23:59:59.000Z`;
  const checkIn = `${intent.trip_start}T23:59:59.000Z`;
  const scope: DelegationScope = { location: intent.location, from: intent.trip_start, to: intent.trip_end };

  const travel = createDelegation(session, intent, {
    parent: 'human',
    agent: 'travel',
    purpose: `${intent.goal} — all trip purchases`,
    budget: intent.budget,
    category_caps: intent.category_caps,
    scope,
    expires_at: endOfTrip,
  });
  const hotel = createDelegation(session, intent, {
    parent: travel.id,
    agent: 'hotel',
    purpose: 'Find and compare hotels',
    budget: lodging,
    scope: { ...scope, categories: ['lodging'] },
    expires_at: checkIn,
  });
  const inThirtyMinutes = new Date(Date.now() + 30 * 60 * 1000).toISOString();
  const booking = createDelegation(session, intent, {
    parent: hotel.id,
    agent: 'booking',
    purpose: 'Book the selected hotel (one booking)',
    budget: lodging,
    per_night: Math.round(lodging * 0.36),
    scope: { ...scope, categories: ['lodging'] },
    expires_at: inThirtyMinutes < checkIn ? inThirtyMinutes : checkIn,
    single_use: true,
  });
  return [travel, hotel, booking];
}

export function delegationFor(session: string, agent: AgentRole): Delegation | null {
  return list<Delegation>('delegations', session).filter((d) => d.agent === agent).at(-1) ?? null;
}

/** The delegation itself plus every ancestor up to the human grant. */
export function chainOf(session: string, delegation: Delegation): Delegation[] {
  const chain = [delegation];
  let cursor = delegation;
  while (cursor.parent !== 'human') {
    const parent = get<Delegation>('delegations', session, cursor.parent);
    if (!parent) break;
    chain.push(parent);
    cursor = parent;
  }
  return chain;
}
