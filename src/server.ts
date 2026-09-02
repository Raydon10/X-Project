import express from 'express';
import cors from 'cors';
import multer from 'multer';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import archiver from 'archiver';
import * as XLSX from 'xlsx';
import { Document, Packer, Paragraph, TextRun } from 'docx';
import { can, type Action, type ImportRow, type Role } from './domain';
import { WorkspaceStore, type AiSuggestion, type GenerationResult, type GenerationTask } from './store';

const exec = promisify(execFile);
const app = express();
const store = new WorkspaceStore(path.join(process.cwd(), 'workspace'));
const upload = multer({ dest: path.join(os.tmpdir(), 'signature-page-uploads') });
await store.initialize();
app.use(cors());
app.use(express.json({ limit: '2mb' }));
const roles: Role[] = ['project_owner', 'assistant', 'reviewer', 'template_admin'];
function roleOf(req: express.Request): Role {
  const role = req.header('x-demo-role') as Role;
  if (!roles.includes(role)) throw new Error('请在界面选择有效的演示角色');
  return role;
}
function requireAction(action: Action) {
  return (req: express.Request, res: express.Response, next: express.NextFunction) => {
    try { const role = roleOf(req); if (!can(role, action)) return res.status(403).json({ message: '当前角色没有此操作权限' }); next(); }
    catch (error) { res.status(400).json({ message: error instanceof Error ? error.message : '无效请求' }); }
  };
}
async function audit(role: Role, action: string, detail: string) { await store.audit({ at: new Date().toISOString(), role, action, detail }); }
function mapRow(row: Record<string, unknown>): ImportRow {
  return { participantName: String(row['参与方名称'] ?? row.participantName ?? '').trim(), participantType: String(row['参与方类型'] ?? row.participantType ?? '').trim(), companyName: String(row['公司名称'] ?? row.companyName ?? '').trim(), representativeName: String(row['法定代表人'] ?? row.representativeName ?? '').trim(), meetingDate: String(row['会议日期'] ?? row.meetingDate ?? '').trim() };
}
function validate(rows: ImportRow[]) {
  const errors: Array<{ row: number; field: string; code: string; message: string }> = [];
  rows.forEach((row, index) => {
    for (const field of ['participantName', 'participantType', 'companyName'] as const) if (!row[field]?.trim()) errors.push({ row: index + 2, field, code: 'MISSING_REQUIRED', message: field + ' 为必填项' });
    if (row.meetingDate && Number.isNaN(Date.parse(row.meetingDate))) errors.push({ row: index + 2, field: 'meetingDate', code: 'INVALID_DATE', message: '会议日期不是有效日期' });
  });
  return { valid: errors.length === 0, errors };
}
function placeholders(text: string) { return [...text.matchAll(/【([^】]+)】/g)].map((match) => match[1]); }
app.get('/api/state', async (_req, res) => res.json({ project: await store.getProject(), template: await store.getTemplate(), rows: await store.getRows(), tasks: await store.getTasks(), audit: await store.getAudit() }));
app.post('/api/project', requireAction('create_project'), async (req, res) => { const role = roleOf(req); const current = await store.getProject(); await store.saveProject({ ...current, name: String(req.body.name || current.name), status: 'data_preparing' }); await audit(role, 'PROJECT_UPDATED', '更新项目名称'); res.json(await store.getProject()); });
app.post('/api/template/upload', requireAction('confirm_ai'), upload.single('file'), async (req, res) => {
  const role = roleOf(req); if (!req.file) return res.status(400).json({ message: '请选择 DOCX 文件' }); await fs.copyFile(req.file.path, path.join(store.root, 'source-template.docx'));
  const template = await store.getTemplate(); await store.saveTemplate({ ...template, name: req.file.originalname }); await audit(role, 'TEMPLATE_UPLOADED', req.file.originalname); res.json(await store.getTemplate());
});
app.post('/api/templates/:id/analyze-variables', requireAction('confirm_ai'), async (req, res) => {
  const role = roleOf(req); const template = await store.getTemplate(); const fallback = placeholders(template.text).map((sourceText) => ({ sourceText, suggestedVariable: sourceText, confidence: 1, reason: '从预置模板占位符读取' }));
  const prompt = '只返回 JSON 数组，不要 Markdown。根据模板文本与标准变量库识别变量。模板：' + template.text + '。标准变量：companyName, meetingDate, participantName, participantType, representativeName。';
  let suggestions: AiSuggestion[] = fallback;
  try { const outputPath = path.join(os.tmpdir(), 'signature-ai-' + Date.now() + '.json'); await exec('codex', ['exec', '--skip-git-repo-check', '--output-last-message', outputPath, prompt], { timeout: 45000 }); suggestions = JSON.parse(await fs.readFile(outputPath, 'utf8')) as AiSuggestion[]; } catch { /* preserves fallback */ }
  await store.saveTemplate({ ...template, suggestions }); await audit(role, 'AI_ANALYZED_TEMPLATE', String(suggestions.length) + ' 条建议'); res.json({ suggestions });
});
app.post('/api/template/confirm-suggestions', requireAction('confirm_ai'), async (req, res) => { const role = roleOf(req); const template = await store.getTemplate(); const variables = Array.isArray(req.body.variables) ? req.body.variables.map(String) : template.variables; await store.saveTemplate({ ...template, variables, suggestions: [] }); await audit(role, 'AI_SUGGESTIONS_CONFIRMED', variables.join(', ')); res.json(await store.getTemplate()); });
app.post('/api/imports/preview', requireAction('import_data'), upload.single('file'), async (req, res) => {
  const role = roleOf(req); if (!req.file) return res.status(400).json({ message: '请选择 Excel 文件' }); const book = XLSX.read(await fs.readFile(req.file.path)); const sheet = book.Sheets[book.SheetNames[0]]; const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, { defval: '' }).map(mapRow); const validation = validate(rows); await audit(role, 'IMPORT_PREVIEWED', String(rows.length) + ' 行'); res.json({ rows, validation });
});
app.post('/api/imports/confirm', requireAction('import_data'), async (req, res) => { const role = roleOf(req); const rows = req.body.rows as ImportRow[]; const validation = validate(rows); if (!validation.valid) return res.status(422).json({ ...validation, message: '请修复校验问题后再导入' }); await store.saveRows(rows); await audit(role, 'IMPORT_CONFIRMED', String(rows.length) + ' 行'); res.json({ rows }); });
app.post('/api/rows/:index', requireAction('repair_data'), async (req, res) => { const role = roleOf(req); const rows = await store.getRows(); const index = Number(req.params.index); if (!rows[index]) return res.status(404).json({ message: '未找到数据行' }); rows[index] = { ...rows[index], ...req.body }; await store.saveRows(rows); await audit(role, 'DATA_REPAIRED', '第 ' + String(index + 2) + ' 行'); res.json({ row: rows[index], validation: validate(rows) }); });
async function createDocx(result: GenerationResult, taskId: string) {
  const template = await store.getTemplate(); const text = Object.entries(result.snapshot).reduce((value, [key, replacement]) => value.replaceAll('【' + key + '】', replacement), template.text);
  const document = new Document({ sections: [{ properties: {}, children: text.split('\n').map((line) => new Paragraph({ children: [new TextRun({ text: line || ' ', font: 'STHeiti' })] })) }] }); const directory = store.resultDirectory(taskId); await fs.mkdir(directory, { recursive: true }); const filename = result.id + '-v' + result.version + '.docx'; await fs.writeFile(path.join(directory, filename), await Packer.toBuffer(document)); return filename;
}
async function generate(taskId: string, targetIds?: string[]) {
  const rows = await store.getRows(); const tasks = await store.getTasks(); const existing = tasks.find((task) => task.id === taskId); const oldResults = existing?.results ?? [];
  const candidates = targetIds ? oldResults.filter((result) => targetIds.includes(result.id)) : rows.map((row, index) => ({ id: taskId + '-' + String(index + 1), participantName: row.participantName || '', participantType: row.participantType || '', status: 'failed' as const, version: 1, snapshot: row as Record<string, string> }));
  const next = await Promise.all(candidates.map(async (result) => { const missing = ['participantName', 'participantType', 'companyName'].find((field) => !result.snapshot[field]); if (missing) return { ...result, status: 'failed' as const, error: missing + ' 缺失' }; const version = targetIds ? result.version + 1 : result.version; const draft = { ...result, version, status: 'success' as const, error: undefined }; return { ...draft, file: await createDocx(draft, taskId) }; }));
  const results = targetIds ? oldResults.map((item) => next.find((candidate) => candidate.id === item.id) ?? item) : next;
  const task: GenerationTask = { id: taskId, createdAt: existing?.createdAt ?? new Date().toISOString(), status: results.some((result) => result.status === 'failed') ? 'partial_failed' : 'completed', results, submittedForReview: existing?.submittedForReview ?? false, reviewStatus: existing?.reviewStatus, reviewComment: existing?.reviewComment };
  await store.saveTasks(existing ? tasks.map((item) => item.id === taskId ? task : item) : [...tasks, task]); return task;
}
app.post('/api/generation-tasks', requireAction('start_generation'), async (req, res) => { const role = roleOf(req); const task = await generate('task_' + Date.now()); await audit(role, 'GENERATION_STARTED', task.id); res.json(task); });
app.post('/api/results/:id/retry', requireAction('repair_data'), async (req, res) => { const role = roleOf(req); const resultId = String(req.params.id); const task = (await store.getTasks()).find((item) => item.results.some((result) => result.id === resultId)); if (!task) return res.status(404).json({ message: '未找到生成结果' }); const next = await generate(task.id, [resultId]); await audit(role, 'RESULT_RETRIED', resultId); res.json(next); });
app.post('/api/reviews', requireAction('submit_review'), async (req, res) => { const role = roleOf(req); const tasks = await store.getTasks(); const task = tasks.find((item) => item.id === req.body.taskId); if (!task || task.status !== 'completed') return res.status(422).json({ message: '仅全部成功的任务可提交审核' }); task.submittedForReview = true; await store.saveTasks(tasks); await audit(role, 'REVIEW_SUBMITTED', task.id); res.json(task); });
app.post('/api/reviews/:id/decision', requireAction('decide_review'), async (req, res) => { const role = roleOf(req); const tasks = await store.getTasks(); const task = tasks.find((item) => item.id === req.params.id); if (!task?.submittedForReview) return res.status(422).json({ message: '任务尚未提交审核' }); task.reviewStatus = req.body.decision === 'approved' ? 'approved' : 'rejected'; task.reviewComment = String(req.body.comment || ''); await store.saveTasks(tasks); await audit(role, 'REVIEW_DECIDED', task.id + ':' + task.reviewStatus); res.json(task); });
app.get('/api/exports/:taskId', requireAction('export'), async (req, res) => { const task = (await store.getTasks()).find((item) => item.id === req.params.taskId); if (!task || task.reviewStatus !== 'approved') return res.status(422).json({ message: '仅审核通过的任务可导出' }); res.attachment(task.id + '-签字页.zip'); const archive = archiver('zip'); archive.pipe(res); for (const result of task.results.filter((item) => item.status === 'success' && item.file)) archive.file(path.join(store.resultDirectory(task.id), result.file!), { name: result.participantType + '/' + result.participantName + '.docx' }); await archive.finalize(); });
app.use((error: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => res.status(500).json({ message: error.message || '服务异常' }));
app.listen(8787, () => console.log('Signature Page API running on http://localhost:8787'));
