/**
 * S9 `conflict` dataset adapter and the `facts-fixtures` builder.
 *
 * The adapter builds the production request shape: state = the new fact
 * (class `facts`), one `choice` question per candidate (duplicate | supersede
 * | independent). Conflict is not a harmful-direction slot (v1 only writes
 * proposals), so it has no harmful-action reducer.
 *
 * `gbrain decide dataset --slot conflict --from facts-fixtures <path>` reads
 * labelled fact pairs, one JSON object per line:
 *   {"id":"p1","family":"alice-example-role","fact":"<new fact>","candidate":"<older fact>",
 *    "label":"duplicate"|"supersede"|"independent","slice"?:"<name>"}
 * `family` defaults to `id` (pairs sharing a new fact should share a family
 * so they pack together). The calibrated number is the duplicate threshold,
 * so the dataset label is `true` exactly for `duplicate`; the choice label is
 * kept as the slice unless one is given.
 */
import { conflictQuestion } from './conflict.ts';
import { registerDatasetAdapter, registerDatasetBuilder, stableSplit, type DatasetItem } from './dataset.ts';

export const CONFLICT_LABELS = ['duplicate', 'supersede', 'independent'] as const;

/** Registers the conflict adapter and the facts-fixtures builder (called by the write-path lane module). */
export function registerConflictDatasets(): void {
  registerDatasetAdapter({
    slot: 'conflict',
    callSite: 'sweep',
    request(family) {
      const itemFor: Record<string, DatasetItem> = {};
      const questions = family.map((it, i) => {
        const id = `conflict:${i}`;
        itemFor[id] = it;
        return conflictQuestion(id, it.rank ?? i, { id: i + 1, source_id: 'dataset', fact: it.inputs.candidate ?? '', visibility: 'world' });
      });
      const fact = family[0]?.state.fact ?? '';
      return { state: { fact: { text: fact, class: 'facts', fact_id: 0, source_id: 'dataset', visibility: 'world' } }, questions, itemFor };
    },
  });
  registerDatasetBuilder('facts-fixtures', async (path, opts) => parseConflictPairs(await Bun.file(path).text(), opts));
}

export function parseConflictPairs(text: string, opts: { calibrateShare?: number } = {}): DatasetItem[] {
  const ranks = new Map<string, number>();
  return text.split('\n').flatMap((line, n) => {
    if (!line.trim()) return [];
    let raw: Record<string, unknown>;
    try { raw = JSON.parse(line); } catch { throw new Error(`facts-fixtures line ${n + 1}: not JSON`); }
    const { id, fact, candidate, label } = raw;
    if (typeof id !== 'string' || typeof fact !== 'string' || typeof candidate !== 'string') throw new Error(`facts-fixtures line ${n + 1}: id, fact and candidate are required strings`);
    if (!(CONFLICT_LABELS as readonly unknown[]).includes(label)) throw new Error(`facts-fixtures line ${n + 1}: label must be one of ${CONFLICT_LABELS.join(', ')}`);
    const family = typeof raw.family === 'string' ? raw.family : id;
    const rank = ranks.get(family) ?? 0;
    ranks.set(family, rank + 1);
    return [{
      id, family, slot: 'conflict' as const, split: stableSplit(family, opts.calibrateShare), slice: typeof raw.slice === 'string' ? raw.slice : String(label),
      state: { fact }, inputs: { candidate }, label: label === 'duplicate', rank,
    }];
  });
}

