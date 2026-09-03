import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { TemplateStore, createTemplate } from '../src/templates.mjs';
import { VariableStore, createVariable, listVariables } from '../src/variables.mjs';
import {
  ProjectStore,
  createProject, getProject, listProjects, updateProject, deleteProject,
  linkTemplates, unlinkTemplate,
  createGroup, listGroups, updateGroup, deleteGroup, getGroup,
  addTemplatesToGroup, removeTemplatesFromGroup,
  listValues, setValue, deleteValue,
  getProgress, getProgressByTemplate,
  renderSignaturePage, exportSingle, exportBatch,
} from '../src/projects.mjs';

async function withStores(run) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'project-module-'));
  // 累计计数器避免毫秒内 Date.now() 撞 id
  let counter = 0;
  const nextId = () => Date.now() * 1000 + (counter += 1);
  try {
    const projectStore = new ProjectStore(directory);
    const templateStore = new TemplateStore(directory);
    const variableStore = new VariableStore(directory);
    await projectStore.initialize();
    await templateStore.initialize();
    await variableStore.initialize();
    await run({ projectStore, templateStore, variableStore, nextId });
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
}

async function makeTemplate(templateStore, name, vars, nextId) {
  // 构造模板：previewHtml 含 {{var}} 占位，extractedVariables 含 value/name
  return createTemplate(templateStore, {
    id: nextId(),
    name,
    detail: name,
    previewText: vars.map((v) => `{{${v.value}}}`).join(' '),
    previewHtml: vars.map((v) => `<p>label: <span class="variable-chip" data-status="new" data-variable="${v.value}">{{${v.value}}}</span></p>`).join(''),
    extractedVariables: vars.map((v) => ({ name: v.name, value: v.value, valid: true, source: 'local' })),
  });
}

test('creates a project and lists it', async () => {
  await withStores(async ({ projectStore }) => {
    const project = await createProject(projectStore, { name: 'IPO项目', detail: '法律意见书' });
    assert.equal(project.name, 'IPO项目');
    assert.equal(project.templateIds.length, 0);

    const listed = await listProjects(projectStore);
    assert.equal(listed.length, 1);
    assert.equal(listed[0].id, project.id);

    const got = await getProject(projectStore, project.id);
    assert.equal(got.name, 'IPO项目');
  });
});

test('updates a project and keeps change log', async () => {
  await withStores(async ({ projectStore }) => {
    const project = await createProject(projectStore, { name: 'P1', detail: '' });
    const next = await updateProject(projectStore, project.id, { detail: '更新后详情' });
    assert.equal(next.detail, '更新后详情');
    assert.ok(next.changeLogs.length >= 2);
  });
});

test('links and unlinks templates', async () => {
  await withStores(async ({ projectStore, templateStore, nextId }) => {
    const t1 = await makeTemplate(templateStore, 'T1', [{ name: '公司', value: 'companyName' }], nextId);
    const t2 = await makeTemplate(templateStore, 'T2', [{ name: '日期', value: 'signDate' }], nextId);
    const project = await createProject(projectStore, { name: 'P', detail: '' });
    const linked = await linkTemplates(projectStore, project.id, [t1.id, t2.id]);
    assert.deepEqual(linked.templateIds.sort((a, b) => a - b), [t1.id, t2.id].sort((a, b) => a - b));
    // 重复挂接不重复
    const linked2 = await linkTemplates(projectStore, project.id, [t1.id]);
    assert.equal(linked2.templateIds.length, 2);
    // 取消挂接
    const after = await unlinkTemplate(projectStore, project.id, t1.id);
    assert.equal(after.templateIds.length, 1);
  });
});

