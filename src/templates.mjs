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
  const sourceText = input.textOverride || template.previewText || template.detail || '';
  const sourceHtml = normalizePreviewHtml(input.textHtml || template.previewHtml || '');
  const isHtml = hasHtmlMarkup(sourceHtml);
  const templateContent = isHtml ? sourceHtml : sourceText;
  const currentTemplateVariables = template.extractedVariables || [];
  const previousExtractedVariables = currentTemplateVariables;
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
  let aiInputText = '';
  let aiOutputText = '';
  try {
    aiInputText = buildAiInput(prompt, standardVariables, currentTemplateVariables, templateContent);
    aiOutputText = await aiClient(aiInputText);
    const report = parseAiReport(aiOutputText, templateContent);
    if (report.replacements?.length) {
      const applied = applyReplacements(templateContent, report.replacements);
      reportTemplateText = applied.text;
      extractedVariables = applied.items.map((item) => ({ name: item.name, value: item.value, valid: true, source: 'ai' }));
    } else if (report.templateText.trim() !== String(templateContent || '').trim()) {
      // AI 返回了重写全文（旧格式）：按占位符前后锚点对齐推断片段映射，回到原始模板上替换以保留格式
      const nameByValue = new Map(report.variables.map((item) => [item.value, item.name]));
      const derived = deriveReplacementsFromText(templateContent, report.templateText)
        .map((item) => ({ ...item, name: nameByValue.get(item.value) || item.name }));
      const applied = applyReplacements(templateContent, derived);
      if (applied.items.length) {
        reportTemplateText = applied.text;
        extractedVariables = applied.items.map((item) => ({ name: item.name, value: item.value, valid: true, source: 'ai' }));
      } else {
        reportTemplateText = report.templateText;
        extractedVariables = report.variables;
      }
    } else {
      reportTemplateText = report.templateText;
      extractedVariables = report.variables;
    }
    reportTemplateText = completeTemplateText(reportTemplateText, prompt, standardVariables);
  } catch (error) {
    run.status = 'failed';
    run.error = error instanceof Error ? error.message : 'AI 提取失败';
    await updateTemplate(store, template.id, {
      aiRuns: [...(template.aiRuns || []), { ...run, extractedCount: 0 }],
      aiDebug: {
        input: aiInputText,
        output: aiOutputText,
        error: run.error,
        createdAt: new Date().toISOString(),
      },
    });
    throw new Error(`AI 提取失败：${run.error}`);
  }
  const variableValues = extractDoubleBraceVariables(reportTemplateText);
  if (!variableValues.length) variableValues.push(...extractedVariables.map((item) => item.value));
  extractedVariables = alignVariables(mergeVariables(variableValues, extractedVariables), standardVariables);
  const previewHtml = renderHighlightedTemplate(reportTemplateText, extractedVariables, isHtml);
  const next = await updateTemplate(store, template.id, {
    previewText: isHtml ? htmlToPlainText(reportTemplateText) : reportTemplateText,
    previewHtml,
    extractedVariables,
    previousExtractedVariables,
    previousPreviewText: template.previewText || '',
    previousPreviewHtml: template.previewHtml || '',
    aiRuns: [...(template.aiRuns || []), { ...run, extractedCount: extractedVariables.length }],
    aiDebug: {
      input: aiInputText,
      output: aiOutputText,
      error: '',
      createdAt: new Date().toISOString(),
    },
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
  const replacements = findReplacementsArray(parsed);
  if (Array.isArray(replacements) && replacements.length) {
    return {
      replacements: replacements.map((item) => {
        const value = String(item.value || '').trim();
        const original = String(item.original || item.source || item.text || '').trim();
        if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(value)) throw new Error('AI 输出包含不合法变量');
        if (!original) throw new Error('AI 输出的 replacement 缺少 original 片段');
        return { original, name: String(item.name || value), value, valid: true, source: 'ai' };
      }),
      templateText: '',
      variables: [],
    };
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
  return { replacements: [], templateText, variables };
}

function findReplacementsArray(value) {
  if (!value || typeof value !== 'object') return null;
  if (Array.isArray(value.replacements)) return value.replacements;
  for (const child of Object.values(value)) {
    const found = findReplacementsArray(child);
    if (found) return found;
  }
  return null;
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
  const candidates = [];
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1];
  if (fenced) candidates.push(fenced.trim());
  candidates.push(text.trim());
  const braced = text.match(/\{[\s\S]*\}|\[[\s\S]*\]/)?.[0];
  if (braced) candidates.push(braced);
  for (const line of text.split('\n').reverse()) {
    const trimmed = line.trim();
    if ((trimmed.startsWith('{') && trimmed.endsWith('}')) || (trimmed.startsWith('[') && trimmed.endsWith(']'))) candidates.push(trimmed);
  }
  for (const candidate of candidates) {
    if (!candidate) continue;
    try {
      JSON.parse(candidate);
      return candidate;
    } catch {
      // 不是合法 JSON，尝试下一个候选
    }
  }
  return text.trim();
}

