/**
 * #5856: atom extraction of connector email/meeting pages is opt-in
 * (`cycle.extract_atoms.connector_pages`, default off). Discovery and the
 * backlog count agree, scoped and brain-wide; checkout-backed sources and
 * other connector page types are unaffected.
 */
import { afterAll, beforeAll, beforeEach, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { countExtractAtomsBacklog, discoverExtractablePages } from '../src/core/cycle/extract-atoms.ts';
const CONNECTOR_ATOM_PAGES_KEY = 'cycle.extract_atoms.connector_pages';

let engine: PGLiteEngine;
beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
});
afterAll(async () => { await engine.disconnect(); });
beforeEach(async () => {
  await engine.executeRaw('DELETE FROM pages');
  await engine.executeRaw("DELETE FROM sources WHERE id <> 'default'");
  await engine.executeRaw('DELETE FROM config WHERE key=$1', [CONNECTOR_ATOM_PAGES_KEY]);
  await engine.executeRaw("INSERT INTO sources(id,name,config) VALUES('gmail','gmail',jsonb_build_object('kind','google'))");
  await engine.executeRaw("INSERT INTO sources(id,name,local_path) VALUES('notes','notes','/tmp/gbrain-connector-atom-notes')");
  const prose = (n: string) => `A durable decision about ${n}, recorded in prose with context. `.repeat(12);
  await engine.putPage('emails/thread-1', { type: 'email', title: 'Thread 1', compiled_truth: prose('thread 1') } as never, { sourceId: 'gmail' });
  await engine.putPage('calendar/standup', { type: 'meeting', title: 'Standup', compiled_truth: prose('standup') } as never, { sourceId: 'gmail' });
  await engine.putPage('notes/connector-note', { type: 'note', title: 'Note', compiled_truth: prose('connector note') } as never, { sourceId: 'gmail' });
  await engine.putPage('emails/forwarded', { type: 'email', title: 'Forwarded', compiled_truth: prose('forwarded') } as never, { sourceId: 'notes' });
});

const slugs = async (sourceId: string) => (await discoverExtractablePages(engine, sourceId)).map(p => p.slug).sort();

test('off by default: connector email and meeting pages are neither discovered nor counted', async () => {
  expect(await slugs('gmail')).toEqual(['notes/connector-note']);
  expect(await countExtractAtomsBacklog(engine, 'gmail')).toBe(1);
  expect(await slugs('notes')).toEqual(['emails/forwarded']);
  expect(await countExtractAtomsBacklog(engine, 'notes')).toBe(1);
  expect(await countExtractAtomsBacklog(engine)).toBe(2);
});

test('opted in: connector email and meeting pages are discovered and counted', async () => {
  await engine.setConfig(CONNECTOR_ATOM_PAGES_KEY, 'true');
  expect(await slugs('gmail')).toEqual(['calendar/standup', 'emails/thread-1', 'notes/connector-note']);
  expect(await countExtractAtomsBacklog(engine, 'gmail')).toBe(3);
  expect(await countExtractAtomsBacklog(engine)).toBe(4);
  await engine.setConfig(CONNECTOR_ATOM_PAGES_KEY, 'false');
  expect(await countExtractAtomsBacklog(engine, 'gmail')).toBe(1);
});
