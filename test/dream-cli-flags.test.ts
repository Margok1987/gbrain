/**
 * Structural tests for `gbrain dream` argv parsing (v0.21).
 *
 * Verifies the help text + parser source contains the new flags
 * (--input, --date, --from, --to) and that conflict detection is wired.
 * The actual parseArgs is internal; we exercise it via the source file
 * structure to avoid spinning up a process per test.
 */

import { describe, test, expect } from 'bun:test';
import { readFileSync } from 'fs';

const dreamSrc = readFileSync(new URL('../src/commands/dream.ts', import.meta.url), 'utf-8');

describe('dream CLI flag wiring', () => {
  test('declares --input flag with file argument', () => {
    expect(dreamSrc).toContain("'--input'");
    expect(dreamSrc).toContain('inputFile');
  });

  test('declares --date / --from / --to flags', () => {
    expect(dreamSrc).toContain("'--date'");
    expect(dreamSrc).toContain("'--from'");
    expect(dreamSrc).toContain("'--to'");
  });

  test('validates ISO date format', () => {
    expect(dreamSrc).toMatch(/ISO_DATE_RE/);
    expect(dreamSrc).toContain('YYYY-MM-DD');
  });

  test('--input + --date conflict detection', () => {
    expect(dreamSrc).toContain('--input cannot be combined with --date');
  });

  test('--input implies --phase synthesize', () => {
    // #4493: phase became the phases[] array (repeated --phase flags all run).
    expect(dreamSrc).toContain("phases = ['synthesize']");
  });

  test('--from > --to range validation', () => {
    expect(dreamSrc).toContain('empty range');
  });

  test('forwards synth fields to runCycle', () => {
    expect(dreamSrc).toContain('synthInputFile');
    expect(dreamSrc).toContain('synthDate');
    expect(dreamSrc).toContain('synthFrom');
    expect(dreamSrc).toContain('synthTo');
  });

  test('totals line includes synth + patterns counters', () => {
    expect(dreamSrc).toContain('synth_transcripts');
    expect(dreamSrc).toContain('synth_pages');
    expect(dreamSrc).toContain('patterns=');
  });

  test('help text documents dry-run synthesis semantics (Codex finding #8)', () => {
    expect(dreamSrc).toContain('skips the synthesis subagents');
    expect(dreamSrc.toLowerCase()).toContain('zero llm calls');
  });

  test('help text documents local-day cycle timezone configuration (#4348)', () => {
    expect(dreamSrc).toContain('gbrain config set cycle.timezone Asia/Kolkata');
    expect(dreamSrc).toContain('host timezone');
  });

  // issue #1678 — --drain bounded backlog drain wiring (structural).
  describe('--drain wiring', () => {
    test('declares --drain and --window flags', () => {
      expect(dreamSrc).toContain("'--drain'");
      expect(dreamSrc).toContain("'--window'");
      expect(dreamSrc).toContain('windowSeconds');
    });

    test('--drain defaults to extract_atoms and rejects other phases', () => {
      // #4493: phase became the phases[] array (repeated --phase flags all run).
      expect(dreamSrc).toContain("phases = ['extract_atoms']");
      expect(dreamSrc).toContain('--drain currently supports only --phase extract_atoms');
    });

    test('drain routes through the shared helper with the resolved source (5A)', () => {
      // v0.42.10.0 (#1685 GAP D / 5A): the lock+batch+count wiring moved into
      // runExtractAtomsDrainForSource so the CLI, the Minion handler, and
      // autopilot share ONE drain path. dream threads resolvedSourceId so the
      // helper picks cycleLockIdFor(resolvedSourceId) — the same lock the routine
      // cycle holds for that source. The lock-id contract is now pinned in
      // test/extract-atoms-drain.test.ts ("shared wiring helper holds the cycle lock").
      expect(dreamSrc).toContain('runExtractAtomsDrainForSource');
      expect(dreamSrc).toContain('sourceId: resolvedSourceId');
    });

    test('drain reports remaining + exits non-zero when incomplete', () => {
      expect(dreamSrc).toContain('EXIT_DRAIN_INCOMPLETE');
      expect(dreamSrc).toContain('cycle_already_running');
    });
  });

});
