#!/usr/bin/env bun
/**
 * SyncRun state guard (refactor wave 1, W4 sync, A17;
 * docs/TESTING.md#syncrun-state-guard).
 *
 * `SyncRun` (src/commands/sync/sync-run.ts) holds the mutable state one
 * incremental sync shares between closures that interleave across awaits
 * (checkpoint flush, import workers, stall watchdog, partial exit). A local
 * copy of a mutable field is a snapshot another closure can invalidate at the
 * next await, which is how a stale `checkpointDead` or `bankedFiles` would
 * reach a result. So over src/commands/sync/**\/*.ts this guard fails on:
 *   1. destructuring a mutable field from a SyncRun value
 *      (`const { bankedFiles } = run`, or a `{ bankedFiles }: SyncRun` parameter)
 *   2. aliasing one (`const banked = run.bankedFiles`)
 * Mutable fields are the non-`readonly` properties of `interface SyncRun`;
 * readonly fields (collection references, fixed config) may be destructured.
 * A SyncRun value is a variable or parameter annotated `SyncRun` or
 * initialized from `createSyncRun(...)`, or any binding named `run`.
 *
 * Seam: GBRAIN_GUARD_ROOT (fixture root).
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import ts from 'typescript';

const ROOT = process.env.GBRAIN_GUARD_ROOT ?? join(import.meta.dir, '..');
const DIR = 'src/commands/sync';
const TYPE_FILE = `${DIR}/sync-run.ts`;
const SEE = 'docs/TESTING.md#syncrun-state-guard';

function listTs(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).sort().flatMap((e) => {
    const full = join(dir, e);
    if (statSync(full).isDirectory()) return listTs(full);
    return e.endsWith('.ts') ? [full] : [];
  });
}

const parse = (file: string) => ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);

function mutableFields(): Set<string> | null {
  const file = join(ROOT, TYPE_FILE);
  if (!existsSync(file)) return null;
  const sf = parse(file);
  const decl = sf.statements.find((s): s is ts.InterfaceDeclaration => ts.isInterfaceDeclaration(s) && s.name.text === 'SyncRun');
  if (!decl) return null;
  const out = new Set<string>();
  for (const m of decl.members) {
    if (!ts.isPropertySignature(m) || !m.name) continue;
    const readonly = m.modifiers?.some((mod) => mod.kind === ts.SyntaxKind.ReadonlyKeyword);
    if (!readonly) out.add(m.name.getText(sf));
  }
  return out;
}

function isSyncRunType(t: ts.TypeNode | undefined): boolean {
  return !!t && ts.isTypeReferenceNode(t) && t.typeName.getText() === 'SyncRun';
}
function isCreateCall(e: ts.Expression | undefined): boolean {
  return !!e && ts.isCallExpression(e) && ts.isIdentifier(e.expression) && e.expression.text === 'createSyncRun';
}

const fields = mutableFields();
const problems: string[] = [];
if (!fields) {
  problems.push(`FAIL: ${TYPE_FILE}:1 interface SyncRun not found`);
} else {
  for (const file of listTs(join(ROOT, DIR))) {
    const rel = relative(ROOT, file);
    const sf = parse(file);
    const runNames = new Set<string>(['run']);
    const collect = (n: ts.Node) => {
      if ((ts.isVariableDeclaration(n) || ts.isParameter(n)) && ts.isIdentifier(n.name)) {
        if (isSyncRunType(n.type) || (ts.isVariableDeclaration(n) && isCreateCall(n.initializer))) runNames.add(n.name.text);
      }
      ts.forEachChild(n, collect);
    };
    collect(sf);
    const isRunExpr = (e: ts.Expression | undefined) => !!e && ts.isIdentifier(e) && runNames.has(e.text);
    const at = (n: ts.Node) => `${rel}:${sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1}`;
    const checkPattern = (p: ts.ObjectBindingPattern) => {
      for (const el of p.elements) {
        const key = (el.propertyName ?? el.name).getText(sf);
        if (fields.has(key)) problems.push(`FAIL: ${at(el)} destructures mutable SyncRun field '${key}'`);
      }
    };
    const visit = (n: ts.Node) => {
      if (ts.isVariableDeclaration(n)) {
        if (ts.isObjectBindingPattern(n.name) && (isRunExpr(n.initializer) || isSyncRunType(n.type) || isCreateCall(n.initializer))) checkPattern(n.name);
        const init = n.initializer;
        if (init && ts.isPropertyAccessExpression(init) && isRunExpr(init.expression) && fields.has(init.name.text)) {
          problems.push(`FAIL: ${at(n)} copies mutable SyncRun field '${init.name.text}' into '${n.name.getText(sf)}'`);
        }
      }
      if (ts.isParameter(n) && ts.isObjectBindingPattern(n.name) && isSyncRunType(n.type)) checkPattern(n.name);
      ts.forEachChild(n, visit);
    };
    visit(sf);
  }
}

if (problems.length > 0) {
  for (const p of problems) console.log(p);
  console.log('Why:  SyncRun fields change across awaits (checkpoint flush, workers, stall watchdog); a local copy goes stale.');
  console.log('Fix:  read and write the field as run.<field> at each use; declare it `readonly` in SyncRun only if it is never reassigned.');
  console.log(`See:  ${SEE}`);
  process.exit(1);
}
console.log(`OK: SyncRun mutable fields accessed only as run.<field> (${fields!.size} fields, ${listTs(join(ROOT, DIR)).length} files).`);
