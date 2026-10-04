import type { BrainEngine } from '../engine.ts';
import type { ImportResult, ParsedPage } from '../import-file.ts';

/**
 * #6007: what an apply reports to its caller. `livePageId` is the page it
 * wrote, when the write left it live; `sealed` means sealing its text
 * projection was its last step that can change the page's revision, title or
 * timeline.
 */
export interface PreparedImportApplied { livePageId?: number; sealed: boolean }

/** Parsing/provider work is complete. apply must run under the coordinator's transaction. */
export interface PreparedContentImport {
  slug: string;
  parsedPage: ParsedPage;
  observedRevision: string | null;
  noop: boolean;
  result: ImportResult;
  validate(tx: BrainEngine): Promise<void>;
  apply(tx: BrainEngine): Promise<PreparedImportApplied | void>;
}
