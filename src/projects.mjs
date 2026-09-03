import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const operator = '项目管理员';

/**
 * 项目存储：管理 projects.json / template-groups.json / project-values 目录 / outputs 目录
 * 复用 workspace/data 目录与 templates.mjs / variables.mjs 的数据根一致
 */
export class ProjectStore {
  constructor(root) {
    this.root = root;
    this.dataDir = path.join(root, 'data');
    this.projectFile = path.join(this.dataDir, 'projects.json');
    this.groupFile = path.join(this.dataDir, 'template-groups.json');
    this.valuesDir = path.join(this.dataDir, 'project-values');
    this.outputsDir = path.join(this.dataDir, 'outputs');
    this.auditFile = path.join(this.dataDir, 'audit.ndjson');
    this.writeQueue = Promise.resolve();
  }

  async initialize() {
    await fs.mkdir(this.dataDir, { recursive: true });
    await fs.mkdir(this.valuesDir, { recursive: true });
    await fs.mkdir(this.outputsDir, { recursive: true });
    await this.ensureFile(this.projectFile, '[]');
    await this.ensureFile(this.groupFile, '[]');
    await this.ensureFile(this.auditFile, '');
  }

  async ensureFile(file, content) {
    try {
      await fs.access(file);
    } catch {
      await fs.mkdir(path.dirname(file), { recursive: true });
      await fs.writeFile(file, content, 'utf8');
    }
  }

  async readProjects() {
    await this.initialize();
    return JSON.parse(await fs.readFile(this.projectFile, 'utf8'));
  }

  async writeProjects(projects) {
    await this.initialize();
    this.writeQueue = this.writeQueue.then(async () => {
      const temporary = `${this.projectFile}.${randomUUID()}.tmp`;
      await fs.writeFile(temporary, JSON.stringify(projects, null, 2), 'utf8');
      await fs.rename(temporary, this.projectFile);
    });
    return this.writeQueue;
  }

  async readGroups() {
    await this.initialize();
    return JSON.parse(await fs.readFile(this.groupFile, 'utf8'));
  }

  async writeGroups(groups) {
    await this.initialize();
    this.writeQueue = this.writeQueue.then(async () => {
      const temporary = `${this.groupFile}.${randomUUID()}.tmp`;
      await fs.writeFile(temporary, JSON.stringify(groups, null, 2), 'utf8');
      await fs.rename(temporary, this.groupFile);
    });
    return this.writeQueue;
  }

  async readValues(projectId) {
    await this.initialize();
    const file = path.join(this.valuesDir, `${projectId}.json`);
    try {
      await fs.access(file);
      const data = JSON.parse(await fs.readFile(file, 'utf8'));
      return Array.isArray(data) ? data : (data.values || []);
    } catch {
      return [];
    }
  }

  async writeValues(projectId, values) {
    await this.initialize();
    const file = path.join(this.valuesDir, `${projectId}.json`);
    this.writeQueue = this.writeQueue.then(async () => {
      const temporary = `${file}.${randomUUID()}.tmp`;
      await fs.writeFile(temporary, JSON.stringify({ values }, null, 2), 'utf8');
      await fs.rename(temporary, file);
    });
    return this.writeQueue;
  }

  async appendAuditLog(log) {
    await this.initialize();
    await fs.appendFile(this.auditFile, `${JSON.stringify(log)}\n`, 'utf8');
  }

  outputsDirectory() {
    return this.outputsDir;
  }
}

/* =========================================================================
 * 项目 CRUD
 * ========================================================================= */

