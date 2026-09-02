import { afterEach, describe, expect, test } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { WorkspaceStore } from './store';

let directory = '';
afterEach(async () => { if (directory) await fs.rm(directory, { recursive: true, force: true }); });

describe('workspace persistence', () => {
  test('persists an imported project after reopening the store', async () => {
    directory = await fs.mkdtemp(path.join(os.tmpdir(), 'signature-workspace-'));
    const store = new WorkspaceStore(directory);
    await store.initialize();
    await store.saveProject({ id: 'p1', name: '星河IPO项目', status: 'data_preparing' });
    const reopened = new WorkspaceStore(directory);
    expect(await reopened.getProject()).toMatchObject({ id: 'p1', name: '星河IPO项目' });
  });
});
