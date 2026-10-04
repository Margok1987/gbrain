import type { Migration } from './types.ts';

// Applied by src/core/migrate.ts on the next initSchema(); see docs/ENGINES.md
// ("Canonical schema sources") for when schema.sql or a TS fragment also changes.
//
// Speaker attribution: who asserted a saved fact ('user', 'assistant' or a
// named 'other' party), written by the conversation-facts extractor when
// `facts.attribution` is on. NULL means attribution is unavailable (older
// facts, non-conversation text) and is compatible with either speaker in
// every dedup path. Nullable with no default: metadata-only on Postgres 11+
// and PGLite, no backfill. The facts table is created by migrations only
// (v045), so there is no schema.sql mirror.
export const v201: Migration = {
  version: 201,
  name: 'facts_attributed_to',
  idempotent: true,
  sql: `
    ALTER TABLE facts ADD COLUMN IF NOT EXISTS attributed_to TEXT
      CHECK (attributed_to IN ('user', 'assistant', 'other'));
  `,
};