test('creates groups with mutual exclusion of templates', async () => {
  await withStores(async ({ projectStore, templateStore, nextId }) => {
    const t1 = await makeTemplate(templateStore, 'T1', [{ name: '公司', value: 'companyName' }], nextId);
    const t2 = await makeTemplate(templateStore, 'T2', [{ name: '日期', value: 'signDate' }], nextId);
    const project = await createProject(projectStore, { name: 'P', detail: '' });
    await linkTemplates(projectStore, project.id, [t1.id, t2.id]);
    const g1 = await createGroup(projectStore, project.id, { name: '组1', templateIds: [t1.id] });
    const g2 = await createGroup(projectStore, project.id, { name: '组2', templateIds: [t2.id] });
    // t1 已在组1，再加入组2 应自动从组1移除
    await addTemplatesToGroup(projectStore, g2.id, [t1.id]);
    const g1Reloaded = await getGroup(projectStore, g1.id);
    assert.ok(!g1Reloaded.templateIds.includes(t1.id));
    const g2Reloaded = await getGroup(projectStore, g2.id);
    assert.ok(g2Reloaded.templateIds.includes(t1.id));
  });
});

test('cannot add templates not in project to group', async () => {
  await withStores(async ({ projectStore, templateStore, nextId }) => {
    const t1 = await makeTemplate(templateStore, 'T1', [{ name: '公司', value: 'companyName' }], nextId);
    const project = await createProject(projectStore, { name: 'P', detail: '' });
    await createGroup(projectStore, project.id, { name: '组1' });
    const groups = await listGroups(projectStore, project.id);
    await assert.rejects(
      () => addTemplatesToGroup(projectStore, groups[0].id, [t1.id]),
      /不在项目中/,
    );
  });
});

test('writing a group-level value syncs to all templates in the group', async () => {
  await withStores(async ({ projectStore, templateStore, nextId }) => {
    const t1 = await makeTemplate(templateStore, 'T1', [
      { name: '公司', value: 'companyName' },
      { name: '日期', value: 'signDate' },
    ], nextId);
    const t2 = await makeTemplate(templateStore, 'T2', [
      { name: '公司', value: 'companyName' },
      { name: '金额', value: 'amount' },
    ], nextId);
    const project = await createProject(projectStore, { name: 'P', detail: '' });
    await linkTemplates(projectStore, project.id, [t1.id, t2.id]);
    const group = await createGroup(projectStore, project.id, { name: '组1', templateIds: [t1.id, t2.id] });
    // 编组录一次 companyName
    await setValue(projectStore, project.id, { groupId: group.id, variableValue: 'companyName', realValue: '星河科技' });
    // 查 t1 的生效值（组内）：应有 companyName
    const t1Values = await listValues(projectStore, project.id, { templateId: t1.id });
    assert.equal(t1Values.length, 1);
    assert.equal(t1Values[0].realValue, '星河科技');
    // 查 t2 的生效值（组内）：也应有 companyName
    const t2Values = await listValues(projectStore, project.id, { templateId: t2.id });
    assert.equal(t2Values.length, 1);
    assert.equal(t2Values[0].realValue, '星河科技');
  });
});

test('ungrouped templates need their own values', async () => {
  await withStores(async ({ projectStore, templateStore, nextId }) => {
    const t1 = await makeTemplate(templateStore, 'T1', [{ name: '公司', value: 'companyName' }], nextId);
    const t2 = await makeTemplate(templateStore, 'T2', [{ name: '公司', value: 'companyName' }], nextId);
    const project = await createProject(projectStore, { name: 'P', detail: '' });
    await linkTemplates(projectStore, project.id, [t1.id, t2.id]);
    // t1 单独录值
    await setValue(projectStore, project.id, { templateId: t1.id, variableValue: 'companyName', realValue: '甲公司' });
    const t1Values = await listValues(projectStore, project.id, { templateId: t1.id });
    assert.equal(t1Values.length, 1);
    assert.equal(t1Values[0].realValue, '甲公司');
    const t2Values = await listValues(projectStore, project.id, { templateId: t2.id });
    assert.equal(t2Values.length, 0);
  });
});

