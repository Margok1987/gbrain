/**
 * SKILL check group: retrieval reflex, volunteer channels, memory verbs, and skill conformance / brain-first / manifest / currency / preconditions.
 *
 * Doctor registry entry module (refactor wave 1, W4 doctor). Each run*(ctx)
 * function holds one block of the former `buildChecks` body, moved
 * verbatim; the check order and the check-name categories are owned by
 * src/commands/doctor/registry.ts and src/core/doctor-categories.ts.
 */

import {
  skillConformanceCheck,
  skillBrainFirstCheck,
  skillsManifestIntegrityCheck,
  skillCurrencyCheck,
  skillPreconditionsCheck,
} from '../skill-checks.ts';
import { checkVolunteerChannels } from './core-health.ts';
import { buildRetrievalReflexCheck, buildMemoryVerbsCheck } from './verbs-reflex.ts';
import type { Check } from '../../doctor.ts';
import type { DoctorContext } from '../context.ts';

export async function runRetrievalReflex(ctx: DoctorContext): Promise<Check[]> {
  const { engine, fastMode, scope, skillsDir } = ctx;
  const checks: Check[] = [];

  // 1b. Retrieval Reflex health (#1981, SKILL group — gated). Truthful runtime
  // status: the deterministic pointer layer is on by default; the heartbeat file
  // (written by the context engine when it actually injects) is the authority for
  // "is it firing". The doctor cannot see the OpenClaw host capability directly,
  // so it never claims "enabled via host"; it reports observed activity instead.
  if (scope === 'all') {
    checks.push(buildRetrievalReflexCheck(skillsDir));
  }

  // 1b-2. Per-channel push-context visibility (the hook lane's feedback
  // loop). Engine-aware sibling of the reflex heartbeat check above — the
  // LOCAL `gbrain doctor` is the primary operator surface for this, so it
  // runs here as well as on the remote report path. Skipped in fs-only mode.
  if (scope === 'all' && engine && !fastMode) {
    checks.push(await checkVolunteerChannels(engine));
  }

  // 1c. MEMORY_VERBS v1 usage sidecar health (Cathedral 1, E4). Read-only,
  // fail-open: reports whether the local JSONL sidecar is present + parseable
  // and when a verb last fired. Local file only — never uploaded.
  if (scope === 'all') {
    checks.push(await buildMemoryVerbsCheck());
  }
  return checks;
}

export async function runSkillConformance(ctx: DoctorContext): Promise<Check[]> {
  const { engine, scope, skillsDir } = ctx;
  const checks: Check[] = [];

  // 2. Skill conformance (SKILL group — gated)
  if (scope === 'all' && skillsDir) {
    const conformanceResult = skillConformanceCheck(skillsDir);
    checks.push(conformanceResult);
  }

  // 2b. Skill brain-first compliance (v0.36.x, supersedes PR #1206).
  // Scans every SKILL.md for external-lookup tools (web_search, exa,
  // perplexity, etc.) and warns when the skill doesn't declare
  // `brain_first: exempt` AND doesn't carry a canonical Convention
  // callout / Phase 1 brain heading / position-relative brain-first
  // reference. Motivated by the 2026-05-19 tweet-shield incident.
  //
  // Audit trail: snapshot+diff at ~/.gbrain/audit/skill-brain-first-
  // snapshot.json. Writes one detected/resolved JSONL line per state
  // transition + one fixed line per applied --fix. Stable brain → zero
  // audit writes per doctor run.
  //
  // SKILL group — gated.
  if (scope === 'all' && skillsDir) {
    checks.push(skillBrainFirstCheck(skillsDir));
  }

  // 2c. Skills manifest integrity (#159): tamper-evidence, not signatures.
  // Compares the skills tree against its committed skills.lock.json and
  // WARNS on drift — never fails, never blocks. No manifest (e.g. a user
  // workspace skills dir, or a compiled binary far from the repo) → ok/skip.
  // SKILL group — gated.
  if (scope === 'all' && skillsDir) {
    checks.push(skillsManifestIntegrityCheck(skillsDir));
  }

  // 2c-bis. Skill currency (new built-in skills available downstream) +
  // live precondition verification for installed skills that declare
  // `requires:`. Currency is filesystem-only; preconditions need the engine
  // and skip cleanly without one.
  if (scope === 'all' && skillsDir) {
    checks.push(skillCurrencyCheck(skillsDir));
    checks.push(await skillPreconditionsCheck(skillsDir, engine));
  }
  return checks;
}
