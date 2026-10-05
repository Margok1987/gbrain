/**
 * Dated evidence blocks (C1, `search.evidence_date_header`): the one-line
 * date header evidence delivery puts at the top of every delivered block, and
 * the day formatter it shares with think's page dates.
 *
 * Header grammar (fixed, one line, parsed by agents and eval harnesses):
 *
 *   page block:  [observed 2026-03-05]
 *   fact:        [observed unknown; valid 2026-03-01 to unknown]
 *
 * Each date is YYYY-MM-DD or the literal `unknown`. `observed` is when the
 * source text was written or said (date grounding's observation time,
 * #6020): the page's filename/slug date,
 * frontmatter `date`, `published` or a created key, in effective-date
 * precedence with `event_date` removed. An event date is when something
 * happened, not when the note was written, and row timestamps are when GBrain
 * stored it, so neither is ever shown as observed. Facts carry no observation
 * date on master, so a fact's `observed` is `unknown` and its validity window
 * (`valid_from` to `valid_until`, an open end shown as `unknown`) follows.
 *
 * Seam: `pageObservationDate` mirrors `resolveObservationDate` from
 * src/core/ai/date-grounding.ts (#6020); once that lands, call it here
 * instead. `formatBrainDay` is the rendering rule think's `<page date>`
 * attribute uses, so both surfaces print the same day.
 */
import { computeEffectiveDate, isValidTimeZone } from '../effective-date.ts';

export const EVIDENCE_DATE_HEADER_KEY = 'search.evidence_date_header';
export const UNKNOWN_DATE = 'unknown';

const OBSERVATION_SOURCES = new Set(['filename', 'date', 'published', 'created']);

/**
 * YYYY-MM-DD for a stored instant: exactly midnight UTC is a day-only date
 * and renders as written; any other instant renders in `timeZone`
 * (`brain.timezone`; UTC when unset or invalid). Null for a missing or
 * invalid value.
 */
export function formatBrainDay(value: Date | string | null | undefined, timeZone?: string | null): string | null {
  if (value === null || value === undefined || value === '') return null;
  const d = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(d.getTime())) return null;
  const iso = d.toISOString();
  if (iso.endsWith('T00:00:00.000Z')) return iso.slice(0, 10);
  const zone = timeZone && isValidTimeZone(timeZone) ? timeZone : 'UTC';
  return new Intl.DateTimeFormat('en-CA', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
}

/** When the page's text was written or said; null when it states no such date. Never a row timestamp. */
export function pageObservationDate(page: {
  slug: string;
  frontmatter?: Record<string, unknown> | null;
  filename?: string | null;
  timeZone?: string | null;
}): Date | null {
  const { event_date: _eventDate, ...frontmatter } = page.frontmatter ?? {};
  const invalid = new Date(Number.NaN);
  const result = computeEffectiveDate({
    slug: page.slug,
    frontmatter,
    filename: page.filename ?? page.slug.split('/').pop() ?? null,
    timeZone: page.timeZone ?? undefined,
    createdAt: invalid,
    updatedAt: invalid,
  });
  return result.date && result.source && OBSERVATION_SOURCES.has(result.source) ? result.date : null;
}

export function pageDateHeader(observed: string | null): string {
  return `[observed ${observed ?? UNKNOWN_DATE}]`;
}

export function factDateHeader(
  fact: { valid_from?: Date | string | null; valid_until?: Date | string | null },
  timeZone?: string | null,
): string {
  const from = formatBrainDay(fact.valid_from, timeZone) ?? UNKNOWN_DATE;
  const until = formatBrainDay(fact.valid_until, timeZone) ?? UNKNOWN_DATE;
  return `[observed ${UNKNOWN_DATE}; valid ${from} to ${until}]`;
}

/**
 * The page header for each page id: one read of the stored frontmatter and
 * import filename (only the derived day leaves this function) plus
 * `brain.timezone`. Ids missing from the result render `unknown`.
 */
export async function loadPageDateHeaders(
  engine: { executeRaw<T>(sql: string, params?: unknown[]): Promise<T[]>; getConfig(key: string): Promise<string | null> },
  pageIds: number[],
): Promise<Map<number, string>> {
  const out = new Map<number, string>();
  const ids = [...new Set(pageIds.filter(id => Number.isInteger(id) && id > 0))];
  if (ids.length === 0) return out;
  const timeZone = (await engine.getConfig('brain.timezone').catch(() => null))?.trim() || null;
  const rows = await engine.executeRaw<{ id: number; slug: string; frontmatter: unknown; import_filename: string | null }>(
    'SELECT id, slug, frontmatter, import_filename FROM pages WHERE id = ANY($1::int[])', [ids]);
  for (const r of rows) {
    const fm = typeof r.frontmatter === 'string' ? JSON.parse(r.frontmatter) : r.frontmatter;
    const observed = pageObservationDate({ slug: String(r.slug), frontmatter: fm && typeof fm === 'object' ? fm as Record<string, unknown> : null, filename: r.import_filename, timeZone });
    out.set(Number(r.id), pageDateHeader(formatBrainDay(observed, timeZone)));
  }
  return out;
}

/** `recall` fact rows plus `date_header` when `search.evidence_date_header` is on; unchanged otherwise. */
export async function withFactDateHeaders<T extends { valid_from: string | null; valid_until: string | null }>(
  engine: { getConfig(key: string): Promise<string | null> },
  facts: T[],
): Promise<Array<T & { date_header?: string }>> {
  if (!await evidenceDateHeaderEnabled(engine)) return facts;
  const timeZone = (await engine.getConfig('brain.timezone').catch(() => null))?.trim() || null;
  return facts.map(f => ({ ...f, date_header: factDateHeader(f, timeZone) }));
}

/** `search.evidence_date_header` is on ('true' | 'on' | '1' | 'yes'); off by default and on any read error. */
export async function evidenceDateHeaderEnabled(engine: { getConfig(key: string): Promise<string | null> }): Promise<boolean> {
  try {
    const raw = (await engine.getConfig(EVIDENCE_DATE_HEADER_KEY))?.trim().toLowerCase();
    return raw === 'true' || raw === 'on' || raw === '1' || raw === 'yes';
  } catch {
    return false;
  }
}
