/**
 * hub-dampening.ts — degree-aware weight for graph-derived ranking boosts.
 *
 * WHY. A page linked from thousands of other pages (the owner's own page, a
 * company every meeting mentions) collects graph boosts merely for being
 * popular: the backlink boost grows with ln(1 + inbound) and the adjacency /
 * cross-source signals fire whenever several top-K pages link to it, which a
 * hub satisfies by chance. The Cat 13 E1 receipt (metadata-boost-gate.ts)
 * measured exactly that intrusion. Hub dampening scales each graph boost's
 * EXCESS over 1.0 by
 *
 *     hubWeight(n, H) = 1 / (1 + ((n - 1) / H)^2)
 *
 * where n is the page's caller-visible inbound degree and H is the half
 * degree: the degree at which the boost is halved. n <= 1 keeps the full
 * boost; n = H + 1 halves it; n = 3H + 1 keeps 10%. Parameterising by H (a
 * degree, not a bare coefficient c = 1/H^2) keeps the knob readable.
 *
 * Measured degree shape the candidate H values come from: a 285k-article
 * wiki-linked corpus has inbound p50 5, p90 93, p95 193, p99 607, max 35,681
 * (the top 1% of pages receive 25% of links); the shipped eval corpora top out
 * at 12. The eval tries H in {32, 100, 200, 600} against "boost removed" and
 * "boost capped" controls; `off` (no dampening) is the default until a sealed
 * held-out verdict sets it.
 *
 * Shared API (P7's relational planner imports `hubWeight`): pure, no IO.
 * Parse contract in ONE place: `normalizeHubDampening` (per-call opts and the
 * `search.hub_dampening` config key both route through it).
 */

/** `off` = no dampening; a positive number = the half degree H. */
export type HubDampening = 'off' | number;

/** Default until the held-out eval verdict sets one (D3: build with features off). */
export const DEFAULT_HUB_DAMPENING: HubDampening = 'off';

/** Inclusive bounds for a numeric half degree. */
export const HUB_HALF_DEGREE_MIN = 1;
export const HUB_HALF_DEGREE_MAX = 1_000_000;

/**
 * Weight in (0, 1] for a node with `degree` links. `halfDegree` undefined,
 * `off`, or invalid → 1 (no dampening). Non-finite or negative degrees are
 * treated as 0.
 */
export function hubWeight(degree: number, halfDegree: HubDampening | undefined): number {
  if (typeof halfDegree !== 'number' || !Number.isFinite(halfDegree) || halfDegree <= 0) return 1;
  const n = Number.isFinite(degree) && degree > 1 ? degree : 1;
  const x = (n - 1) / halfDegree;
  return 1 / (1 + x * x);
}

/**
 * Scale a multiplicative boost's excess by the hub weight:
 * `1 + (factor - 1) * hubWeight(degree, H)`. A factor <= 1 (a demotion) is
 * returned unchanged — dampening only shrinks lifts.
 */
export function dampenBoost(factor: number, degree: number, halfDegree: HubDampening | undefined): number {
  if (!(factor > 1)) return factor;
  return 1 + (factor - 1) * hubWeight(degree, halfDegree);
}

/**
 * The ONE parse contract for `search.hub_dampening` and the per-call seam:
 *   - `off` / `none` / `false` (any case)           → 'off'
 *   - finite number (or numeric string) in [1, 1e6] → that number
 *   - anything else (0, negatives, NaN, garbage)     → undefined (unset: fall
 *     through to the next resolution tier — config → bundle)
 */
export function normalizeHubDampening(v: unknown): HubDampening | undefined {
  if (typeof v === 'string') {
    const lit = v.trim().toLowerCase();
    if (lit === 'off' || lit === 'none' || lit === 'false') return 'off';
    if (lit === '') return undefined;
    return normalizeHubDampening(Number(lit));
  }
  if (v === false) return 'off';
  if (typeof v === 'number' && Number.isFinite(v) && v >= HUB_HALF_DEGREE_MIN && v <= HUB_HALF_DEGREE_MAX) return v;
  return undefined;
}

/** knobsHash part value: `off` or the half degree with fixed precision. */
export function hubDampeningHashPart(v: HubDampening | undefined): string {
  return typeof v === 'number' ? v.toFixed(3) : 'off';
}

/** Per-search observability stamp (`HybridSearchMeta.hub_dampening`). */
export interface HubDampeningMeta {
  /** The resolved half degree, or `off`. */
  half_degree: HubDampening;
  /** Results whose backlink boost was reduced. */
  backlink_dampened: number;
  /** Results whose adjacency or cross-source boost was reduced. */
  graph_dampened: number;
  /** True when the degree read failed and boosts ran undampened. */
  errored: boolean;
}
