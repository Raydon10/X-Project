import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { ImportRow, Role } from './domain';

export type Project = { id: string; name: string; status: 'draft' | 'data_preparing' | 'ready_to_generate' | 'generating' | 'pending_review' | 'approved' | 'rejected' };
export type Template = { id: string; name: string; text: string; variables: string[]; suggestions: AiSuggestion[] };
export type AiSuggestion = { sourceText: string; suggestedVariable: string; confidence: number; reason: string };
export type GenerationResult = { id: string; participantName: string; participantType: string; status: 'success' | 'failed'; error?: string; file?: string; version: number; snapshot: Record<string, string> };
export type GenerationTask = { id: string; status: 'completed' | 'partial_failed'; createdAt: string; results: GenerationResult[]; submittedForReview: boolean; reviewStatus?: 'approved' | 'rejected'; reviewComment?: string };
export type AuditEvent = { at: string; role: Role; action: string; detail: string };

const defaultTemplate: Template = {
  id: 'tpl_ipo_signature', name: 'IPO 签字页模板',
  text: '【companyName】关于【meetingDate】临时股东大会会议决议之签字页\n\n签字主体：【participantName】\n类型：【participantType】\n法定代表人：【representativeName】',
  variables: ['companyName', 'meetingDate', 'participantName', 'participantType', 'representativeName'], suggestions: [],
};
const defaultProject: Project = { id: 'project_demo', name: '星河科技 IPO 签字页项目', status: 'data_preparing' };

export class WorkspaceStore {
  constructor(public readonly root: string) {}
  private file(name: string) { return path.join(this.root, name); }
  private async read<T>(name: string, fallback: T): Promise<T> {
    try { return JSON.parse(await fs.readFile(this.file(name), 'utf8')) as T; } catch { return fallback; }
  }
  private async write(name: string, value: unknown) {
    await fs.mkdir(this.root, { recursive: true });
    const temporary = `${this.file(name)}.${randomUUID()}.tmp`;
    await fs.writeFile(temporary, JSON.stringify(value, null, 2), 'utf8');
    await fs.rename(temporary, this.file(name));
  }
  async initialize() {
    await fs.mkdir(path.join(this.root, 'results'), { recursive: true });
    if (!(await this.exists('project.json'))) await this.write('project.json', defaultProject);
    if (!(await this.exists('template.json'))) await this.write('template.json', defaultTemplate);
    if (!(await this.exists('rows.json'))) await this.write('rows.json', []);
    if (!(await this.exists('tasks.json'))) await this.write('tasks.json', []);
    if (!(await this.exists('audit.ndjson'))) await fs.writeFile(this.file('audit.ndjson'), '');
  }
  private async exists(name: string) { try { await fs.access(this.file(name)); return true; } catch { return false; } }
  async getProject() { return this.read<Project>('project.json', defaultProject); }
  async saveProject(project: Project) { await this.write('project.json', project); }
  async getTemplate() { return this.read<Template>('template.json', defaultTemplate); }
  async saveTemplate(template: Template) { await this.write('template.json', template); }
  async getRows() { return this.read<ImportRow[]>('rows.json', []); }
  async saveRows(rows: ImportRow[]) { await this.write('rows.json', rows); }
  async getTasks() { return this.read<GenerationTask[]>('tasks.json', []); }
  async saveTasks(tasks: GenerationTask[]) { await this.write('tasks.json', tasks); }
  async audit(event: AuditEvent) { await fs.appendFile(this.file('audit.ndjson'), `${JSON.stringify(event)}\n`, 'utf8'); }
  async getAudit() { const text = await fs.readFile(this.file('audit.ndjson'), 'utf8'); return text.trim() ? text.trim().split('\n').map((line) => JSON.parse(line) as AuditEvent) : []; }
  resultDirectory(taskId: string) { return path.join(this.root, 'results', taskId); }
}
