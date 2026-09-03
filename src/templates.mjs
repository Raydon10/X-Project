import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const operator = '模板管理员';
const agnesConfig = {
  baseUrl: 'https://apihub.agnes-ai.com/v1',
  apiKey: 'sk-y5wCFC755x6j8J0TP01YKQ94YFJOprWPA2Qi2MQn4jk6aU4T',
  model: 'agnes-2.0-flash',
};

export class TemplateStore {
  constructor(root) {
    this.root = root;
    this.dataDir = path.join(root, 'data');
    this.templateFile = path.join(this.dataDir, 'templates.json');
    this.templateDir = path.join(this.dataDir, 'templates');
    this.promptFile = path.join(this.dataDir, 'template-prompts.json');
    this.auditFile = path.join(this.dataDir, 'audit.ndjson');
    this.writeQueue = Promise.resolve();
  }

  async initialize() {
    await fs.mkdir(this.templateDir, { recursive: true });
    await this.ensureFile(this.templateFile, '[]');
    await this.ensureFile(this.promptFile, JSON.stringify(defaultPrompts(), null, 2));
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

  async readTemplates() {
    await this.initialize();
    return JSON.parse(await fs.readFile(this.templateFile, 'utf8'));
  }

  async writeTemplates(templates) {
    await this.initialize();
    this.writeQueue = this.writeQueue.then(async () => {
      const temporary = `${this.templateFile}.${randomUUID()}.tmp`;
      await fs.writeFile(temporary, JSON.stringify(templates, null, 2), 'utf8');
      await fs.rename(temporary, this.templateFile);
    });
    return this.writeQueue;
  }

  async readPrompts() {
    await this.initialize();
    return JSON.parse(await fs.readFile(this.promptFile, 'utf8'));
  }

  async writePrompts(prompts) {
    await this.initialize();
    await fs.writeFile(this.promptFile, JSON.stringify(prompts, null, 2), 'utf8');
  }

  async appendAuditLog(log) {
    await this.initialize();
    await fs.appendFile(this.auditFile, `${JSON.stringify(log)}\n`, 'utf8');
  }

  documentDirectory(templateId) {
    return path.join(this.templateDir, String(templateId));
  }
}

export async function listTemplates(store, filters = {}) {
  const keyword = String(filters.keyword || '').trim().toLowerCase();
  return (await store.readTemplates())
    .filter((item) => !keyword || item.name.toLowerCase().includes(keyword) || String(item.id).includes(keyword))
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export async function getTemplate(store, id) {
  return (await store.readTemplates()).find((item) => item.id === Number(id)) || null;
}

export async function createTemplate(store, input, options = {}) {
  const templates = await store.readTemplates();
  const template = buildTemplate(input, null, options.timestamp || Date.now());
  if (templates.some((item) => item.id === template.id)) throw new Error('模板id不可重复');
  template.changeLogs.push(changeLog('CREATE', null, template, '创建模板'));
  await store.writeTemplates([...templates, template]);
  await store.appendAuditLog(audit('CREATE_TEMPLATE', template.id, template.name));
  return template;
}

export async function updateTemplate(store, id, input) {
  const templates = await store.readTemplates();
  const current = templates.find((item) => item.id === Number(id));
  if (!current) throw new Error('模板不存在');
  const next = buildTemplate({ ...current, ...input, id: current.id }, current, current.id);
  const summary = summarizeChange(current, next);
  next.changeLogs = [...current.changeLogs, changeLog('UPDATE', current, next, summary)];
  await store.writeTemplates(templates.map((item) => item.id === next.id ? next : item));
  await store.appendAuditLog(audit('UPDATE_TEMPLATE', next.id, summary));
  return next;
}

export async function deleteTemplate(store, id) {
  const templates = await store.readTemplates();
  const current = templates.find((item) => item.id === Number(id));
  if (!current) throw new Error('模板不存在');
  await store.writeTemplates(templates.filter((item) => item.id !== Number(id)));
  await store.appendAuditLog(audit('DELETE_TEMPLATE', current.id, current.name));
}

export async function importTemplateDocument(store, id, file) {
  const template = await getTemplate(store, id);
  if (!template) throw new Error('模板不存在');
  if (!/\.(docx|doc)$/i.test(file.fileName)) throw new Error('仅支持 doc 或 docx 文档');
  const directory = store.documentDirectory(template.id);
  await fs.mkdir(directory, { recursive: true });
  const originalName = path.basename(file.fileName);
  const storagePath = path.join(directory, originalName);
  await fs.writeFile(storagePath, file.buffer);
  const preview = file.extractedText
    ? { text: file.extractedText, html: escapeHtml(file.extractedText).replace(/\n/g, '<br>') }
    : await extractDocumentPreview(storagePath, originalName);
  const document = {
    fileName: originalName,
    contentType: file.contentType || '',
    storagePath,
    size: file.buffer.length,
    importedAt: new Date().toISOString(),
  };
  return updateTemplate(store, template.id, { document, previewText: preview.text, previewHtml: preview.html });
}

export async function analyzeTemplateVariables(store, id, input = {}, standardVariables = [], aiClient = callAgnesModel) {
  const template = await getTemplate(store, id);
  if (!template) throw new Error('模板不存在');
  const prompt = input.prompt || (await store.readPrompts())[0]?.content || '';
  const text = input.textOverride || template.previewText || template.detail || '';
  const previousExtractedVariables = template.extractedVariables || [];
  const run = {
    id: randomUUID(),
    tool: 'agnes',
    model: agnesConfig.model,
    prompt,
    status: 'success',
    error: '',
    createdAt: new Date().toISOString(),
  };
  let extractedVariables = [];
  let reportTemplateText = '';
  try {
    const output = await aiClient(buildAiInput(prompt, standardVariables, text));
    const report = parseAiReport(output, text);
    reportTemplateText = completeTemplateText(report.templateText, prompt, standardVariables);
    extractedVariables = report.variables;
  } catch (error) {
    run.status = 'failed';
    run.error = error instanceof Error ? error.message : 'AI 提取失败';
    await updateTemplate(store, template.id, {
      aiRuns: [...(template.aiRuns || []), { ...run, extractedCount: 0 }],
    });
    throw new Error(`AI 提取失败：${run.error}`);
  }
  const variableValues = extractDoubleBraceVariables(reportTemplateText);
  if (!variableValues.length) variableValues.push(...extractedVariables.map((item) => item.value));
  extractedVariables = alignVariables(mergeVariables(variableValues, extractedVariables), standardVariables);
  const previewHtml = renderHighlightedTemplate(reportTemplateText, extractedVariables);
  const next = await updateTemplate(store, template.id, {
    previewText: reportTemplateText,
    previewHtml,
    extractedVariables,
    previousExtractedVariables,
    previousPreviewText: template.previewText || '',
    previousPreviewHtml: template.previewHtml || '',
    aiRuns: [...(template.aiRuns || []), { ...run, extractedCount: extractedVariables.length }],
  });
  return next;
}

export async function restoreTemplateVariables(store, id) {
  const template = await getTemplate(store, id);
  if (!template) throw new Error('模板不存在');
  return updateTemplate(store, template.id, {
    extractedVariables: template.previousExtractedVariables || [],
    previousExtractedVariables: [],
    previewText: template.previousPreviewText ?? template.previewText,
    previewHtml: template.previousPreviewHtml ?? template.previewHtml,
    previousPreviewText: '',
    previousPreviewHtml: '',
  });
}

export function getAiConfig() {
  return {
    provider: 'agnes',
    baseUrl: agnesConfig.baseUrl,
    model: agnesConfig.model,
    configured: Boolean(agnesConfig.apiKey),
  };
}

export async function listTemplatePrompts(store) {
  return store.readPrompts();
}

export async function saveTemplatePrompt(store, id, content) {
  const prompts = await store.readPrompts();
  const next = prompts.map((item) => item.id === id ? { ...item, content: String(content || ''), updatedAt: new Date().toISOString() } : item);
  await store.writePrompts(next);
  return next.find((item) => item.id === id);
}

async function extractDocumentPreview(filePath, fileName) {
  if (/\.docx$/i.test(fileName)) {
    try {
      const result = await exec('unzip', ['-p', filePath, 'word/document.xml'], { timeout: 5000 });
      return decodeDocxXml(result.stdout);
    } catch {
      return { text: '', html: '' };
    }
  }
  return { text: '', html: '' };
}

function decodeDocxXml(xml) {
  const source = String(xml || '');
  const tables = [...source.matchAll(/<w:tbl[\s\S]*?<\/w:tbl>/g)].map(([table]) => decodeDocxTable(table));
  const sourceWithoutTables = source.replace(/<w:tbl[\s\S]*?<\/w:tbl>/g, '');
  const html = [
    ...[...sourceWithoutTables.matchAll(/<w:p[\s\S]*?<\/w:p>/g)]
      .map(([paragraph]) => decodeDocxParagraphElement(paragraph)),
    ...tables,
  ].join('');
  const text = source
    .replace(/<w:tab\/>/g, '\t')
    .replace(/<\/w:p>/g, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return { text, html };
}

function decodeDocxParagraphElement(paragraph) {
  return `<p${styleAttribute(paragraphStyle(paragraph))}>${decodeDocxParagraph(paragraph) || '<br>'}</p>`;
}

function decodeDocxParagraph(paragraph) {
  return [...paragraph.matchAll(/<w:r[\s\S]*?<\/w:r>/g)].map(([run]) => {
    let text = [...run.matchAll(/<w:t[^>]*>([\s\S]*?)<\/w:t>/g)].map((match) => decodeEntities(match[1])).join('');
    if (!text && run.includes('<w:tab')) text = '\t';
    if (!text) return '';
    let html = escapeHtml(text).replace(/\t/g, '&emsp;');
    if (run.includes('<w:b')) html = `<strong>${html}</strong>`;
    if (run.includes('<w:i')) html = `<em>${html}</em>`;
    if (run.includes('<w:u')) html = `<u>${html}</u>`;
    const style = styleAttribute(runStyle(run));
    return style ? `<span${style}>${html}</span>` : html;
  }).join('');
}

function decodeDocxTable(table) {
  const rows = [...table.matchAll(/<w:tr[\s\S]*?<\/w:tr>/g)].map(([row]) => {
    const cells = [...row.matchAll(/<w:tc[\s\S]*?<\/w:tc>/g)].map(([cell]) => {
      const content = [...cell.matchAll(/<w:p[\s\S]*?<\/w:p>/g)]
        .map(([paragraph]) => decodeDocxParagraph(paragraph))
        .join('<br>');
      return `<td>${content}</td>`;
    }).join('');
    return `<tr>${cells}</tr>`;
  }).join('');
  return `<table><tbody>${rows}</tbody></table>`;
}

function paragraphStyle(paragraph) {
  const justify = paragraph.match(/<w:jc[^>]*w:val="([^"]+)"/)?.[1];
  const alignments = { center: 'center', right: 'right', both: 'justify' };
  return {
    'text-align': alignments[justify] || '',
  };
}

function runStyle(run) {
  const color = run.match(/<w:color[^>]*w:val="([A-Fa-f0-9]{6})"/)?.[1];
  const size = run.match(/<w:sz[^>]*w:val="(\d+)"/)?.[1];
  const font = run.match(/<w:rFonts[^>]*(?:w:ascii|w:eastAsia)="([^"]+)"/)?.[1];
  return {
    color: color ? `#${color.toUpperCase()}` : '',
    'font-size': size ? `${Number(size) / 2}pt` : '',
    'font-family': font ? `'${font}'` : '',
  };
}

function styleAttribute(style) {
  const css = Object.entries(style)
    .filter(([, value]) => value)
    .map(([key, value]) => `${key}:${value}`)
    .join(';');
  return css ? ` style="${css}"` : '';
}

function decodeEntities(text) {
  return String(text || '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'");
}

function escapeHtml(text) {
  return String(text).replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' })[char]);
}

function extractVariablesFromText(text) {
  const found = new Set();
  for (const match of String(text || '').matchAll(/[【{]{1,2}\s*([A-Za-z][A-Za-z0-9_]*)\s*[】}]{1,2}/g)) {
    found.add(match[1]);
  }
  return [...found].map((value) => ({ name: value, value, valid: true, source: 'local' }));
}

function parseAiReport(output, sourceText = '') {
  const json = extractJsonText(output);
  if (!json.trim()) throw new Error('AI 未返回 JSON');
  let parsed;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new Error('AI 返回内容不是合法 JSON');
  }
  const values = Array.isArray(parsed) ? parsed : findVariablesArray(parsed);
  const templateText = String(parsed.templateText || parsed.template || parsed.reportTemplate || '').trim()
    || String(sourceText || '').trim();
  if (!templateText) throw new Error('AI 输出缺少 templateText');
  const variables = Array.isArray(values) ? values.map((item) => {
    const value = String(item.value || item.variable || item.variable_id || '').trim();
    if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(value)) throw new Error('AI 输出包含不合法变量');
    return { name: String(item.name || value), value, valid: true, source: 'ai' };
  }) : extractDoubleBraceVariables(templateText).map((value) => ({ name: value, value, valid: true, source: 'templateText' }));
  return { templateText, variables };
}

