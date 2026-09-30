import type { Migration } from './types.ts';
import { DECIDE_RECEIPTS_SCHEMA_SQL } from '../ai/decide/schema.ts';

// System One decide: per-question decision receipts (hashes only, no text),
// the per-request spend ledger and internal decide state (receipt HMAC salt,
// sweep watermarks). DDL lives once in src/core/ai/decide/schema.ts, which is
// also the fresh-install fragment (scripts/build-schema.ts).
export const v179: Migration = {
  version: 179,
  name: 'decision_receipts',
  idempotent: true,
  sql: DECIDE_RECEIPTS_SCHEMA_SQL,
};
