import { escapeHtml, formatTime, notice, renderLogs, request } from './ui-shared.js';

let templates = [];
let prompts = [];
let selectedTemplateId = '';

const templateRows = document.querySelector('#templateRows');
const templateCount = document.querySelector('#templateCount');
const form = document.querySelector('#templateForm');
const toast = document.querySelector('#toast');
const detailTitle = document.querySelector('#templateDetailTitle');
const deleteButton = document.querySelector('#deleteTemplate');
const preview = document.querySelector('#templatePreview');
const extractedVariables = document.querySelector('#templateVariables');
const templateLogs = document.querySelector('#templateLogs');
const aiPrompt = document.querySelector('#aiPrompt');
const aiTools = document.querySelector('#aiTools');
const scanButton = document.querySelector('#scanAiTools');
const extractButton = document.querySelector('#extractVariables');
const aiStatus = document.querySelector('#aiStatus');
const documentStatus = document.querySelector('#templateDocumentStatus');
const variableStatus = document.querySelector('#templateVariableStatus');

document.querySelector('#newTemplate').addEventListener('click', () => selectTemplate(null));
document.querySelector('#templateKeyword').addEventListener('input', loadTemplates);
scanButton.addEventListener('click', () => scanAiTools(true));
document.querySelector('#templateFile').addEventListener('change', importTemplateFile);
document.querySelector('#savePreview').addEventListener('click', savePreview);
deleteButton.addEventListener('click', removeSelectedTemplate);
form.addEventListener('submit', saveTemplate);
document.querySelector('#savePrompt').addEventListener('click', savePrompt);
extractButton.addEventListener('click', extractTemplateVariables);
document.querySelector('#restoreVariables').addEventListener('click', restoreTemplateVariables);
document.querySelectorAll('[data-tab]').forEach((tab) => tab.addEventListener('click', () => activateTab(tab.dataset.tab)));

await Promise.all([loadTemplates(), loadPrompts(), scanAiTools()]);
selectTemplate(templates[0] || null);

async function loadTemplates() {
  const keyword = document.querySelector('#templateKeyword').value;
  templates = await request(`/api/templates?keyword=${encodeURIComponent(keyword)}`);
  renderTemplates();
}

async function loadPrompts() {
  prompts = await request('/api/template-prompts');
  aiPrompt.value = prompts[0]?.content || '';
}

function renderTemplates() {
  templateCount.textContent = `${templates.length} 个模板`;
  templateRows.innerHTML = templates.map((item) => `
    <tr class="${String(item.id) === String(selectedTemplateId) ? 'selected' : ''}" data-id="${item.id}">
      <td><strong>${escapeHtml(item.name)}</strong><small>${escapeHtml(item.detail || '无详情')}</small></td>
      <td><code>${item.id}</code></td>
      <td>${item.document ? escapeHtml(item.document.fileName) : '未导入'}</td>
      <td>${formatTime(item.updatedAt)}</td>
    </tr>
  `).join('');
  templateRows.querySelectorAll('tr').forEach((row) => {
    row.addEventListener('click', () => selectTemplate(templates.find((item) => String(item.id) === row.dataset.id)));
  });
}

function selectTemplate(template) {
  selectedTemplateId = template?.id || '';
  detailTitle.textContent = template ? '模板详情' : '新建模板';
  deleteButton.disabled = !template;
  form.name.value = template?.name || '';
  form.id.value = template?.id || '保存后按时间戳生成';
  form.detail.value = template?.detail || '';
  form.status.value = template?.status || 'active';
  preview.innerHTML = template?.previewHtml || escapeHtml(template?.previewText || '').replace(/\n/g, '<br>');
  documentStatus.textContent = template?.document ? `已导入：${template.document.fileName}` : '未导入模板';
  variableStatus.textContent = `${template?.extractedVariables?.length || 0} 个变量`;
  extractedVariables.innerHTML = template?.extractedVariables?.length
    ? template.extractedVariables.map((item) => `
      <span class="${item.matchStatus === 'new' ? 'new-token' : ''}">
        ${escapeHtml(item.name)} <code>${escapeHtml(item.value)}</code>
        ${item.matchStatus === 'existing' ? '已对齐已有变量' : '需创建变量'}
      </span>
    `).join('')
    : '<p class="empty">暂无提取变量</p>';
  templateLogs.innerHTML = renderLogs(template?.changeLogs);
  renderTemplates();
}

function activateTab(name) {
  document.querySelectorAll('[data-tab]').forEach((tab) => tab.classList.toggle('active', tab.dataset.tab === name));
  document.querySelectorAll('[data-panel]').forEach((panel) => panel.classList.toggle('active', panel.dataset.panel === name));
}