test('enum variable preview uses slot 0 only, export expands to multiple files', async () => {
  await withStores(async ({ projectStore, templateStore, variableStore, nextId }) => {
    // 建一个枚举型系统变量
    await createVariable(variableStore, { name: '股东', value: 'shareholder', type: 'enum' });
    const sysVars = await listVariables(variableStore);
    const t1 = await makeTemplate(templateStore, 'T1', [{ name: '股东', value: 'shareholder' }], nextId);
    const project = await createProject(projectStore, { name: 'P', detail: '' });
    await linkTemplates(projectStore, project.id, [t1.id]);
    await setValue(projectStore, project.id, { templateId: t1.id, variableValue: 'shareholder', slotIndex: 0, realValue: '张三' });
    await setValue(projectStore, project.id, { templateId: t1.id, variableValue: 'shareholder', slotIndex: 1, realValue: '李四' });
    const rendered = await renderSignaturePage(projectStore, templateStore, project.id, t1.id);
    // 预览只用 slot 0
    assert.ok(rendered.html.includes('张三'), '预览应包含 slot 0 的张三');
    assert.ok(!rendered.html.includes('李四'), '预览不应包含 slot 1 的李四');
    // 导出：枚举有 2 个 slot，应生成 zip（含 2 份 docx）
    const result = await exportSingle(projectStore, templateStore, project.id, t1.id, 'docx', sysVars);
    assert.equal(result.mime, 'application/zip', '2 个枚举 slot 应打包为 zip');
    assert.ok(result.fileName.endsWith('.zip'));
  });
});

test('progress reflects filled and missing variables', async () => {
  await withStores(async ({ projectStore, templateStore, nextId }) => {
    const t1 = await makeTemplate(templateStore, 'T1', [
      { name: '公司', value: 'companyName' },
      { name: '日期', value: 'signDate' },
    ], nextId);
    const project = await createProject(projectStore, { name: 'P', detail: '' });
    await linkTemplates(projectStore, project.id, [t1.id]);
    const progress0 = await getProgress(projectStore, templateStore, project.id);
    assert.equal(progress0.total, 2);
    assert.equal(progress0.filled, 0);
    assert.equal(progress0.ratio, 0);
    await setValue(projectStore, project.id, { templateId: t1.id, variableValue: 'companyName', realValue: '甲公司' });
    const progress1 = await getProgressByTemplate(projectStore, templateStore, project.id, t1.id);
    assert.equal(progress1.filled, 1);
    assert.equal(progress1.total, 2);
    assert.equal(progress1.missing.length, 1);
    assert.equal(progress1.missing[0].value, 'signDate');
  });
});

test('export rejects when variables missing', async () => {
  await withStores(async ({ projectStore, templateStore, nextId }) => {
    const t1 = await makeTemplate(templateStore, 'T1', [
      { name: '公司', value: 'companyName' },
      { name: '日期', value: 'signDate' },
    ], nextId);
    const project = await createProject(projectStore, { name: 'P', detail: '' });
    await linkTemplates(projectStore, project.id, [t1.id]);
    await setValue(projectStore, project.id, { templateId: t1.id, variableValue: 'companyName', realValue: '甲公司' });
    await assert.rejects(
      () => exportSingle(projectStore, templateStore, project.id, t1.id, 'docx'),
      /未填写真实值/,
    );
  });
});

test('renders signature page with real values replacing placeholders', async () => {
  await withStores(async ({ projectStore, templateStore, nextId }) => {
    const t1 = await makeTemplate(templateStore, 'T1', [{ name: '公司', value: 'companyName' }], nextId);
    const project = await createProject(projectStore, { name: 'P', detail: '' });
    await linkTemplates(projectStore, project.id, [t1.id]);
    await setValue(projectStore, project.id, { templateId: t1.id, variableValue: 'companyName', realValue: '甲公司' });
    const rendered = await renderSignaturePage(projectStore, templateStore, project.id, t1.id);
    assert.ok(rendered.html.includes('甲公司'), '应包含真实值');
    assert.ok(!rendered.html.includes('{{companyName}}'), '应不含未替换的占位符');
  });
});

