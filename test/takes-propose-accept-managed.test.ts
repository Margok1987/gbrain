/**
 * #5764: `gbrain takes propose --accept` on a managed brain. The accept used
 * to promote through the uncoordinated addTakeToPage, which a managed
 * worktree refuses with writer_coordinator_required, so no pending proposal
 * could ever be accepted there. It now promotes through a coordinated
 * takes_add mutation: the fence row lands in the managed file and the DB,
 * and the proposal is stamped accepted.
 */
import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import { acceptProposal } from '../src/core/take-proposals.ts';
import { runTakes } from '../src/commands/takes.ts';
import { parseTakesFence } from '../src/core/takes-fence.ts';
import { managedBrain } from './helpers/managed-brain.ts';
import { put } from './helpers/wave-fixture.ts';
import { testBackends } from './helpers/test-backends.ts';

async function insertProposal(engine: BrainEngine, slug: string, claim: string): Promise<number> {
  const rows = await engine.executeRaw<{ id: number }>(
    `INSERT INTO take_proposals (source_id, page_slug, content_hash, prompt_version, proposal_run_id,
       claim_text, kind, holder, weight, domain, model_id, status)
     VALUES ('default', $1, md5($2), 'test-v1', 'run-test', $2, 'bet', 'world', 0.7, NULL, 'test-model', 'pending')
     RETURNING id`, [slug, claim]);
  return Number(rows[0]!.id);
}

async function proposalStatus(engine: BrainEngine, id: number) {
  const [row] = await engine.executeRaw<{ status: string; promoted_row_num: number | null }>(
    'SELECT status, promoted_row_num FROM take_proposals WHERE id = $1', [id]);
  return { status: row!.status, promoted_row_num: row!.promoted_row_num == null ? null : Number(row!.promoted_row_num) };
}

for (const backend of testBackends()) test(`${backend}: takes propose --accept promotes through the writer coordinator on a managed brain`, async () => {
  await managedBrain(async ({ engine, ctx, root }) => {
    const slug = 'companies/acme-example';
    await put(ctx, slug, 'About acme-example.', 'company');

    const direct = await insertProposal(engine, slug, 'Acme ships the widget by Q3');
    const { rowNum } = await acceptProposal({ engine, brainDir: root, sourceId: 'default', config: ctx.config }, direct);
    expect(rowNum).toBeGreaterThan(0);
    expect(await proposalStatus(engine, direct)).toEqual({ status: 'accepted', promoted_row_num: rowNum });

    const viaCli = await insertProposal(engine, slug, 'Acme doubles revenue next year');
    const lines: string[] = [];
    const log = console.log;
    console.log = (...parts: unknown[]) => { lines.push(parts.map(String).join(' ')); };
    try { await runTakes(engine, ['propose', '--accept', String(viaCli), '--dir', root]); } finally { console.log = log; }
    expect(lines.join('\n')).toContain(`Accepted proposal #${viaCli}`);
    expect((await proposalStatus(engine, viaCli)).status).toBe('accepted');

    const fence = parseTakesFence(readFileSync(join(root, `${slug}.md`), 'utf-8'));
    expect(fence.takes.map(t => t.claim)).toEqual(expect.arrayContaining(['Acme ships the widget by Q3', 'Acme doubles revenue next year']));
    const takes = await engine.executeRaw<{ claim: string }>(
      'SELECT t.claim FROM takes t JOIN pages p ON p.id = t.page_id WHERE p.slug = $1 ORDER BY t.row_num', [slug]);
    expect(takes.map(t => t.claim)).toEqual(['Acme ships the widget by Q3', 'Acme doubles revenue next year']);
  }, { databaseUrl: backend === 'postgres' ? process.env.DATABASE_URL : undefined });
}, 180_000);