function buildAiInput(prompt, standardVariables, currentTemplateVariables, templateContent) {
  const input = {
    userPrompt: String(prompt || '').trim() || '无额外提示词',
    existingVariables: standardVariables.map((item) => ({
      name: item.name,
      value: item.value,
      type: item.type,
      description: item.description || '',
    })),
    currentTemplateVariables: (currentTemplateVariables || []).map((item) => ({
      name: item.name,
      value: item.value,
    })),
    templateContent: String(templateContent || '').trim(),
  };
  return `提取签字页模板中按签署方变化的动态内容（公司名称、签署人、日期、编号等），供批量生成正式签署页时替换为各签署方的实际值；固定描述文字保持原样。

# 输入
${JSON.stringify(input, null, 2)}
- userPrompt：用户提示词，其中明确指定的变量 value 必须采用
- existingVariables：系统已有变量，语义相关时必须复用其 value，不要重新命名
- currentTemplateVariables：本模板上次提取的变量，语义相关时优先沿用
- templateContent：模板全文，含原始 HTML 标签（表格、加粗、下划线等）

# 输出（严格 JSON，禁止 Markdown 与解释，禁止输出 templateText 或重写模板）
{"replacements":[{"original":"需要变量化的原文精确片段","name":"变量中文名","value":"variableId"}]}

规则：
1. original 必须是 templateContent 的连续子串，逐字符一致（含空格、标点），不要包含 HTML 标签（给“【张三】”而非“<u>【张三】</u>”）；系统会在原模板上替换所有出现的 original，标签与格式自动保留。
2. 只变量化动态内容；“本页无正文”、法规全称等固定文字不要输出。
3. value 以英文字母开头，仅含英文、数字、下划线。
4. 语义相关时必须复用已有变量 value；无匹配才创建新 value 并配中文 name。

示例：templateContent 为“公司名称：<u>星河科技</u>，日期：2026年9月3日”时输出：
{"replacements":[{"original":"星河科技","name":"公司名称","value":"companyName"},{"original":"2026年9月3日","name":"签署日期","value":"signDate"}]}`;
}

function applyReplacements(source, replacements) {
  const sorted = [...replacements].sort((a, b) => b.original.length - a.original.length);
  let text = String(source || '');
  const items = [];
  for (const item of sorted) {
    if (!item.original) continue;
    const target = findReplacementTarget(text, item.original);
    if (!target) continue;
    text = text.split(target).join(`{{${item.value}}}`);
    items.push(item);
  }
  return { text, items };
}

function findReplacementTarget(source, original) {
  if (!/<[^>]+>/.test(original)) {
    return source.includes(original) ? original : '';
  }
  // 片段含 HTML 标签时按优先级降级匹配，保证模板原有标签与固定标签词不被吃掉：
  // 1. 剥离全部标签后的纯文本整体（如“<u>【张三】</u>” → “【张三】”，<u> 原样保留）
  // 2. 最后一个文本段（如“日期：<strong>2026年</strong>” → “2026年”，保留“日期：”与 <strong>）
  const stripped = original.replace(/<[^>]+>/g, '').trim();
  if (stripped && source.includes(stripped)) return stripped;
  const textSegments = original.split(/(<[^>]+>)/).filter((segment) => !/^<[^>]+>$/.test(segment) && segment.trim());
  const last = textSegments.at(-1)?.trim();
  if (last && source.includes(last)) return last;
  return '';
}