test('renders grouped template values from the current project when templates are reused', async () => {
  await withStores(async ({ projectStore, templateStore, nextId }) => {
    const t1 = await makeTemplate(templateStore, 'T1', [{ name: '公司', value: 'companyName' }], nextId);
    const p1 = await createProject(projectStore, { name: 'P1', detail: '' });
    await new Promise((resolve) => setTimeout(resolve, 1));
    const p2 = await createProject(projectStore, { name: 'P2', detail: '' });
    await linkTemplates(projectStore, p1.id, [t1.id]);
    await linkTemplates(projectStore, p2.id, [t1.id]);
    const g2 = await createGroup(projectStore, p2.id, { name: '组1', templateIds: [t1.id] });
    const g1 = await createGroup(projectStore, p1.id, { name: '组1', templateIds: [t1.id] });
    await setValue(projectStore, p1.id, { groupId: g1.id, variableValue: 'companyName', realValue: '甲公司' });
    await setValue(projectStore, p2.id, { groupId: g2.id, variableValue: 'companyName', realValue: '乙公司' });

    const rendered = await renderSignaturePage(projectStore, templateStore, p1.id, t1.id);
    assert.equal(rendered.scope, `group:${g1.id}`);
    assert.ok(rendered.html.includes('甲公司'), '应使用当前项目编组的真实值');
    assert.ok(!rendered.html.includes('{{companyName}}'), '当前项目已录入时不应保留占位符');
  });
});

test('batch export rejects when any template incomplete', async () => {
  await withStores(async ({ projectStore, templateStore, nextId }) => {
    const t1 = await makeTemplate(templateStore, 'T1', [{ name: '公司', value: 'companyName' }], nextId);
    const t2 = await makeTemplate(templateStore, 'T2', [{ name: '日期', value: 'signDate' }], nextId);
    const project = await createProject(projectStore, { name: 'P', detail: '' });
    await linkTemplates(projectStore, project.id, [t1.id, t2.id]);
    await setValue(projectStore, project.id, { templateId: t1.id, variableValue: 'companyName', realValue: '甲公司' });
    // t2 的 signDate 未填
    await assert.rejects(
      () => exportBatch(projectStore, templateStore, project.id, [t1.id, t2.id], 'docx'),
      /未填完/,
    );
  });
});

test('batch export succeeds for a complete group', async () => {
  await withStores(async ({ projectStore, templateStore, nextId }) => {
    const t1 = await makeTemplate(templateStore, 'T1', [{ name: '公司', value: 'companyName' }], nextId);
    const t2 = await makeTemplate(templateStore, 'T2', [{ name: '日期', value: 'signDate' }], nextId);
    const project = await createProject(projectStore, { name: 'P', detail: '' });
    await linkTemplates(projectStore, project.id, [t1.id, t2.id]);
    const group = await createGroup(projectStore, project.id, { name: '组1', templateIds: [t1.id, t2.id] });
    await setValue(projectStore, project.id, { groupId: group.id, variableValue: 'companyName', realValue: '甲公司' });
    await setValue(projectStore, project.id, { groupId: group.id, variableValue: 'signDate', realValue: '2026-09-04' });

    const result = await exportBatch(projectStore, templateStore, project.id, group.templateIds, 'docx');
    assert.equal(result.mime, 'application/zip');
    assert.ok(result.fileName.includes('批量导出'));
    assert.ok(result.buffer.length > 0);
  });
});

test('deleting a project cascades to groups and values', async () => {
  await withStores(async ({ projectStore, templateStore, nextId }) => {
    const t1 = await makeTemplate(templateStore, 'T1', [{ name: '公司', value: 'companyName' }], nextId);
    const project = await createProject(projectStore, { name: 'P', detail: '' });
    await linkTemplates(projectStore, project.id, [t1.id]);
    const group = await createGroup(projectStore, project.id, { name: '组1', templateIds: [t1.id] });
    await setValue(projectStore, project.id, { groupId: group.id, variableValue: 'companyName', realValue: '甲公司' });
    await deleteProject(projectStore, project.id);
    // 编组应消失
    const groups = await listGroups(projectStore, project.id);
    assert.equal(groups.length, 0);
    // 项目应消失
    const got = await getProject(projectStore, project.id);
    assert.equal(got, null);
  });
});