function findVariablesArray(value) {
  if (!value || typeof value !== 'object') return null;
  if (Array.isArray(value.variables)) return value.variables;
  for (const child of Object.values(value)) {
    const found = findVariablesArray(child);
    if (found) return found;
  }
  return null;
}

function extractJsonText(output) {
  const text = String(output || '');
  const fenced = text.match(/```json\s*([\s\S]*?)```/i)?.[1];
  if (fenced) return fenced;
  for (const line of text.split('\n').reverse()) {
    const trimmed = line.trim();
    if ((trimmed.startsWith('{') && trimmed.endsWith('}')) || (trimmed.startsWith('[') && trimmed.endsWith(']'))) return trimmed;
  }
  return text.match(/\{[\s\S]*\}|\[[\s\S]*\]/)?.[0] || '';
}

function buildAiInput(prompt, standardVariables, text) {
  const input = {
    userPrompt: String(prompt || '').trim() || '无额外提示词',
    existingVariables: standardVariables.map((item) => ({
      name: item.name,
      value: item.value,
      type: item.type,
      description: item.description || '',
    })),
    templateContent: String(text || '').trim(),
  };
  return `# 任务
你是签字页报告模板变量提取助手。请参考已存在的变量、参考模板文案，输出替换变量后的全部模板文案。

# 输入参数 JSON
${JSON.stringify(input, null, 2)}

# 输入一：用户提示词
见输入参数 JSON 的 userPrompt。用户提示词中明确指定的变量 value 必须出现在输出中。

# 输入二：系统已有变量
见输入参数 JSON 的 existingVariables。这里是参考已存在的变量；语义相关时必须复用已有变量的 value，不要重新命名。

# 输入三：模板内容
见输入参数 JSON 的 templateContent。这里是参考模板文案；templateText 必须保留完整模板内容，只把变量位置替换为 {{变量值}}。

# 处理步骤
1. 阅读 userPrompt，提取用户明确要求使用或创建的变量 value。
2. 阅读 existingVariables，确定可复用的系统变量。
3. 阅读 templateContent，判断哪些文字应该变量化。
4. 输出替换变量后的全部模板文案到 templateText，并在变量位置插入 {{变量值}}。
5. 从 templateText 中按首次出现顺序去重生成 variables。

# 输出要求
只能输出严格 JSON，不要输出 Markdown，不要解释。JSON 结构如下：
{
  "templateText": "完整报告模板正文，变量位置使用 {{variableId}}",
  "variables": [
    { "name": "变量名", "value": "variableId" }
  ]
}

规则：
1. templateText 必须是完整报告模板，不是摘要。
2. templateText 中必须穿插 {{变量值}}，变量值必须以英文字母开头，只能包含英文、数字、下划线。
3. variables 必须来自 templateText 中出现过的 {{变量值}}，并按首次出现顺序去重。
4. 如果变量能和“系统已有变量”匹配，value 必须使用已有变量的 value。
5. 如果没有匹配的已有变量，可以创建新 value，并在 variables 中给出中文 name。
6. 如果 userPrompt 明确指定某个 value，例如 companyName 或 signerName，且模板内容有对应语义位置，必须在 templateText 中使用该 value。

示例：
输入模板内容为“公司名称：星河科技股份有限公司”，已有变量包含 {"name":"公司名称","value":"companyName"} 时，应输出：
{"templateText":"公司名称：{{companyName}}","variables":[{"name":"公司名称","value":"companyName"}]}`;
}

