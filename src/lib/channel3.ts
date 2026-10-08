import crypto from 'node:crypto';
import type { CatalogItem, Category } from './types';

// Live product search through Channel3 (https://trychannel3.com). When a key is
// configured, office purchases are sourced from real retailers instead of the
// built-in demo catalogue. Optional: without a key the catalogue is used.

const API = 'https://api.trychannel3.com/v1/search';

export function channel3Enabled(): boolean {
  return Boolean(process.env.CHANNEL3_API_KEY);
}

interface Offer {
  url: string;
  domain: string;
  price: { price: number; currency: string };
  availability: string;
}

interface Product {
  id: string;
  title: string;
  description?: string | null;
  brands?: { name: string }[];
  images?: { url: string; is_main_image?: boolean }[];
  offers?: Offer[];
}

// Search results are remembered briefly so that an agent can buy an option it
// just found by id. Prices and offer links go stale, so entries expire quickly.
const TTL_MS = 15 * 60 * 1000;
const found = new Map<string, { item: CatalogItem; at: number }>();

export function channel3Item(optionId: string): CatalogItem | null {
  const hit = found.get(optionId);
  if (!hit || Date.now() - hit.at > TTL_MS) return null;
  return hit.item;
}

/**
 * Searches real products. Each result becomes a purchasable option priced at
 * its cheapest in-stock USD offer. Returns [] on any failure — callers fall
 * back to the demo catalogue.
 */
export async function searchProducts(
  session: string,
  query: string,
  opts: { category: Category; location: string; maxPrice?: number; limit?: number },
): Promise<CatalogItem[]> {
  if (!channel3Enabled()) return [];
  try {
    const res = await fetch(API, {
      method: 'POST',
      headers: {
        'x-api-key': process.env.CHANNEL3_API_KEY as string,
        // attributes clicks to an anonymous per-session id, never to the session cookie itself
        'x-user-id': crypto.createHash('sha256').update(session).digest('hex').slice(0, 32),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        query: query.slice(0, 200),
        limit: Math.min(opts.limit ?? 5, 10),
        filters: opts.maxPrice ? { price: { max_price: opts.maxPrice } } : undefined,
        config: { country: 'US', currency: 'USD' },
      }),
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) {
      console.warn('[channel3] search responded', res.status);
      return [];
    }
    const { products = [] } = (await res.json()) as { products?: Product[] };
    const items: CatalogItem[] = [];
    for (const p of products) {
      const offer = (p.offers ?? [])
        .filter((o) => o.availability === 'InStock' && o.price?.currency === 'USD' && o.price.price > 0)
        .sort((a, b) => a.price.price - b.price.price)[0];
      if (!offer) continue;
      const image = (p.images ?? []).find((i) => i.is_main_image) ?? p.images?.[0];
      const item: CatalogItem = {
        id: `c3:${p.id}`,
        name: p.title.slice(0, 110),
        merchant: offer.domain,
        description: [p.brands?.[0]?.name, 'found with Channel3'].filter(Boolean).join(' · '),
        amount: Math.round(offer.price.price * 100) / 100,
        category: opts.category,
        location: opts.location,
        day_offset: 0,
        source: 'channel3',
        url: offer.url,
        image: image?.url,
      };
      found.set(item.id, { item, at: Date.now() });
      items.push(item);
    }
    // keep the memory bounded
    if (found.size > 2000) for (const [k, v] of found) if (Date.now() - v.at > TTL_MS) found.delete(k);
    return items;
  } catch (err) {
    console.warn('[channel3] search failed:', (err as Error).message);
    return [];
  }
}