function deriveReplacementsFromText(source, templateText) {
  const sourceText = String(source || '');
  const parts = String(templateText || '').split(/(\{\{\s*[A-Za-z][A-Za-z0-9_]*\s*\}\})/);
  const replacements = [];
  let cursor = 0;
  let pendingValue = '';
  for (const part of parts) {
    if (!part) continue;
    const placeholder = part.match(/^\{\{\s*([A-Za-z][A-Za-z0-9_]*)\s*\}\}$/);
    if (placeholder) {
      pendingValue = placeholder[1];
      continue;
    }
    const index = sourceText.indexOf(part, cursor);
    if (index < 0) {
      pendingValue = '';
      continue;
    }
    if (pendingValue && index > cursor) {
      replacements.push({ original: sourceText.slice(cursor, index), name: pendingValue, value: pendingValue });
    }
    pendingValue = '';
    cursor = index + part.length;
  }
  return replacements;
}

function hasHtmlMarkup(html) {
  return /<\/?[a-z][^>]*>/i.test(String(html || ''));
}

function normalizePreviewHtml(html) {
  return String(html || '').replace(/<span class="variable-chip"[^>]*>(\{\{[^<]*?\}\})<\/span>/g, '$1');
}

function sanitizeHtml(html) {
  return String(html || '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/\son[a-z]+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, '')
    .replace(/javascript:/gi, '');
}

function htmlToPlainText(html) {
  return String(html || '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|tr|table|h[1-6]|li)>/gi, '\n')
    .replace(/<\/t[dh]>/gi, '\t')
    .replace(/<[^>]+>/g, '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#039;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
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
  return text.replace(new RegExp(`(${escapedLabel}\\s*[：:])([^\\n\\r<>]+)`, 'g'), `$1{{${value}}}`);
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

function renderHighlightedTemplate(text, variables, isHtml = false) {
  const known = new Map(variables.map((item) => [item.value, item]));
  const renderChip = (_, value) => {
    const variable = known.get(value);
    const status = variable?.matchStatus === 'existing' ? 'existing' : 'new';
    return `<span class="variable-chip" data-status="${status}" data-variable="${value}">{{${value}}}</span>`;
  };
  const source = String(text || '');
  if (isHtml) {
    return sanitizeHtml(source).replace(/\{\{\s*([A-Za-z][A-Za-z0-9_]*)\s*\}\}/g, renderChip);
  }
  return escapeHtml(source).replace(/\{\{\s*([A-Za-z][A-Za-z0-9_]*)\s*\}\}/g, renderChip).replace(/\n/g, '<br>');
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
          { role: 'system', content: '你是签字页报告模板变量提取助手。必须输出严格 JSON，且必须包含 replacements 字段；replacements 中每项必须包含 original（模板原文的精确片段，不要包含 HTML 标签）、name（中文变量名）、value（英文变量值）。' },
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
      const dedupKey = String(value).toLowerCase();
      if (seen.has(dedupKey)) return null;
      seen.add(dedupKey);
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
    aiDebug: input.aiDebug || current?.aiDebug || null,
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
    content: `提取模板中按签署方变化的动态内容（公司名称、签署人、日期、编号等）并变量化，供批量生成正式签署页时替换为各签署方的实际值；固定描述文字保持原样。

【输入】existingVariables（系统已有变量）、currentTemplateVariables（本模板上次提取的变量）、templateContent（模板全文，含 HTML 格式）

【输出】只输出严格 JSON：{"replacements":[{"original":"需要变量化的原文精确片段","name":"变量中文名","value":"variableId"}]}

【规则】
1. original 必须是 templateContent 的连续子串、逐字符一致，不要包含 HTML 标签（给"【张三】"而非"<u>【张三】</u>"）；系统会在原模板上替换，标签与格式自动保留；
2. 只变量化动态内容，"本页无正文"、法规全称等固定文字不要输出；
3. value 以英文字母开头，仅含英文、数字、下划线；
4. 语义相关时必须复用 existingVariables 或 currentTemplateVariables 的 value；无匹配才创建新 value 并配中文 name。`,
    updatedAt: new Date().toISOString(),
  }];
}