function extractDoubleBraceVariables(text) {
  return [...new Set([...String(text || '').matchAll(/\{\{\s*([A-Za-z][A-Za-z0-9_]*)\s*\}\}/g)].map((match) => match[1]))];
}

function completeTemplateText(templateText, prompt, standardVariables) {
  let text = String(templateText || '');
  if (extractDoubleBraceVariables(text).length) return text;
  for (const variable of standardVariables) {
    if (text.includes(variable.name)) text = replaceLabeledValue(text, variable.name, variable.value);
  }
  for (const hint of extractPromptVariableHints(prompt, text)) {
    text = replaceLabeledValue(text, hint.label, hint.value);
  }
  return text;
}

function replaceLabeledValue(text, label, value) {
  const escapedLabel = escapeRegExp(label);
  return text.replace(new RegExp(`(${escapedLabel}\\s*[：:])([^\\n\\r]+)`, 'g'), `$1{{${value}}}`);
}

function extractPromptVariableHints(prompt, templateText) {
  const hints = [];
  for (const label of extractTemplateLabels(templateText)) {
    const pattern = new RegExp(`${escapeRegExp(label)}[^，。；\\n\\r]*?([A-Za-z][A-Za-z0-9_]{2,})`);
    const value = String(prompt || '').match(pattern)?.[1];
    if (value) hints.push({ label, value });
  }
  for (const match of String(prompt || '').matchAll(/([\u4e00-\u9fa5]{2,12})[^，。；\n\r]*?([A-Za-z][A-Za-z0-9_]{2,})/g)) {
    hints.push({ label: match[1].replace(/^将/, ''), value: match[2] });
  }
  return hints;
}

