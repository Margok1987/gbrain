/**
 * #5856: atom extraction of connector `email` and `meeting` pages is opt-in.
 * While `cycle.extract_atoms.connector_pages` is off (the default), atom
 * discovery and the backlog count skip those pages of Google and GitHub
 * connector sources, so no routine cycle, drain or autopilot auto-drain sends
 * their bodies to the chat model. Other page types of a connector source, and
 * every page of a checkout-backed source, are unaffected.
 */
import type { BrainEngine } from '../engine.ts';
import { CONNECTOR_SOURCE_KINDS } from '../persistence/connector-identity.ts';

export const CONNECTOR_ATOM_PAGES_KEY = 'cycle.extract_atoms.connector_pages';
export const CONNECTOR_ATOM_PAGE_TYPES = ['email', 'meeting'] as const;

export async function connectorAtomPagesEnabled(engine: BrainEngine): Promise<boolean> {
  return /^(true|1|on|yes)$/i.test((await engine.getConfig(CONNECTOR_ATOM_PAGES_KEY).catch(() => null)) ?? '');
}

/** The discovery/backlog predicate over `pages p`: empty when opted in, else the connector email/meeting exclusion. */
export async function connectorAtomExclusionSql(engine: BrainEngine): Promise<string> {
  if (await connectorAtomPagesEnabled(engine)) return '';
  const list = (values: readonly string[]) => values.map(v => `'${v}'`).join(',');
  return `AND NOT (p.type IN (${list(CONNECTOR_ATOM_PAGE_TYPES)}) AND EXISTS (SELECT 1 FROM sources cs
        WHERE cs.id = p.source_id AND cs.config->>'kind' IN (${list(CONNECTOR_SOURCE_KINDS)})))`;
}
