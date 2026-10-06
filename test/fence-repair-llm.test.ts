/**
 * #6188 PR4: Tier 3 fence repair, the model call (src/core/fence-repair/llm.ts).
 *
 * Protects: the model sees only the fence header and the residual rows a
 * row-level issue names (never the valid rows, never the rest of the page),
 * no tools and no fallback model; every failure class is distinct
 * (llm_unavailable, llm_empty, llm_refused, llm_malformed, llm_truncated) and
 * a truncated answer is rejected even when it parses; a wrong row count is a
 * gate (e) failure; the corrective re-ask carries the model's own answer plus
 * the gate letter and row numbers only; the splice rebuilds only the fence;
 * the prompt bytes are pinned (a change must bump FENCE_REPAIR_PROMPT_VERSION).
 * Fails when: valid rows or page prose leak into the prompt, a tool or a
 * fallback chain reaches the call, a refusal or truncation is treated as an
 * answer, or the re-ask quotes anything beyond its own answer.
 * Why new: the Tier 3 module is new in PR4.
 * Seams: the gateway's chat transport seam (__setChatTransportForTests).
 */
import { afterAll, afterEach, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { __setChatTransportForTests, configureGateway, resetGateway, type ChatOpts, type ChatResult } from '../src/core/ai/gateway.ts';
import { buildTier3Prompt, callTier3, correctionMessage, extractSingleTable, FENCE_REPAIR_PROMPT_VERSION, spliceTier3, tier3Requests } from '../src/core/fence-repair/llm.ts';
import { safeNormalizeFences } from '../src/core/fence-repair/normalize.ts';
import { validateFenceRepair } from '../src/core/fence-repair/validate.ts';

const FB = '<!--- gbrain:facts:begin -->', FBE = '<!--- gbrain:facts:end -->';
const FH = '| # | claim | kind | confidence | visibility | notability | valid_from | valid_until | source | context |\n|---|---|---|---|---|---|---|---|---|---|';
const NARROW = '| # | claim | kind | confidence | visibility | notability | valid_from | valid_until | source | context |';
const SEP = '|---|-------|------|------------|------------|------------|------------|-------------|--------|---------|';
const VALID = 'Validrowclaimzq9 stays private';
const PROSE = 'Pageproseqz9 is never sent';
const BROKEN = 'Brokenrowclaimzq9 ships';
/** One valid row and one row with an extra empty cell in the middle (extra_cells, row-level). */
const rowLevel = `${PROSE}\n\n${FB}\n${FH}\n| 1 | ${VALID} | fact | 0.9 | private | high | 2026-01-01 |  | chat | ctx |\n| 2 | ${BROKEN} |  | fact | 0.8 | private | low | 2026-02-01 |  | chat | ctx |\n${FBE}\n`;
/** A fence with rows but no header (no_header, fence-level). */
const noHeader = `${PROSE}\n\n${FB}\n| 1 | ${BROKEN} | fact | 0.9 | private | high | 2026-01-01 |  | chat | ctx |\n${FBE}\n`;

const result = (text: string, stopReason: ChatResult['stopReason'] = 'end'): ChatResult => ({ text, blocks: [], stopReason,
  usage: { input_tokens: 400, output_tokens: 80, cache_read_tokens: 0, cache_creation_tokens: 0 }, model: 'anthropic:claude-opus-4-7', providerId: 'anthropic' });

function stub(answers: Array<ChatResult | Error>) {
  const calls: ChatOpts[] = [];
  __setChatTransportForTests(async opts => {
    calls.push(opts);
    const next = answers.shift()!;
    if (next instanceof Error) throw next;
    return next;
  });
  return calls;
}

function residualOf(text: string) {
  const page = { compiled_truth: text, timeline: '' };
  const normalized = safeNormalizeFences(page, { pageVisibility: 'private' });
  return { page, normalized, ...tier3Requests(normalized.page, normalized.residual, 'private') };
}

afterEach(() => __setChatTransportForTests(null));
afterAll(() => resetGateway());

describe('Tier 3 requests and prompt', () => {
  test('a row-level issue sends the header and that row only; a fence-level issue sends every row; page prose never', () => {
    const row = residualOf(rowLevel);
    expect(row.normalized.residual.map(i => i.reason)).toEqual(['extra_cells']);
    expect(row.requests).toHaveLength(1);
    const req = row.requests[0]!;
    expect(req.rows.map(r => r.occurrence)).toEqual([1]);
    const prompt = buildTier3Prompt(req);
    const all = `${prompt.system}\n${prompt.user}`;
    expect(all).toContain(BROKEN);
    expect(all).not.toContain(VALID);
    expect(all).not.toContain(PROSE);
    expect(prompt.user).toContain('extra_cells: row(s) 2');
    const fence = residualOf(noHeader);
    expect(fence.requests[0]!.header).toBeNull();
    expect(fence.requests[0]!.rows).toHaveLength(1);
    expect(buildTier3Prompt(fence.requests[0]!).user).not.toContain(PROSE);
  });

  test('prompt bytes are pinned; a prompt change must bump FENCE_REPAIR_PROMPT_VERSION', () => {
    const prompt = buildTier3Prompt(residualOf(noHeader).requests[0]!);
    const digest = createHash('sha256').update(`${prompt.system}\u0000${prompt.user}`).digest('hex');
    expect({ version: FENCE_REPAIR_PROMPT_VERSION, digest }).toEqual({ version: 1, digest: PROMPT_DIGEST });
  });

  test('a fence with a stray text line inside is not eligible (rebuilding the table would drop it)', () => {
    const stray = `${FB}\n| 1 | ${BROKEN} | fact | 0.9 | private | high | 2026-01-01 |  | chat | ctx |\na stray note\n${FBE}\n`;
    const out = residualOf(stray);
    expect(out.requests).toEqual([]);
    expect(out.ineligible.map(i => i.why)).toEqual(['stray_lines']);
  });
});

describe('extracting the answer', () => {
  const req = { kind: 'facts' as const, layout: 'narrow' as const };
  test('a single table (optionally in one code fence) is accepted; prose, a wrong header or nothing is not', () => {
    expect(extractSingleTable(`${NARROW}\n${SEP}\n| 1 | x | fact | 1 | private | high |  |  |  |  |`, req)).toMatchObject({ ok: true });
    expect(extractSingleTable('```markdown\n' + `${NARROW}\n${SEP}\n| 1 | x | fact | 1 | private | high |  |  |  |  |` + '\n```', req)).toMatchObject({ ok: true });
    expect(extractSingleTable(`Here is the table:\n${NARROW}\n${SEP}\n| 1 | x |`, req)).toEqual({ ok: false, reason: 'llm_malformed' });
    expect(extractSingleTable('| # | claim | type |\n|---|---|---|\n| 1 | x | fact |', req)).toEqual({ ok: false, reason: 'llm_malformed' });
    expect(extractSingleTable('   ', req)).toEqual({ ok: false, reason: 'llm_empty' });
    expect(extractSingleTable("I can't help rewrite that table.", req)).toEqual({ ok: false, reason: 'llm_refused' });
  });
});

describe('the gateway call', () => {
  const realigned = `${NARROW}\n${SEP}\n| 2 | ${BROKEN} | fact | 0.8 | private | low | 2026-02-01 |  | chat | ctx |`;

  test('no tools, no fallback, the configured model; a realigned answer splices into a page that passes every gate', async () => {
    configureGateway({ chat_model: 'anthropic:claude-sonnet-4-6', chat_fallback_chain: ['openai:gpt-6-luna'] } as never);
    const calls = stub([result(realigned)]);
    const { page, normalized, requests } = residualOf(rowLevel);
    const answer = await callTier3(requests[0]!, { model: 'anthropic:claude-fable-5' });
    expect(answer.ok).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.tools).toBeUndefined();
    expect(calls[0]!.allowFallback).toBe(false);
    expect(calls[0]!.model).toBe('anthropic:claude-fable-5');
    expect(calls[0]!.thinking).toBe('off');
    const spliced = spliceTier3(normalized.page, requests[0]!, (answer as Extract<typeof answer, { ok: true }>).table)!;
    expect(spliced.compiled_truth.startsWith(`${PROSE}\n\n${FB}\n${NARROW}\n${SEP}\n| 1 | ${VALID} |`)).toBe(true);
    const final = safeNormalizeFences(spliced, { pageVisibility: 'private' });
    expect(final.residual).toEqual([]);
    expect(validateFenceRepair(page, final.page, { pageVisibility: 'private', tier: 'llm', issues: [...normalized.fixes, ...normalized.residual] })).toEqual({ ok: true });
  });

  test('each failure class is distinct; a truncated answer that parses is still rejected; a wrong row count is a gate (e) failure', async () => {
    const req = residualOf(rowLevel).requests[0]!;
    const cases: Array<[ChatResult | Error, string]> = [
      [Object.assign(new Error('rate limited'), { status: 429 }), 'llm_unavailable'],
      [result(''), 'llm_empty'],
      [result('', 'refusal'), 'llm_refused'],
      [result(realigned, 'content_filter'), 'llm_refused'],
      [result('Sure! I fixed it.'), 'llm_malformed'],
      [result(realigned, 'length'), 'llm_truncated'],
      [result(`${realigned}\n| 3 | Extra row | fact | 1 | private | high |  |  |  |  |`), 'row_count_changed'],
    ];
    for (const [answer, reason] of cases) expect(await reasonOf(req, answer)).toBe(reason);
  });

  test('the corrective re-ask repeats the model\'s own answer and names only the gate letter and rows', async () => {
    const req = residualOf(rowLevel).requests[0]!;
    const calls = stub([result(realigned)]);
    await callTier3(req, { model: 'anthropic:claude-opus-4-7', correction: { answer: 'PRIOR-ANSWER', gate: 'f', rows: [2] } });
    const messages = calls[0]!.messages;
    expect(messages.map(m => m.role)).toEqual(['user', 'assistant', 'user']);
    expect(messages[1]!.content).toBe('PRIOR-ANSWER');
    expect(messages[2]!.content).toBe(correctionMessage('f', [2]));
    expect(String(messages[2]!.content)).toBe("Your table was rejected by validation gate (f) cell_changed at row(s) 2: a cell's text changed, or a valid cell moved out of its column. Return the corrected full table following every rule above. Output only the table.");
  });
});

async function reasonOf(req: Parameters<typeof callTier3>[0], answer: ChatResult | Error): Promise<string> {
  stub([answer]);
  const out = await callTier3(req, { model: 'anthropic:claude-opus-4-7' });
  return out.ok ? 'ok' : out.reason;
}

const PROMPT_DIGEST = '9f3cf734abd6aac8b28ee094b226c4c654ab0e85e07a0c6aed6235eb97221114';