function extractTemplateLabels(text) {
  return [...new Set([...String(text || '').matchAll(/(^|\n)\s*([\u4e00-\u9fa5A-Za-z0-9_（）()]{2,20})\s*[：:]/g)].map((match) => match[2]))];
}

function escapeRegExp(text) {
  return String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function mergeVariables(variableValues, aiVariables) {
  const byValue = new Map(aiVariables.map((item) => [item.value, item]));
  return variableValues.map((value) => byValue.get(value) || { name: value, value, valid: true, source: 'templateText' });
}

function renderHighlightedTemplate(text, variables) {
  const known = new Map(variables.map((item) => [item.value, item]));
  return escapeHtml(text).replace(/\{\{\s*([A-Za-z][A-Za-z0-9_]*)\s*\}\}/g, (_, value) => {
    const variable = known.get(value);
    const status = variable?.matchStatus === 'existing' ? 'existing' : 'new';
    return `<span class="variable-chip" data-status="${status}" data-variable="${value}">{{${value}}}</span>`;
  }).replace(/\n/g, '<br>');
}

async function callAgnesModel(content) {
  if (!agnesConfig.apiKey) throw new Error('缺少 Agnes API Key');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 60000);
  try {
    const response = await fetch(`${agnesConfig.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${agnesConfig.apiKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: agnesConfig.model,
        messages: [
          { role: 'system', content: '你是签字页报告模板变量提取助手。必须输出严格 JSON，且必须包含 templateText 和 variables 两个字段；templateText 必须是完整报告模板正文，并在变量位置穿插 {{变量值}}。' },
          { role: 'user', content },
        ],
        temperature: 0,
        response_format: { type: 'json_object' },
      }),
      signal: controller.signal,
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.error?.message || `Agnes API 请求失败：${response.status}`);
    const message = body.choices?.[0]?.message?.content;
    if (!message) throw new Error('Agnes API 未返回内容');
    return message;
  } catch (error) {
    if (error.name === 'AbortError') throw new Error('Agnes API 调用超时');
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

function alignVariables(extractedVariables, standardVariables) {
  const byValue = new Map(standardVariables.map((item) => [String(item.value).toLowerCase(), item]));
  const byName = new Map(standardVariables.map((item) => [String(item.name).toLowerCase(), item]));
  const seen = new Set();
  return extractedVariables
    .map((item) => {
      const matched = byValue.get(String(item.value).toLowerCase()) || byName.get(String(item.name).toLowerCase());
      const value = matched?.value || item.value;
      if (seen.has(value)) return null;
      seen.add(value);
      return {
        ...item,
        name: matched?.name || item.name,
        value,
        matchStatus: matched ? 'existing' : 'new',
        matchedVariable: matched || null,
        creationHint: matched ? '' : '变量管理中不存在，需创建后再用于正式模板绑定',
      };
    })
    .filter(Boolean);
}

function buildTemplate(input, current, fallbackId) {
  const timestamp = new Date().toISOString();
  const template = {
    id: Number(input.id || fallbackId),
    name: String(input.name || '').trim(),
    detail: String(input.detail || '').trim(),
    document: input.document || current?.document || null,
    previewText: String(input.previewText ?? current?.previewText ?? ''),
    previewHtml: String(input.previewHtml ?? current?.previewHtml ?? ''),
    extractedVariables: input.extractedVariables || current?.extractedVariables || [],
    previousExtractedVariables: input.previousExtractedVariables || current?.previousExtractedVariables || [],
    previousPreviewText: String(input.previousPreviewText ?? current?.previousPreviewText ?? ''),
    previousPreviewHtml: String(input.previousPreviewHtml ?? current?.previousPreviewHtml ?? ''),
    aiRuns: input.aiRuns || current?.aiRuns || [],
    status: input.status || current?.status || 'active',
    createdAt: current?.createdAt || timestamp,
    updatedAt: timestamp,
    changeLogs: current?.changeLogs ? [...current.changeLogs] : [],
  };
  if (!Number.isFinite(template.id)) throw new Error('模板id必须是数字');
  if (!template.name) throw new Error('模板名称不能为空');
  return template;
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

function snapshot(template) {
  return {
    id: template.id,
    name: template.name,
    detail: template.detail,
    document: template.document,
    previewText: template.previewText,
    extractedVariables: template.extractedVariables,
    status: template.status,
    createdAt: template.createdAt,
    updatedAt: template.updatedAt,
  };
}

function audit(action, resourceValue, detail) {
  return {
    id: randomUUID(),
    action,
    resourceType: 'template',
    resourceValue,
    operator,
    detail,
    createdAt: new Date().toISOString(),
  };
}

function summarizeChange(before, after) {
  const labels = {
    name: '模板名称',
    detail: '模板详情',
    document: '导入模板',
    previewText: '模板预览',
    extractedVariables: '提取变量',
    status: '状态',
  };
  const changed = Object.keys(labels).filter((key) => JSON.stringify(before[key]) !== JSON.stringify(after[key]));
  return changed.length ? `更新${changed.map((key) => labels[key]).join('、')}` : '保存模板';
}

function defaultPrompts() {
  return [{
    id: 'extract-template-variables',
    name: '提取模板变量',
    content: '请识别模板中适合变量化的内容。优先复用系统已有变量；没有对应变量时再创建新的变量值。输出完整报告模板正文，并在变量位置使用 {{变量值}}。',
    updatedAt: new Date().toISOString(),
  }];
}
