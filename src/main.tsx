import { useEffect, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import type { Role } from './domain';
import { roleLabels } from './domain';
import './style.css';

type State = any;
const roleActions: Record<Role, string[]> = {
  project_owner: ['创建/更新项目', '发起生成', '提交审核', '导出'],
  assistant: ['导入 Excel', '修正数据', '重试失败项'],
  reviewer: ['审核通过', '审核驳回'],
  template_admin: ['上传模板', 'AI 变量识别', '确认变量'],
};
async function api(url: string, role: Role, options: RequestInit = {}) {
  const response = await fetch(url, { ...options, headers: { 'x-demo-role': role, ...(options.headers || {}) } });
  const type = response.headers.get('content-type') || '';
  const body = type.includes('application/json') ? await response.json() : await response.blob();
  if (!response.ok) throw new Error(body.message || '请求失败');
  return body;
}
function App() {
  const [role, setRole] = useState<Role>('project_owner');
  const [state, setState] = useState<State>();
  const [message, setMessage] = useState('选择角色后按引导完成项目流转。');
  const [pendingRows, setPendingRows] = useState<any[]>([]);
  const [busy, setBusy] = useState(false);
  const refresh = async () => setState(await api('/api/state', role));
  useEffect(() => { refresh().catch((error) => setMessage(error.message)); }, []);
  const execute = async (label: string, run: () => Promise<any>) => {
    setBusy(true);
    try { await run(); await refresh(); setMessage(label + '已完成。'); } catch (error) { setMessage(error instanceof Error ? error.message : '操作失败'); } finally { setBusy(false); }
  };
  const currentTask = useMemo(() => state?.tasks?.[state.tasks.length - 1], [state]);
  const download = async () => {
    try { const blob = await api('/api/exports/' + currentTask.id, role); const link = document.createElement('a'); link.href = URL.createObjectURL(blob); link.download = '签字页.zip'; link.click(); URL.revokeObjectURL(link.href); setMessage('ZIP 已下载。'); } catch (error) { setMessage(error instanceof Error ? error.message : '导出失败'); }
  };
  if (!state) return <main>正在加载本地工作区…</main>;
  return <main>
    <header><div><p className="eyebrow">SIGNATURE PAGE WORKBENCH</p><h1>签字页项目工作台</h1><p>{state.project.name} · 单账号多角色演示</p></div><div className="role"><label>当前演示角色</label><select value={role} onChange={(e) => setRole(e.target.value as Role)}>{Object.entries(roleLabels).map(([id, label]) => <option key={id} value={id}>{label}</option>)}</select><small>可操作：{roleActions[role].join('、')}</small></div></header>
    <div className="notice">{message}</div>
    <section className="steps"><b>任务流</b><span>负责人建项目</span><i>→</i><span>管理员配置模板</span><i>→</i><span>助理导入/修正</span><i>→</i><span>负责人生成/提交</span><i>→</i><span>审核人审核</span></section>
    <div className="grid">
      <section className="card"><h2>1. 项目与模板</h2><input defaultValue={state.project.name} id="project-name" /><button disabled={busy} onClick={() => execute('项目更新', () => api('/api/project', role, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: (document.getElementById('project-name') as HTMLInputElement).value }) }))}>保存项目</button>
        <p>当前模板：<b>{state.template.name}</b></p><label className="upload">上传 DOCX<input type="file" accept=".docx" onChange={(e) => { const file = e.target.files?.[0]; if (file) execute('模板上传', () => { const form = new FormData(); form.append('file', file); return api('/api/template/upload', role, { method: 'POST', body: form }); }); }} /></label>
        <button disabled={busy} onClick={() => execute('AI 变量分析', () => api('/api/templates/' + state.template.id + '/analyze-variables', role, { method: 'POST' }))}>运行 Codex 变量识别</button>
        {state.template.suggestions?.length > 0 && <><ul>{state.template.suggestions.map((item: any) => <li key={item.sourceText}>{item.sourceText} → {item.suggestedVariable}（{Math.round(item.confidence * 100)}%）</li>)}</ul><button disabled={busy} onClick={() => execute('变量确认', () => api('/api/template/confirm-suggestions', role, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ variables: state.template.suggestions.map((item: any) => item.suggestedVariable) }) }))}>确认变量建议</button></>}
      </section>
      <section className="card"><h2>2. Excel 导入与预检</h2><label className="upload">选择 Excel<input type="file" accept=".xlsx,.xls" onChange={(e) => { const file = e.target.files?.[0]; if (file) execute('导入预览', async () => { const form = new FormData(); form.append('file', file); const result = await api('/api/imports/preview', role, { method: 'POST', body: form }); setPendingRows(result.rows); if (!result.validation.valid) throw new Error('发现 ' + result.validation.errors.length + ' 个校验问题，请修正后确认。'); }); }} /></label>
        <button disabled={busy || pendingRows.length === 0} onClick={() => execute('确认导入', () => api('/api/imports/confirm', role, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ rows: pendingRows }) }))}>确认写入 {pendingRows.length} 行</button>
        <p>{state.rows.length ? '已导入 ' + state.rows.length + ' 条参与方数据' : '尚未导入数据'}</p>
        {state.rows.map((row: any, index: number) => <div className="row" key={index}><b>{row.participantName || '未命名参与方'}</b><span>{row.participantType}</span><button onClick={() => { const companyName = prompt('公司名称', row.companyName || ''); if (companyName !== null) execute('数据修正', () => api('/api/rows/' + index, role, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ companyName }) })); }}>修正</button></div>)}
      </section>
      <section className="card"><h2>3. 批量生成与异常</h2><button disabled={busy} onClick={() => execute('批量生成', () => api('/api/generation-tasks', role, { method: 'POST' }))}>发起 DOCX 批量生成</button>
        {currentTask && <><p>任务状态：<b>{currentTask.status}</b></p>{currentTask.results.map((result: any) => <div className="row" key={result.id}><b>{result.participantName}</b><span className={result.status}>{result.status === 'success' ? '生成成功' : '失败：' + result.error}</span>{result.status === 'failed' && <button onClick={() => execute('失败项重试', () => api('/api/results/' + result.id + '/retry', role, { method: 'POST' }))}>仅重试此项</button>}</div>)}</>}
      </section>
      <section className="card"><h2>4. 审核与交付</h2>{currentTask ? <><button disabled={busy} onClick={() => execute('提交审核', () => api('/api/reviews', role, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ taskId: currentTask.id }) }))}>提交审核</button><button disabled={busy} onClick={() => execute('审核通过', () => api('/api/reviews/' + currentTask.id + '/decision', role, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ decision: 'approved' }) }))}>审核通过</button><button disabled={busy} onClick={() => execute('审核驳回', () => api('/api/reviews/' + currentTask.id + '/decision', role, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ decision: 'rejected', comment: '请核验关键变量' }) }))}>审核驳回</button><button disabled={currentTask.reviewStatus !== 'approved'} onClick={download}>下载审核通过 ZIP</button><p>审核状态：{currentTask.reviewStatus || '未提交'}</p></> : <p>请先生成任务。</p>}</section>
    </div>
    <section className="card audit"><h2>审计记录</h2>{state.audit.slice(-8).reverse().map((item: any) => <p key={item.at}>{new Date(item.at).toLocaleString()} · <b>{roleLabels[item.role as Role]}</b> · {item.action} · {item.detail}</p>)}</section>
  </main>;
}
createRoot(document.getElementById('root')!).render(<App />);
