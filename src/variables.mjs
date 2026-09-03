import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const operator = '变量管理员';

export class VariableStore {
  constructor(root) {
    this.root = root;
    this.dataDir = path.join(root, 'data');
    this.variableFile = path.join(this.dataDir, 'variables.json');
    this.auditFile = path.join(this.dataDir, 'audit.ndjson');
    this.writeQueue = Promise.resolve();
  }

  async initialize() {
    await fs.mkdir(this.dataDir, { recursive: true });
    await this.ensureFile(this.variableFile, '[]');
    await this.ensureFile(this.auditFile, '');
  }

  async ensureFile(file, content) {
    try {
      await fs.access(file);
    } catch {
      await fs.writeFile(file, content, 'utf8');
    }
  }

  async readVariables() {
    await this.initialize();
    return JSON.parse(await fs.readFile(this.variableFile, 'utf8'));
  }

  async writeVariables(variables) {
    await this.initialize();
    this.writeQueue = this.writeQueue.then(async () => {
      const temporary = `${this.variableFile}.${randomUUID()}.tmp`;
      await fs.writeFile(temporary, JSON.stringify(variables, null, 2), 'utf8');
      await fs.rename(temporary, this.variableFile);
    });
    return this.writeQueue;
  }

  async appendAuditLog(log) {
    await this.initialize();
    await fs.appendFile(this.auditFile, `${JSON.stringify(log)}\n`, 'utf8');
  }

  async readAuditLogs() {
    await this.initialize();
    const text = await fs.readFile(this.auditFile, 'utf8');
    return text.trim() ? text.trim().split('\n').map((line) => JSON.parse(line)) : [];
  }
}

export async function listVariables(store, filters = {}) {
  const variables = await store.readVariables();
  const keyword = String(filters.keyword || '').trim().toLowerCase();
  const type = filters.type || '';
  return variables
    .filter((item) => !keyword || item.name.toLowerCase().includes(keyword) || item.value.toLowerCase().includes(keyword))
    .filter((item) => !type || item.type === type)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export async function getVariable(store, value) {
  return (await store.readVariables()).find((item) => item.value === value) || null;
}

export async function createVariable(store, input) {
  const variables = await store.readVariables();
  const next = buildVariable(input);
  if (variables.some((item) => item.value === next.value)) throw new Error('变量值不可重复');
  next.changeLogs.push(changeLog('CREATE', null, next, '创建变量'));
  await store.writeVariables([...variables, next]);
  await store.appendAuditLog(audit('CREATE_VARIABLE', next.value, next.name));
  return next;
}

export async function updateVariable(store, value, input) {
  const variables = await store.readVariables();
  const current = variables.find((item) => item.value === value);
  if (!current) throw new Error('变量不存在');
  const nextValue = input.value ? normalizeValue(input.value) : current.value;
  if (nextValue !== value && variables.some((item) => item.value === nextValue)) throw new Error('变量值不可重复');
  const next = buildVariable({ ...current, ...input, value: nextValue }, current);
  const summary = summarizeChange(current, next);
  next.changeLogs = [...current.changeLogs, changeLog('UPDATE', current, next, summary)];
  await store.writeVariables(variables.map((item) => item.value === value ? next : item));
  await store.appendAuditLog(audit('UPDATE_VARIABLE', next.value, summary));
  return next;
}

export async function deleteVariable(store, value) {
  const variables = await store.readVariables();
  const current = variables.find((item) => item.value === value);
  if (!current) throw new Error('变量不存在');
  await store.writeVariables(variables.filter((item) => item.value !== value));
  await store.appendAuditLog(audit('DELETE_VARIABLE', current.value, current.name));
}

function buildVariable(input, current = null) {
  const timestamp = new Date().toISOString();
  const variable = {
    name: String(input.name || '').trim(),
    value: normalizeValue(input.value),
    type: input.type || 'single',
    isMultiple: input.type === 'enum',
    description: String(input.description || '').trim(),
    status: input.status || 'active',
    createdAt: current?.createdAt || timestamp,
    updatedAt: timestamp,
    changeLogs: current?.changeLogs ? [...current.changeLogs] : [],
  };
  validateVariable(variable);
  return variable;
}

function normalizeValue(value) {
  const normalized = String(value || '').trim();
  if (!normalized) throw new Error('变量值不能为空');
  if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(normalized)) throw new Error('变量值只能使用英文、数字和下划线，并以英文字母开头');
  return normalized;
}

function validateVariable(variable) {
  if (!variable.name) throw new Error('变量名不能为空');
  if (!['single', 'enum'].includes(variable.type)) throw new Error('变量类型只能是单一或枚举');
}

function changeLog(action, before, after, summary) {
  return {
    id: randomUUID(),
    action,
    operator,
    summary,
    before: before ? snapshot(before) : null,
    after: snapshot(after),
    createdAt: new Date().toISOString(),
  };
}

function snapshot(variable) {
  return {
    name: variable.name,
    value: variable.value,
    type: variable.type,
    isMultiple: variable.isMultiple,
    description: variable.description,
    status: variable.status,
    createdAt: variable.createdAt,
    updatedAt: variable.updatedAt,
  };
}

function audit(action, resourceValue, detail) {
  return {
    id: randomUUID(),
    action,
    resourceType: 'variable',
    resourceValue,
    operator,
    detail,
    createdAt: new Date().toISOString(),
  };
}

function summarizeChange(before, after) {
  const labels = {
    name: '变量名',
    value: '变量值',
    type: '变量类型',
    isMultiple: '是否多条',
    description: '描述',
    status: '状态',
  };
  const changed = Object.keys(labels).filter((key) => JSON.stringify(before[key]) !== JSON.stringify(after[key]));
  return changed.length ? `更新${changed.map((key) => labels[key]).join('、')}` : '保存变量';
}
