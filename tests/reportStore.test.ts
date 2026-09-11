import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ReportStore } from '../src/reportStore.js';
import type { PairedRunReport } from '../src/types.js';

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true }))); });

function report(id: string): PairedRunReport {
  return { version: 1, id, mode: 'live', state: 'COMPLETED', prompt: 'x', failFirstFraud: false, createdAt: new Date().toISOString(), completedAt: new Date().toISOString(), seedVersion: 'seed', model: 'model', contextLimit: 128_000, verified: true, replayable: true, conversation: [], comparisonIntegrity: 'comparable', lanes: {}, parityAssertions: [], events: [] };
}

describe('ReportStore', () => {
  it('writes readable reports atomically and enforces retention', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'fabric-reports-')); directories.push(directory);
    const store = new ReportStore(directory, 2);
    await store.save(report('one'));
    await new Promise(resolve => setTimeout(resolve, 5));
    await store.save(report('two'));
    await new Promise(resolve => setTimeout(resolve, 5));
    await store.save(report('three'));
    expect(await store.get('three')).toMatchObject({ id: 'three', verified: true });
    expect((await store.list()).map(item => item.id)).toEqual(['three', 'two']);
    expect(await store.get('one')).toBeUndefined();
  });
});
