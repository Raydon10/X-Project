import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  createVariable,
  deleteVariable,
  listVariables,
  updateVariable,
  VariableStore,
} from '../src/variables.mjs';

async function withStore(run) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'variable-module-'));
  try {
    const store = new VariableStore(directory);
    await store.initialize();
    await run(store);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
}

test('creates a single variable and rejects duplicate variable values', async () => {
  await withStore(async (store) => {
    const variable = await createVariable(store, {
      name: '公司名称',
      value: 'companyName',
      type: 'single',
      description: '签字页公司字段',
    });

    assert.equal(variable.value, 'companyName');
    assert.equal(variable.changeLogs.length, 1);

    await assert.rejects(
      () => createVariable(store, { name: '重复公司名称', value: 'companyName', type: 'single' }),
      /变量值不可重复/,
    );
  });
});

test('creates an enum variable without predefined enum options', async () => {
  await withStore(async (store) => {
    const variable = await createVariable(store, { name: '自然人股东', value: 'naturalPersonShareholder', type: 'enum' });

    assert.equal(variable.type, 'enum');
    assert.equal(variable.isMultiple, true);
  });
});

test('updates a variable and appends a readable change log', async () => {
  await withStore(async (store) => {
    await createVariable(store, { name: '自然人股东', value: 'naturalPersonShareholder', type: 'single' });
    const updated = await updateVariable(store, 'naturalPersonShareholder', {
      type: 'enum',
      description: '可录入多个自然人股东并生成多份签字页',
    });

    assert.equal(updated.type, 'enum');
    assert.equal(updated.isMultiple, true);
    assert.equal(updated.changeLogs.length, 2);
    assert.match(updated.changeLogs[1].summary, /变量类型/);
  });
});

test('deletes a variable from the list and records deletion in audit logs', async () => {
  await withStore(async (store) => {
    await createVariable(store, { name: '会议日期', value: 'meetingDate', type: 'single' });
    await deleteVariable(store, 'meetingDate');

    assert.deepEqual(await listVariables(store), []);
    const logs = await store.readAuditLogs();
    assert.equal(logs.at(-1).action, 'DELETE_VARIABLE');
    assert.equal(logs.at(-1).resourceValue, 'meetingDate');
  });
});
