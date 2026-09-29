/**
 * Ambient recall (v0.45.7) — template + doc content pins.
 *
 * The context_pack/delta verbs only deliver value if the shipped guidance
 * points agents at them. These pins keep the three guidance surfaces from
 * silently dropping the boundary instructions (the rendered template-repo copy
 * is byte-diffed against the generator by scripts/check-bootstrap-templates.sh):
 *   - HEARTBEAT.md.template carries the ambient-delta row (heartbeats pull
 *     `gbrain delta`; session start / post-compaction pairs with
 *     `gbrain context-pack`)
 *   - docs/mcp/CODEX.md names context_pack for the session boundary (Codex
 *     has no lifecycle hooks — the pull path is the only path)
 *   - docs/guides/ambient-recall.md exists and names both verbs
 *
 * Assertions pin stable substrings (verb + command names), not full sentences.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';

const ROOT = dirname(import.meta.dir);

function read(rel: string): string {
  return readFileSync(join(ROOT, rel), 'utf8');
}

describe('HEARTBEAT ambient-delta row', () => {
  test('source template points heartbeats at gbrain delta + context-pack', () => {
    const tpl = read('templates/bootstrap/HEARTBEAT.md.template');
    expect(tpl).toContain('ambient-delta');
    expect(tpl).toContain('gbrain delta');
    expect(tpl).toContain('gbrain context-pack');
    expect(tpl).toContain('docs/guides/ambient-recall.md');
  });

});

describe('docs surfaces', () => {
  test('CODEX.md session-boundary instruction names both verbs (pull path)', () => {
    const codex = read('docs/mcp/CODEX.md');
    expect(codex).toContain('context_pack');
    expect(codex).toContain('delta');
    // Codex has no lifecycle hooks, so the doc must route boundary calls to
    // the guide's placement frontier.
    expect(codex).toContain('ambient-recall.md');
  });

  test('ambient-recall guide exists and names both verbs', () => {
    expect(existsSync(join(ROOT, 'docs/guides/ambient-recall.md'))).toBe(true);
    const guide = read('docs/guides/ambient-recall.md');
    expect(guide).toContain('context_pack');
    expect(guide).toContain('delta');
  });
});