async function saveTemplate(event) {
  event.preventDefault();
  try {
    const payload = {
      name: form.name.value,
      detail: form.detail.value,
      status: form.status.value,
      previewText: preview.textContent,
    };
    const saved = selectedTemplateId
      ? await request(`/api/templates/${selectedTemplateId}`, { method: 'PUT', body: JSON.stringify(payload) })
      : await request('/api/templates', { method: 'POST', body: JSON.stringify(payload) });
    notice(toast, '模板已保存');
    await loadTemplates();
    selectTemplate(saved);
  } catch (error) {
    notice(toast, error.message, true);
  }
}

async function removeSelectedTemplate() {
  if (!selectedTemplateId || !confirm('确认删除该模板？')) return;
  try {
    await request(`/api/templates/${selectedTemplateId}`, { method: 'DELETE' });
    notice(toast, '模板已删除');
    await loadTemplates();
    selectTemplate(templates[0] || null);
  } catch (error) {
    notice(toast, error.message, true);
  }
}

async function importTemplateFile(event) {
  const file = event.target.files?.[0];
  event.target.value = '';
  if (!file || !selectedTemplateId) return notice(toast, '请先选择或创建模板', true);
  try {
    const body = new FormData();
    body.append('file', file);
    const saved = await request(`/api/templates/${selectedTemplateId}/import`, { method: 'POST', body, headers: {} });
    notice(toast, '模板已导入');
    await loadTemplates();
    selectTemplate(saved);
  } catch (error) {
    notice(toast, error.message, true);
  }
}

async function savePreview() {
  if (!selectedTemplateId) return notice(toast, '请先选择模板', true);
  try {
    const saved = await request(`/api/templates/${selectedTemplateId}`, {
      method: 'PUT',
      body: JSON.stringify({ previewText: preview.textContent, previewHtml: preview.innerHTML }),
    });
    notice(toast, '预览编辑已保存');
    await loadTemplates();
    selectTemplate(saved);
  } catch (error) {
    notice(toast, error.message, true);
  }
}

async function scanAiTools(showFeedback = false) {
  setButtonLoading(scanButton, true, '检测中...');
  if (showFeedback) setAiStatus('正在检测云端 AI 配置...');
  try {
    const config = await request('/api/ai-tools');
    aiTools.innerHTML = `<p><b>${escapeHtml(config.provider)}</b><span>${escapeHtml(config.baseUrl)} · ${escapeHtml(config.model)} · ${config.configured ? '已配置' : '未配置'}</span></p>`;
    const message = `云端 AI 检测完成：${config.provider} / ${config.model} / ${config.configured ? '已配置' : '未配置'}`;
    setAiStatus(message, !config.configured);
    if (showFeedback) notice(toast, message, !config.configured);
  } catch (error) {
    setAiStatus(`检测失败：${error.message}`, true);
    notice(toast, error.message, true);
  } finally {
    setButtonLoading(scanButton, false);
  }
}

async function savePrompt() {
  if (!prompts[0]) return;
  try {
    await request(`/api/template-prompts/${prompts[0].id}`, { method: 'PUT', body: JSON.stringify({ content: aiPrompt.value }) });
    notice(toast, '提示词已保存');
    await loadPrompts();
  } catch (error) {
    notice(toast, error.message, true);
  }
}

async function extractTemplateVariables() {
  if (!selectedTemplateId) return notice(toast, '请先选择模板', true);
  setButtonLoading(extractButton, true, '提取中...');
  setAiStatus('正在使用云端 AI 提取变量...');
  try {
    const saved = await request(`/api/templates/${selectedTemplateId}/extract-variables`, {
      method: 'POST',
      body: JSON.stringify({ prompt: aiPrompt.value, textOverride: preview.textContent }),
    });
    const count = saved.extractedVariables?.length || 0;
    const newCount = saved.extractedVariables?.filter((item) => item.matchStatus === 'new').length || 0;
    const message = `变量提取完成：共 ${count} 个，${newCount} 个需创建`;
    setAiStatus(message);
    notice(toast, message);
    await loadTemplates();
    selectTemplate(saved);
    activateTab('preview');
  } catch (error) {
    setAiStatus(error.message, true);
    notice(toast, error.message, true);
  } finally {
    setButtonLoading(extractButton, false);
  }
}

async function restoreTemplateVariables() {
  if (!selectedTemplateId) return notice(toast, '请先选择模板', true);
  try {
    const saved = await request(`/api/templates/${selectedTemplateId}/restore-variables`, { method: 'POST' });
    notice(toast, '已还原上次提取');
    await loadTemplates();
    selectTemplate(saved);
    activateTab('preview');
  } catch (error) {
    notice(toast, error.message, true);
  }
}

function setButtonLoading(button, loading, text) {
  if (!button.dataset.label) button.dataset.label = button.textContent;
  button.disabled = loading;
  button.textContent = loading ? text : button.dataset.label;
}

function setAiStatus(message, error = false) {
  aiStatus.textContent = message;
  aiStatus.className = error ? 'status-line error' : 'status-line';
}
