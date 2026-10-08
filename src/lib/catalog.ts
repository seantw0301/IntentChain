import type { CatalogItem, Category, Intent } from './types';

// Fixed demo inventory. Real product search is out of scope for the demo; the
// validator and the PayPal flow are what is being demonstrated.

export const ITEMS: Record<string, CatalogItem> = {
  esim: {
    id: 'esim',
    name: 'Japan eSIM — 5 GB / 7 days',
    merchant: 'Nippon Connect',
    description: 'Mobile data for the trip',
    amount: 18,
    category: 'connectivity',
    location: 'Tokyo',
    day_offset: 0,
    reference_score: 96,
  },
  'luxury-hotel': {
    id: 'luxury-hotel',
    name: 'Luxury Hotel — Imperial Suite',
    merchant: 'Grand Sakura Palace',
    description: '3 nights, suite with spa access',
    amount: 780,
    category: 'lodging',
    location: 'Tokyo',
    day_offset: 0,
    nights: 3,
    reference_score: 58,
  },
  'theme-park': {
    id: 'theme-park',
    name: 'Tokyo Theme Park — 1-Day Ticket',
    merchant: 'Tokyo Theme Park',
    description: 'Full-day admission',
    amount: 120,
    category: 'entertainment',
    location: 'Tokyo',
    day_offset: 1,
    reference_score: 21,
  },
  'dinner-cruise': {
    id: 'dinner-cruise',
    name: 'Tokyo Bay Sunset Dinner Cruise',
    merchant: 'Tokyo Bay Cruises',
    description: 'Evening sightseeing cruise with dinner, one guest',
    amount: 95,
    category: 'meals',
    location: 'Tokyo',
    day_offset: 1,
    reference_score: 18,
  },
  'hotel-a': {
    id: 'hotel-a',
    name: 'Hotel A — Bayside Inn',
    merchant: 'Bayside Inn',
    description: '3 nights, standard room',
    amount: 420,
    category: 'lodging',
    location: 'Tokyo',
    day_offset: 0,
    nights: 3,
    reference_score: 81,
  },
  'hotel-b': {
    id: 'hotel-b',
    name: 'Hotel B — Central Business Hotel',
    merchant: 'Central Business Hotel',
    description: '3 nights, standard room',
    amount: 486,
    category: 'lodging',
    location: 'Tokyo',
    day_offset: 0,
    nights: 3,
    reference_score: 94,
  },
  'hotel-c': {
    id: 'hotel-c',
    name: 'Hotel C — Station Budget Stay',
    merchant: 'Station Budget Stay',
    description: '3 nights, standard room',
    amount: 390,
    category: 'lodging',
    location: 'Tokyo',
    day_offset: 0,
    nights: 3,
    reference_score: 84,
  },
  'hotel-d': {
    id: 'hotel-d',
    name: 'Hotel D — Riverside Business Hotel',
    merchant: 'Riverside Business Hotel',
    description: '3 nights, standard room',
    amount: 474,
    category: 'lodging',
    location: 'Tokyo',
    day_offset: 0,
    nights: 3,
    reference_score: 93,
  },
  'usb-adapter': {
    id: 'usb-adapter',
    name: 'USB-C Multiport Adapters (3-pack)',
    merchant: 'Office Supply Co',
    description: 'Laptop adapters for the three new hires',
    amount: 49,
    category: 'office',
    location: 'Office',
    day_offset: 0,
    reference_score: 92,
  },
  'gaming-gpu': {
    id: 'gaming-gpu',
    name: 'Gaming Graphics Card',
    merchant: 'PC Parts Outlet',
    description: 'High-end GPU',
    amount: 799,
    category: 'gaming',
    location: 'Office',
    day_offset: 0,
    reference_score: 5,
  },
  'airport-transfer': {
    id: 'airport-transfer',
    name: 'Airport Transfer — Private Car',
    merchant: 'Tokyo Airport Cars',
    description: 'Airport to hotel, one way',
    amount: 110,
    category: 'transport',
    location: 'Tokyo',
    day_offset: 0,
    reference_score: 88,
  },
};

export const HOTEL_OPTIONS = [
  { id: 'hotel-a', minutes_to_meeting: 40, refundable: true },
  { id: 'hotel-b', minutes_to_meeting: 8, refundable: true },
  { id: 'hotel-c', minutes_to_meeting: 10, refundable: false },
];

export const RECOVERY_OPTION = { id: 'hotel-d', minutes_to_meeting: 12, refundable: true };

export const CATEGORIES: Category[] = [
  'lodging',
  'connectivity',
  'transport',
  'meals',
  'office',
  'entertainment',
  'subscription',
  'gaming',
  'other',
];

const BUSINESS_DEFAULT: Record<Category, number> = {
  lodging: 90,
  connectivity: 92,
  transport: 86,
  meals: 66,
  office: 68,
  entertainment: 20,
  subscription: 15,
  gaming: 5,
  other: 60,
};

const LEISURE_DEFAULT: Record<Category, number> = {
  lodging: 90,
  connectivity: 88,
  transport: 86,
  meals: 85,
  office: 40,
  entertainment: 91,
  subscription: 25,
  gaming: 30,
  other: 60,
};

/** Reference alignment score, used only when the live AI is unavailable. */
export function referenceScore(intent: Intent, item: CatalogItem): number {
  // an office purchase request is served by office supplies and little else
  if (intent.kind === 'procurement') return item.reference_score ?? (item.category === 'office' ? 85 : 15);
  if (intent.purpose === 'business') return item.reference_score ?? BUSINESS_DEFAULT[item.category];
  return LEISURE_DEFAULT[item.category];
}

export function referenceReason(intent: Intent, item: CatalogItem, score: number): string {
  const trip = intent.kind === 'procurement' ? `the request (${intent.purpose_detail})` : `a ${intent.purpose} trip (${intent.purpose_detail})`;
  if (score >= 65) return `${cap(item.category)} directly supports ${trip}.`;
  if (score >= 40) return `${cap(item.category)} is only loosely related to ${trip}.`;
  return `${cap(item.category)} does not serve ${trip}.`;
}

function cap(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