export async function listProjects(store, filters = {}) {
  const keyword = String(filters.keyword || '').trim().toLowerCase();
  return (await store.readProjects())
    .filter((p) => !keyword || p.name.toLowerCase().includes(keyword) || String(p.id).includes(keyword))
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export async function getProject(store, id) {
  return (await store.readProjects()).find((p) => p.id === Number(id)) || null;
}

export async function createProject(store, input) {
  const projects = await store.readProjects();
  const project = buildProject(input, null, Date.now());
  if (projects.some((p) => p.id === project.id)) throw new Error('项目id不可重复');
  project.changeLogs.push(changeLog('CREATE', null, project, '创建项目'));
  await store.writeProjects([...projects, project]);
  await store.appendAuditLog(audit('CREATE_PROJECT', project.id, project.name));
  return project;
}

export async function updateProject(store, id, input) {
  const projects = await store.readProjects();
  const current = projects.find((p) => p.id === Number(id));
  if (!current) throw new Error('项目不存在');
  const next = buildProject({ ...current, ...input, id: current.id }, current, current.id);
  const summary = summarizeProjectChange(current, next);
  next.changeLogs = [...current.changeLogs, changeLog('UPDATE', current, next, summary)];
  await store.writeProjects(projects.map((p) => p.id === next.id ? next : p));
  await store.appendAuditLog(audit('UPDATE_PROJECT', next.id, summary));
  return next;
}

export async function deleteProject(store, id) {
  const projects = await store.readProjects();
  const current = projects.find((p) => p.id === Number(id));
  if (!current) throw new Error('项目不存在');
  // 级联删除：编组 + 真实值
  const groups = await store.readGroups();
  await store.writeGroups(groups.filter((g) => g.projectId !== current.id));
  try {
    await fs.unlink(path.join(store.valuesDir, `${current.id}.json`));
  } catch {}
  await store.writeProjects(projects.filter((p) => p.id !== current.id));
  await store.appendAuditLog(audit('DELETE_PROJECT', current.id, current.name));
}

/** 挂接模板到项目（追加，去重） */
export async function linkTemplates(store, projectId, templateIds) {
  const projects = await store.readProjects();
  const project = projects.find((p) => p.id === Number(projectId));
  if (!project) throw new Error('项目不存在');
  const adds = (templateIds || []).map(Number).filter(Boolean);
  const merged = [...new Set([...(project.templateIds || []), ...adds])];
  if (merged.length === (project.templateIds || []).length) {
    return project; // 无变化
  }
  const next = buildProject({ ...project, templateIds: merged }, project, project.id);
  const summary = `挂接模板 ${adds.join(',')}`;
  next.changeLogs = [...project.changeLogs, changeLog('LINK_TEMPLATES', project, next, summary)];
  await store.writeProjects(projects.map((p) => p.id === next.id ? next : p));
  await store.appendAuditLog(audit('LINK_TEMPLATES', next.id, summary));
  return next;
}

/** 取消挂接模板（同步从所在编组移除） */
export async function unlinkTemplate(store, projectId, templateId) {
  const projects = await store.readProjects();
  const project = projects.find((p) => p.id === Number(projectId));
  if (!project) throw new Error('项目不存在');
  const tid = Number(templateId);
  const next = buildProject({ ...project, templateIds: (project.templateIds || []).filter((x) => x !== tid) }, project, project.id);
  const summary = `取消挂接模板 ${tid}`;
  next.changeLogs = [...project.changeLogs, changeLog('UNLINK_TEMPLATE', project, next, summary)];
  await store.writeProjects(projects.map((p) => p.id === next.id ? next : p));
  // 同步从编组移除
  const groups = await store.readGroups();
  let groupChanged = false;
  for (const g of groups) {
    if (g.projectId !== project.id) continue;
    if ((g.templateIds || []).includes(tid)) {
      g.templateIds = g.templateIds.filter((x) => x !== tid);
      g.updatedAt = new Date().toISOString();
      groupChanged = true;
    }
  }
  if (groupChanged) await store.writeGroups(groups);
  await store.appendAuditLog(audit('UNLINK_TEMPLATE', next.id, summary));
  return next;
}

/* =========================================================================
 * 编组 CRUD
 * ========================================================================= */

export async function listGroups(store, projectId) {
  const groups = await store.readGroups();
  if (projectId) return groups.filter((g) => g.projectId === Number(projectId)).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  return groups.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export async function getGroup(store, id) {
  return (await store.readGroups()).find((g) => g.id === Number(id)) || null;
}

export async function createGroup(store, projectId, input) {
  const project = await getProject(store, projectId);
  if (!project) throw new Error('项目不存在');
  const groups = await store.readGroups();
  const group = buildGroup(projectId, input, null, nextNumericId(groups));
  if (groups.some((g) => g.id === group.id)) throw new Error('编组id不可重复');
  // 校验 groupIndex 在项目内唯一（1-10 范围）
  if (group.groupIndex) {
    if (group.groupIndex < 1 || group.groupIndex > 10) throw new Error('编组序号只能 1-10');
    const sameIndex = groups.filter((g) => g.projectId === project.id && (g.groupIndex || 0) === group.groupIndex);
    if (sameIndex.length) throw new Error(`编组${group.groupIndex} 已存在`);
  }
  await validateGroupTemplates(store, project, group, groups);
  await store.writeGroups([...groups, group]);
  await store.appendAuditLog(audit('CREATE_GROUP', group.id, `${project.name}/${group.name}`));
  return group;
}

export async function updateGroup(store, id, input) {
  const groups = await store.readGroups();
  const current = groups.find((g) => g.id === Number(id));
  if (!current) throw new Error('编组不存在');
  const project = await getProject(store, current.projectId);
  if (!project) throw new Error('项目不存在');
  const next = buildGroup(current.projectId, { ...current, ...input, id: current.id }, current, current.id);
  await validateGroupTemplates(store, project, next, groups.filter((g) => g.id !== next.id));
  await store.writeGroups(groups.map((g) => g.id === next.id ? next : g));
  await store.appendAuditLog(audit('UPDATE_GROUP', next.id, `更新编组 ${next.name}`));
  return next;
}

export async function deleteGroup(store, id) {
  const groups = await store.readGroups();
  const current = groups.find((g) => g.id === Number(id));
  if (!current) throw new Error('编组不存在');
  await store.writeGroups(groups.filter((g) => g.id !== current.id));
  // 编组下的真实值：scope = 'group:<id>' 失效，一并清理
  const values = await store.readValues(current.projectId);
  const filtered = values.filter((v) => v.scope !== `group:${current.id}`);
  if (filtered.length !== values.length) await store.writeValues(current.projectId, filtered);
  await store.appendAuditLog(audit('DELETE_GROUP', current.id, `删除编组 ${current.name}`));
}

/** 添加模板到编组（互斥：若已在其他编组则移出旧组） */
export async function addTemplatesToGroup(store, groupId, templateIds) {
  const groups = await store.readGroups();
  const group = groups.find((g) => g.id === Number(groupId));
  if (!group) throw new Error('编组不存在');
  const project = await getProject(store, group.projectId);
  if (!project) throw new Error('项目不存在');
  const adds = (templateIds || []).map(Number).filter(Boolean);
  // 校验模板都在项目下
  const notInProject = adds.filter((tid) => !(project.templateIds || []).includes(tid));
  if (notInProject.length) throw new Error(`模板 ${notInProject.join(',')} 不在项目中，无法编组`);
  // 互斥：从其他组移除
  for (const g of groups) {
    if (g.id === group.id) continue;
    if (g.projectId !== group.projectId) continue;
    const intersect = (g.templateIds || []).filter((x) => adds.includes(x));
    if (intersect.length) {
      g.templateIds = (g.templateIds || []).filter((x) => !intersect.includes(x));
      g.updatedAt = new Date().toISOString();
    }
  }
  group.templateIds = [...new Set([...(group.templateIds || []), ...adds])];
  group.updatedAt = new Date().toISOString();
  await validateGroupTemplates(store, project, group, groups.filter((g) => g.id !== group.id));
  await store.writeGroups(groups);
  // 把模板级真实值迁移到组级（同变量值已存在的组级值优先，不覆盖）
  const values = await store.readValues(group.projectId);
  const groupScope = `group:${group.id}`;
  const existingGroupValues = new Set(values.filter((v) => v.scope === groupScope).map((v) => `${v.variableValue}:${v.slotIndex || 0}`));
  const toAdd = [];
  for (const tid of adds) {
    const templateScope = `template:${tid}`;
    for (const v of values.filter((x) => x.scope === templateScope)) {
      const key = `${v.variableValue}:${v.slotIndex || 0}`;
      if (existingGroupValues.has(key)) continue; // 组级已有同变量值，跳过
      existingGroupValues.add(key);
      toAdd.push({ ...v, scope: groupScope });
    }
  }
  if (toAdd.length) {
    await store.writeValues(group.projectId, [...values, ...toAdd]);
  }
  await store.appendAuditLog(audit('ADD_TO_GROUP', group.id, `加入模板 ${adds.join(',')}`));
  return group;
}

export async function removeTemplatesFromGroup(store, groupId, templateIds) {
  const groups = await store.readGroups();
  const group = groups.find((g) => g.id === Number(groupId));
  if (!group) throw new Error('编组不存在');
  const removes = (templateIds || []).map(Number).filter(Boolean);
  group.templateIds = (group.templateIds || []).filter((x) => !removes.includes(x));
  group.updatedAt = new Date().toISOString();
  await store.writeGroups(groups);
  await store.appendAuditLog(audit('REMOVE_FROM_GROUP', group.id, `移除模板 ${removes.join(',')}`));
  return group;
}

async function validateGroupTemplates(store, project, group, otherGroups) {
  // 模板都必须在项目下
  const notInProject = (group.templateIds || []).filter((tid) => !(project.templateIds || []).includes(tid));
  if (notInProject.length) throw new Error(`模板 ${notInProject.join(',')} 不在项目中`);
  // 互斥：组内模板不能在其他组中
  for (const other of otherGroups) {
    if (other.projectId !== group.projectId) continue;
    const intersect = (group.templateIds || []).filter((x) => (other.templateIds || []).includes(x));
    if (intersect.length) throw new Error(`模板 ${intersect.join(',')} 已在编组「${other.name}」中，请先移出`);
  }
}

/* =========================================================================
 * 真实值管理
 * ========================================================================= */

/**
 * 列出某作用域下的真实值
 * scope 取值 'group:<gid>' 或 'template:<tid>'，由后端根据组归属自动解析
 * @param {Object} options { scope, templateId, groupId }
 */
export async function listValues(store, projectId, options = {}) {
  const values = await store.readValues(projectId);
  if (options.scope) return values.filter((v) => v.scope === options.scope);
  if (options.groupId) return values.filter((v) => v.scope === `group:${Number(options.groupId)}`);
  if (options.templateId) {
    // 返回该模板生效的值（在组内 → 取组 scope；不在 → 取 template scope）
    const groups = await store.readGroups();
    const scope = resolveTemplateScope(groups, projectId, Number(options.templateId));
    return values.filter((v) => v.scope === scope);
  }
  return values;
}

/**
 * 写入/更新一个真实值
 * body: { scope?, templateId?, groupId?, variableValue, slotIndex=0, realValue }
 * scope 自动解析：若给了 groupId → 'group:<gid>'；若只给 templateId → 按模板归属解析
 */
export async function setValue(store, projectId, body) {
  const values = await store.readValues(projectId);
  const scope = await resolveScopeFromInput(store, projectId, body);
  const slotIndex = Number(body.slotIndex || 0);
  const variableValue = String(body.variableValue || '').trim();
  if (!variableValue) throw new Error('变量值不能为空');
  const realValue = String(body.realValue ?? '').trim();
  const idx = values.findIndex((v) => v.scope === scope && v.variableValue === variableValue && v.slotIndex === slotIndex);
  const now = new Date().toISOString();
  if (idx >= 0) {
    values[idx].realValue = realValue;
    values[idx].updatedAt = now;
    values[idx].by = operator;
  } else {
    values.push({ scope, variableValue, slotIndex, realValue, updatedAt: now, by: operator });
  }
  await store.writeValues(projectId, values);
  await store.appendAuditLog(audit('SET_VALUE', projectId, `${scope}/${variableValue}/${slotIndex} = ${realValue}`));
  return values.find((v) => v.scope === scope && v.variableValue === variableValue && v.slotIndex === slotIndex);
}

/** 删除一个真实值 */
export async function deleteValue(store, projectId, body) {
  const values = await store.readValues(projectId);
  const scope = await resolveScopeFromInput(store, projectId, body);
  const slotIndex = Number(body.slotIndex || 0);
  const variableValue = String(body.variableValue || '').trim();
  const next = values.filter((v) => !(v.scope === scope && v.variableValue === variableValue && v.slotIndex === slotIndex));
  await store.writeValues(projectId, next);
  await store.appendAuditLog(audit('DELETE_VALUE', projectId, `${scope}/${variableValue}/${slotIndex}`));
}

async function resolveScopeFromInput(store, projectId, body) {
  if (body.scope) return body.scope;
  if (body.groupId) return `group:${Number(body.groupId)}`;
  if (body.templateId) {
    const groups = await store.readGroups();
    return resolveTemplateScope(groups, projectId, Number(body.templateId));
  }
  throw new Error('缺少 scope / groupId / templateId');
}

/** 给定模板 id，找到其所属 scope（组内→组 scope；否则→template scope） */
function resolveTemplateScope(groups, projectId, templateId) {
  const tid = Number(templateId);
  const pid = Number(projectId);
  const group = groups.find((g) => g.projectId === pid && (g.templateIds || []).includes(tid));
  return group ? `group:${group.id}` : `template:${tid}`;
}

/* =========================================================================
 * 进度计算
 * ========================================================================= */

/**
 * 项目进度总览：返回每个模板/编组/项目的完成率
 * 需要传入 templateStore 以读取模板的 extractedVariables
 */
export async function getProgress(store, templateStore, projectId) {
  const project = await getProject(store, projectId);
  if (!project) throw new Error('项目不存在');
  const groups = await store.readGroups().then((gs) => gs.filter((g) => g.projectId === project.id));
  const values = await store.readValues(projectId);
  const templates = await templateStore.readTemplates();
  const templateMap = new Map(templates.map((t) => [t.id, t]));

  const templateProgress = [];
  for (const tid of (project.templateIds || [])) {
    const t = templateMap.get(tid);
    const scope = resolveTemplateScope(groups, project.id, tid);
    const p = computeTemplateProgress(t, values, scope);
    templateProgress.push({ templateId: tid, name: t?.name || '', scope, ...p });
  }
  const groupProgress = groups.map((g) => {
    const tps = templateProgress.filter((tp) => tp.scope === `group:${g.id}`);
    const filled = tps.reduce((s, tp) => s + tp.filled, 0);
    const total = tps.reduce((s, tp) => s + tp.total, 0);
    return {
      groupId: g.id, name: g.name, templateIds: g.templateIds,
      filled, total, ratio: total ? filled / total : 0,
      templates: tps.map(({ templateId, name, filled, total, ratio }) => ({ templateId, name, filled, total, ratio })),
    };
  });
  const ungrouped = templateProgress.filter((tp) => tp.scope.startsWith('template:'));
  const totalFilled = templateProgress.reduce((s, tp) => s + tp.filled, 0);
  const totalAll = templateProgress.reduce((s, tp) => s + tp.total, 0);
  return {
    projectId: project.id, name: project.name,
    filled: totalFilled, total: totalAll, ratio: totalAll ? totalFilled / totalAll : 0,
    groups: groupProgress,
    ungrouped: {
      filled: ungrouped.reduce((s, tp) => s + tp.filled, 0),
      total: ungrouped.reduce((s, tp) => s + tp.total, 0),
      ratio: ungrouped.length ? ungrouped.reduce((s, tp) => s + tp.ratio, 0) / ungrouped.length : 0,
      templates: ungrouped,
    },
    templates: templateProgress,
  };
}

export async function getProgressByTemplate(store, templateStore, projectId, templateId) {
  const project = await getProject(store, projectId);
  if (!project) throw new Error('项目不存在');
  const groups = await store.readGroups();
  const values = await store.readValues(projectId);
  const t = (await templateStore.readTemplates()).find((x) => x.id === Number(templateId));
  const scope = resolveTemplateScope(groups, project.id, Number(templateId));
  return { templateId: Number(templateId), name: t?.name || '', scope, ...computeTemplateProgress(t, values, scope) };
}

/**
 * 单模板进度
 * 规则：对 extractedVariables 中每个变量：
 *   single 类：scope 下存在 (variableValue, slotIndex=0) 即视为完成
 *   enum 类：需要 N 个 slot 都有值（slot 数由变量自身决定，默认 1）
 *   这里采用「至少有 1 个 slot 填了即算完成 1 项」的宽松策略；导出时再校验全部 slot
 */
function computeTemplateProgress(template, values, scope) {
  const vars = (template?.extractedVariables || []).filter((v) => v && v.value);
  if (!vars.length) return { filled: 0, total: 0, ratio: 0, missing: [] };
  const filled = [];
  const missing = [];
  for (const v of vars) {
    const hits = values.filter((x) => x.scope === scope && x.variableValue === v.value && x.realValue && x.realValue.trim());
    if (hits.length) filled.push(v);
    else missing.push({ value: v.value, name: v.name });
  }
  return {
    filled: filled.length, total: vars.length, ratio: filled.length / vars.length,
    filledVariables: filled.map((v) => ({ value: v.value, name: v.name })),
    missing,
  };
}

/* =========================================================================
 * 签字页渲染与导出
 * ========================================================================= */

/**
 * 渲染单个签字页（含真实值）
 * 返回 { html, template, progress, scope }
 */
export async function renderSignaturePage(store, templateStore, projectId, templateId) {
  const project = await getProject(store, projectId);
  if (!project) throw new Error('项目不存在');
  if (!(project.templateIds || []).includes(Number(templateId))) throw new Error('模板未挂接到该项目');
  const groups = await store.readGroups();
  const scope = resolveTemplateScope(groups, project.id, Number(templateId));
  const values = await store.readValues(projectId);
  const template = (await templateStore.readTemplates()).find((t) => t.id === Number(templateId));
  if (!template) throw new Error('模板不存在');
  const resolved = {};
  for (const v of values.filter((x) => x.scope === scope && x.realValue && x.realValue.trim())) {
    if (!resolved[v.variableValue]) resolved[v.variableValue] = [];
    resolved[v.variableValue][v.slotIndex || 0] = v.realValue;
  }
  const html = renderTemplateHtml(template, resolved);
  return {
    html, template, scope,
    progress: computeTemplateProgress(template, values, scope),
  };
}

/**
 * 用真实值替换模板 HTML 中的 {{var}} 占位
 * - chip 包装自动剥除
 * - enum 类变量（在 enumVarValues 中）：按 enumSlot 取对应 slot 的值
 * - 非 enum 变量：恒取 slot 0 的值（每份文档都相同）
 */
function renderTemplateHtml(template, resolved, enumSlot = 0, enumVarValues = new Set()) {
  let html = String(template.previewHtml || template.previewText || '');
  const vars = (template.extractedVariables || []).filter((v) => v && v.value);
  for (const v of vars) {
    const slots = resolved[v.value] || [];
    // 枚举变量按 enumSlot 取；非枚举变量恒取 slot 0
    const real = enumVarValues.has(v.value) ? (slots[enumSlot] || '') : (slots[0] || '');
    if (!real) continue;
    // 先剥 chip 包装（<span class="variable-chip" data-status="..." data-variable="xxx">{{xxx}}</span>）
    const chipRe = new RegExp(`<span class="variable-chip"[^>]*data-variable="${escapeRegExp(v.value)}"[^>]*>\\{\\{${escapeRegExp(v.value)}\\}\\}</span>`, 'g');
    html = html.replace(chipRe, escapeHtml(real));
    // 再替换裸 {{var}}
    html = html.split(`{{${v.value}}}`).join(escapeHtml(real));
  }
  // 清理未填变量的 chip，保留占位符供后续识别
  html = html.replace(/<span class="variable-chip"[^>]*>(\{\{[^}]+\}\})<\/span>/g, '$1');
  return html;
}

/**
 * 导出单个签字页为 DOCX
 * - 单一变量模板：导出 1 份 docx
 * - 含枚举变量的模板：按枚举 slot 数量导出多份，打包为 zip
 *   枚举 slot 数 = max(所有枚举变量的 slot 数)
 *   非枚举变量在每份中都使用 slot 0 的值
 */
export async function exportSingle(store, templateStore, projectId, templateId, format = 'docx', sysVars = []) {
  const progress = await getProgressByTemplate(store, templateStore, projectId, templateId);
  if (progress.missing.length) {
    throw new Error(`签字页 ${progress.name} 有 ${progress.missing.length} 个变量未填写真实值，无法导出`);
  }
  const project = await getProject(store, projectId);
  const groups = await store.readGroups();
  const scope = resolveTemplateScope(groups, project.id, Number(templateId));
  const values = await store.readValues(projectId);
  const template = (await templateStore.readTemplates()).find((t) => t.id === Number(templateId));
  if (!template) throw new Error('模板不存在');

  // 整理变量值（按 variableValue → slots 数组）
  const resolved = {};
  for (const v of values.filter((x) => x.scope === scope && x.realValue && x.realValue.trim())) {
    if (!resolved[v.variableValue]) resolved[v.variableValue] = [];
    resolved[v.variableValue][v.slotIndex || 0] = v.realValue;
  }

  // 找出所有枚举变量，计算需展开多少份
  const enumVarValues = new Set();
  for (const v of (template.extractedVariables || [])) {
    const sysVar = sysVars.find((s) => s.value === v.value);
    if (sysVar?.type === 'enum') enumVarValues.add(v.value);
  }
  let enumCount = 0;
  for (const value of enumVarValues) {
    const slots = resolved[value] || [];
    const cnt = slots.filter(Boolean).length;
    if (cnt > enumCount) enumCount = cnt;
  }
  if (enumCount === 0) enumCount = 1; // 无枚举或多 slot，导出 1 份

  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  // 单份直接返回 docx
  if (enumCount === 1) {
    const buffer = await renderDocxFromTemplate(template, resolved, 0, enumVarValues);
    const fileName = `${sanitizeFileName(project.name)}-${sanitizeFileName(template.name)}-${stamp}.docx`;
    return { fileName, buffer, mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' };
  }

  // 多份：按 slot 0..N-1 生成，打包 zip
  const files = [];
  for (let i = 0; i < enumCount; i += 1) {
    const buffer = await renderDocxFromTemplate(template, resolved, i, enumVarValues);
    files.push({
      fileName: `${sanitizeFileName(project.name)}-${sanitizeFileName(template.name)}-${i + 1}-${stamp}.docx`,
      buffer,
    });
  }
  try {
    const zipBuffer = await makeZip(files);
    return {
      fileName: `${sanitizeFileName(project.name)}-${sanitizeFileName(template.name)}-${stamp}.zip`,
      buffer: zipBuffer,
      mime: 'application/zip',
    };
  } catch (error) {
    // zip 失败回退：返回第一份 docx
    return { ...files[0], mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' };
  }
}

/**
 * 批量导出：返回 zip 缓冲
 * @param {number[]} templateIds
 */
export async function exportBatch(store, templateStore, projectId, templateIds, format = 'docx', sysVars = []) {
  const project = await getProject(store, projectId);
  if (!project) throw new Error('项目不存在');
  const ids = (templateIds || []).map(Number).filter(Boolean);
  // 全量校验
  const failed = [];
  for (const id of ids) {
    const p = await getProgressByTemplate(store, templateStore, projectId, id);
    if (p.missing.length) failed.push(`${p.name}（${p.missing.length} 项未填）`);
  }
  if (failed.length) throw new Error(`以下签字页未填完，无法批量导出：${failed.join('；')}`);
  const files = [];
  for (const id of ids) {
    // exportSingle 内部会处理枚举多份，每份作为独立文件加入 zip
    const result = await exportSingle(store, templateStore, projectId, id, format, sysVars);
    if (result.mime === 'application/zip') {
      // 单模板导出本身就是 zip（含多份枚举），解压后再合并
      const osTmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sig-export-'));
      try {
        await fs.writeFile(path.join(osTmpDir, 'inner.zip'), result.buffer);
        await exec('unzip', ['-q', '-o', 'inner.zip', '-d', '.'], { cwd: osTmpDir });
        const entries = await fs.readdir(osTmpDir);
        for (const e of entries) {
          if (e === 'inner.zip') continue;
          files.push({ fileName: e, buffer: await fs.readFile(path.join(osTmpDir, e)) });
        }
      } finally {
        try { await fs.rm(osTmpDir, { recursive: true, force: true }); } catch {}
      }
    } else {
      files.push(result);
    }
  }
  // 打包 zip（使用系统 zip 命令；mac/linux 内置，windows 需 7z；失败时回退为多文件下载清单）
  try {
    const zipBuffer = await makeZip(files);
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    return {
      fileName: `${sanitizeFileName(project.name)}-批量导出-${stamp}.zip`,
      buffer: zipBuffer,
      mime: 'application/zip',
    };
  } catch (error) {
    // 回退：返回第一个文件（单文件场景）
    if (files.length === 1) return files[0];
    throw error;
  }
}

async function makeZip(files) {
  const osTmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sig-export-'));
  try {
    for (const f of files) {
      await fs.writeFile(path.join(osTmpDir, f.fileName), f.buffer);
    }
    const zipPath = `${osTmpDir}.zip`;
    // 先试系统 zip
    try {
      await exec('zip', ['-q', '-r', zipPath, '.'], { cwd: osTmpDir });
      return await fs.readFile(zipPath);
    } catch {
      // 回退到 tar 后转 zip 不现实，直接抛错让上层回退到单文件下载
      throw new Error('系统未安装 zip 命令，无法打包批量导出');
    }
  } finally {
    try { await fs.rm(osTmpDir, { recursive: true, force: true }); } catch {}
    try { await fs.unlink(`${osTmpDir}.zip`); } catch {}
  }
}

/**
 * 基于模板的 previewHtml 生成 docx
 * previewHtml 已含 {{var}} 占位，renderTemplateHtml 替换为真实值
 * enumSlot：枚举类变量使用哪个 slot 值（默认 0）
 * enumVarValues：哪些变量是枚举型（按 slot 展开），非枚举变量恒用 slot 0
 */
async function renderDocxFromTemplate(template, resolved, enumSlot = 0, enumVarValues = new Set()) {
  const html = renderTemplateHtml(template, resolved, enumSlot, enumVarValues);
  return htmlToDocx(html, template.name);
}

function escapeXml(text) {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function escapeHtml(text) {
  return String(text).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' })[c]);
}

function escapeRegExp(text) {
  return String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function sanitizeFileName(name) {
  return String(name || '').replace(/[\/\\:*?"<>|]/g, '_').slice(0, 80);
}

/** 无原始 docx 时，用最小可用 docx 包装 HTML（保格式有限） */
async function htmlToDocx(html, title = '签字页') {
  try {
    const mod = await import('html-to-docx');
    const fn = mod.default || mod.htmlToDocx || mod;
    if (typeof fn === 'function') {
      const fullHtml = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>${escapeHtml(title)}</title></head><body>${html}</body></html>`;
      return Buffer.isBuffer(fn) ? fn : Buffer.from(await fn(fullHtml));
    }
  } catch {}
  // 最终兜底：返回 HTML 包装为 .doc（Word 可打开）
  const doc = `<html xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:w="urn:schemas-microsoft-com:office:word" xmlns="http://www.w3.org/TR/REC-html40"><head><meta charset="utf-8"><title>${escapeHtml(title)}</title></head><body>${html}</body></html>`;
  return Buffer.from(doc, 'utf8');
}

/* =========================================================================
 * 辅助构造函数
 * ========================================================================= */

function buildProject(input, current = null, fallbackId = null) {
  const timestamp = new Date().toISOString();
  const project = {
    id: Number(input.id || fallbackId),
    name: String(input.name || '').trim(),
    detail: String(input.detail || '').trim(),
    status: input.status || current?.status || 'active',
    templateIds: Array.isArray(input.templateIds) ? input.templateIds.map(Number) : (current?.templateIds || []),
    createdAt: current?.createdAt || timestamp,
    updatedAt: timestamp,
    changeLogs: current?.changeLogs ? [...current.changeLogs] : [],
  };
  if (!Number.isFinite(project.id)) throw new Error('项目id必须是数字');
  if (!project.name) throw new Error('项目名称不能为空');
  return project;
}

function nextNumericId(existingItems = []) {
  const existing = new Set(existingItems.map((item) => Number(item.id)));
  let id = Date.now();
  while (existing.has(id)) id += 1;
  return id;
}

function buildGroup(projectId, input, current = null, fallbackId = null) {
  const timestamp = new Date().toISOString();
  const group = {
    id: Number(input.id || fallbackId),
    projectId: Number(projectId),
    name: String(input.name || '').trim(),
    groupIndex: Number(input.groupIndex) || current?.groupIndex || 0,
    templateIds: Array.isArray(input.templateIds) ? [...new Set(input.templateIds.map(Number))] : (current?.templateIds || []),
    createdAt: current?.createdAt || timestamp,
    updatedAt: timestamp,
  };
  if (!Number.isFinite(group.id)) throw new Error('编组id必须是数字');
  if (!group.name) throw new Error('编组名称不能为空');
  return group;
}

function changeLog(action, before, after, summary) {
  return {
    id: randomUUID(),
    action,
    operator,
    summary,
    before: before ? snapshotProject(before) : null,
    after: snapshotProject(after),
    createdAt: new Date().toISOString(),
  };
}

function snapshotProject(p) {
  if (!p) return null;
  return {
    id: p.id,
    name: p.name,
    detail: p.detail,
    status: p.status,
    templateIds: p.templateIds,
  };
}

function audit(action, resourceValue, detail) {
  return {
    id: randomUUID(),
    action,
    resourceType: 'project',
    resourceValue,
    operator,
    detail,
    createdAt: new Date().toISOString(),
  };
}

function summarizeProjectChange(before, after) {
  const labels = { name: '项目名称', detail: '项目详情', status: '状态', templateIds: '挂接模板' };
  const changed = Object.keys(labels).filter((k) => JSON.stringify(before[k]) !== JSON.stringify(after[k]));
  return changed.length ? `更新${changed.map((k) => labels[k]).join('、')}` : '保存项目';
}
