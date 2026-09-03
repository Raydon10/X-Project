import { request, notice, renderLogs, formatTime, escapeHtml } from '/ui-shared.js';

const state = {
  projects: [],
  templates: [],
  currentProject: null,
  groups: [],
  values: [],
  progress: null,
  selectedTemplateId: null,
};

const $ = (id) => document.getElementById(id);

const elements = {
  rows: $('projectRows'),
  count: $('projectCount'),
  detailTitle: $('projectDetailTitle'),
  templateStatus: $('projectTemplateStatus'),
  groupStatus: $('projectGroupStatus'),
  progressStatus: $('projectProgressStatus'),
  form: $('projectForm'),
  templateLinkList: $('templateLinkList'),
  groupList: $('groupList'),
  newGroupName: $('newGroupName'),
  createGroupBtn: $('createGroup'),
  valueScope: $('valueScope'),
  valueForm: $('valueForm'),
  saveValues: $('saveValues'),
  previewTemplate: $('previewTemplate'),
  renderPreview: $('renderPreview'),
  exportList: $('exportList'),
  batchExport: $('batchExport'),
  selectExportAll: $('selectExportAll'),
  selectExportNone: $('selectExportNone'),
  logs: $('projectLogs'),
  toast: $('toast'),
  deleteBtn: $('deleteProject'),
};

/* ---------------------------- 项目列表 ---------------------------- */
async function loadProjects() {
  state.projects = await request('/api/projects');
  renderProjectList();
}

function renderProjectList() {
  elements.count.textContent = `${state.projects.length} 个项目`;
  elements.rows.innerHTML = state.projects.length
    ? state.projects.map((p) => {
        const tplCount = (p.templateIds || []).length;
        const progress = (state.progress && state.progress.projectId === p.id) ? Math.round(state.progress.ratio * 100) : null;
        return `<tr data-id="${p.id}" class="${state.currentProject?.id === p.id ? 'selected' : ''}">
          <td>${escapeHtml(p.name)}<small>${escapeHtml(p.detail || '—')}</small></td>
          <td>${p.id}</td>
          <td>${tplCount} 个模板</td>
          <td>${progress !== null ? progress + '%' : '—'}</td>
          <td>${formatTime(p.updatedAt)}</td>
        </tr>`;
      }).join('')
    : '<tr><td colspan="5" class="empty">暂无项目</td></tr>';
  bindRowClicks();
}

function bindRowClicks() {
  for (const row of elements.rows.querySelectorAll('tr[data-id]')) {
    row.onclick = () => selectProject(Number(row.dataset.id));
  }
}

async function selectProject(id) {
  const project = state.projects.find((p) => p.id === id);
  if (!project) return;
  state.currentProject = project;
  // 加载详情
  state.currentProject = await request(`/api/projects/${id}`);
  state.groups = await request(`/api/projects/${id}/groups`);
  try {
    state.progress = await request(`/api/projects/${id}/progress`);
  } catch (error) {
    state.progress = null;
  }
  await loadProjectValues();
  renderProjectDetail();
  renderProjectList();
}

/* ---------------------------- 项目详情 ---------------------------- */
function renderProjectDetail() {
  const p = state.currentProject;
  if (!p) return;
  elements.detailTitle.textContent = p.name;
  elements.templateStatus.textContent = `${(p.templateIds || []).length} 个模板`;
  elements.groupStatus.textContent = `${state.groups.length} 个编组`;
  if (state.progress) {
    const pct = Math.round(state.progress.ratio * 100);
    elements.progressStatus.textContent = `进度 ${pct}%（${state.progress.filled}/${state.progress.total}）`;
  } else {
    elements.progressStatus.textContent = '进度 0%';
  }
  // 基础表单
  elements.form.name.value = p.name;
  elements.form.id.value = p.id;
  elements.form.detail.value = p.detail || '';
  elements.form.status.value = p.status || 'active';
  // 各 tab
  renderTemplateLinkList();
  renderGroupList();
  renderValueScope();
  renderExportList();
  elements.logs.innerHTML = renderLogs(p.changeLogs || []);
}

/* ---------------------------- 模板挂接 ---------------------------- */
async function loadAllTemplates() {
  state.templates = await request('/api/templates');
}

function renderTemplateLinkList() {
  const linked = new Set((state.currentProject?.templateIds || []));
  elements.templateLinkList.innerHTML = state.templates.length
    ? state.templates.map((t) => {
        const checked = linked.has(t.id) ? 'checked' : '';
        const varCount = (t.extractedVariables || []).length;
        return `<label class="link-item">
          <input type="checkbox" data-id="${t.id}" ${checked}>
          <span>${escapeHtml(t.name)}<small>${t.id} · ${varCount} 个变量</small></span>
        </label>`;
      }).join('')
    : '<p class="empty">暂无模板，请先在模板管理中创建</p>';
  for (const cb of elements.templateLinkList.querySelectorAll('input[type=checkbox]')) {
    cb.onchange = async () => {
      const tid = Number(cb.dataset.id);
      try {
        if (cb.checked) {
          await request(`/api/projects/${state.currentProject.id}/templates`, {
            method: 'POST',
            body: JSON.stringify({ templateIds: [tid] }),
          });
          notice(elements.toast, `已挂接模板 ${tid}`);
        } else {
          await request(`/api/projects/${state.currentProject.id}/templates/${tid}`, { method: 'DELETE' });
          notice(elements.toast, `已取消挂接 ${tid}`);
        }
        await selectProject(state.currentProject.id);
      } catch (error) {
        notice(elements.toast, error.message, true);
        cb.checked = !cb.checked;
      }
    };
  }
}

/* ---------------------------- 编组管理 ---------------------------- */
function renderGroupList() {
  if (!state.groups.length) {
    elements.groupList.innerHTML = '<p class="empty">暂无编组，未编组模板需独立录入真实值</p>';
    return;
  }
  elements.groupList.innerHTML = state.groups.map((g) => {
    const members = (g.templateIds || []).map((tid) => {
      const t = state.templates.find((x) => x.id === tid);
      return `<span class="tag">${escapeHtml(t?.name || String(tid))}<button type="button" class="tag-remove" data-gid="${g.id}" data-tid="${tid}">×</button></span>`;
    }).join('') || '<span class="empty">无</span>';
    const available = (state.currentProject?.templateIds || [])
      .filter((tid) => !(g.templateIds || []).includes(tid))
      .map((tid) => {
        const t = state.templates.find((x) => x.id === tid);
        return `<option value="${tid}">${escapeHtml(t?.name || String(tid))}</option>`;
      }).join('');
    return `<div class="group-card" data-gid="${g.id}">
      <div class="group-card-head">
        <strong>${escapeHtml(g.name)}</strong>
        <button type="button" class="danger group-delete" data-gid="${g.id}">删除组</button>
      </div>
      <div class="group-members">${members}</div>
      <div class="button-row">
        <select class="add-to-group-select">${available || '<option value="">无可挂接模板</option>'}</select>
        <button type="button" class="add-to-group-btn" data-gid="${g.id}">加入组</button>
      </div>
    </div>`;
  }).join('');
  for (const btn of elements.groupList.querySelectorAll('.group-delete')) {
    btn.onclick = async () => {
      if (!confirm('确认删除该编组？组内模板将变为未编组。')) return;
      try {
        await request(`/api/groups/${btn.dataset.gid}`, { method: 'DELETE' });
        notice(elements.toast, '已删除编组');
        await selectProject(state.currentProject.id);
      } catch (error) { notice(elements.toast, error.message, true); }
    };
  }
  for (const btn of elements.groupList.querySelectorAll('.tag-remove')) {
    btn.onclick = async () => {
      try {
        await request(`/api/groups/${btn.dataset.gid}/templates/${btn.dataset.tid}`, { method: 'DELETE' });
        notice(elements.toast, '已从组移除');
        await selectProject(state.currentProject.id);
      } catch (error) { notice(elements.toast, error.message, true); }
    };
  }
  for (const btn of elements.groupList.querySelectorAll('.add-to-group-btn')) {
    btn.onclick = async () => {
      const sel = btn.parentElement.querySelector('.add-to-group-select');
      const tid = Number(sel.value);
      if (!tid) return;
      try {
        await request(`/api/groups/${btn.dataset.gid}/templates`, {
          method: 'POST',
          body: JSON.stringify({ templateIds: [tid] }),
        });
        notice(elements.toast, '已加入组');
        await selectProject(state.currentProject.id);
      } catch (error) { notice(elements.toast, error.message, true); }
    };
  }
}

elements.createGroupBtn.onclick = async () => {
  const name = elements.newGroupName.value.trim();
  if (!name) return notice(elements.toast, '请输入编组名称', true);
  try {
    await request(`/api/projects/${state.currentProject.id}/groups`, {
      method: 'POST',
      body: JSON.stringify({ name }),
    });
    elements.newGroupName.value = '';
    notice(elements.toast, '已创建编组');
    await selectProject(state.currentProject.id);
  } catch (error) { notice(elements.toast, error.message, true); }
};

/* ---------------------------- 真实值录入 ---------------------------- */
async function loadProjectValues() {
  if (!state.currentProject) return;
  try {
    state.values = await request(`/api/projects/${state.currentProject.id}/values`);
  } catch {
    state.values = [];
  }
}

function renderValueScope() {
  const opts = ['<option value="">请选择编组或未编组模板</option>'];
  for (const g of state.groups) {
    opts.push(`<option value="group:${g.id}">编组：${escapeHtml(g.name)}</option>`);
  }
  // 未编组模板
  const grouped = new Set();
  for (const g of state.groups) for (const t of (g.templateIds || [])) grouped.add(t);
  for (const tid of (state.currentProject?.templateIds || [])) {
    if (grouped.has(tid)) continue;
    const t = state.templates.find((x) => x.id === tid);
    opts.push(`<option value="template:${tid}">未编组：${escapeHtml(t?.name || String(tid))}</option>`);
  }
  elements.valueScope.innerHTML = opts.join('');
  // 预览模板下拉
  const previewOpts = ['<option value="">请选择模板预览</option>'];
  for (const tid of (state.currentProject?.templateIds || [])) {
    const t = state.templates.find((x) => x.id === tid);
    previewOpts.push(`<option value="${tid}">${escapeHtml(t?.name || String(tid))}</option>`);
  }
  elements.previewTemplate.innerHTML = previewOpts.join('');
  elements.previewTemplate.disabled = !state.currentProject?.templateIds?.length;
  renderValueForm();
}

function getCurrentScopeVariables() {
  const scope = elements.valueScope.value;
  if (!scope) return [];
  const [type, idStr] = scope.split(':');
  const id = Number(idStr);
  let templateIds = [];
  if (type === 'group') {
    const g = state.groups.find((x) => x.id === id);
    templateIds = g ? g.templateIds : [];
  } else {
    templateIds = [id];
  }
  // 合并去重所有模板的变量（按 value）
  const byVal = new Map();
  for (const tid of templateIds) {
    const t = state.templates.find((x) => x.id === tid);
    if (!t) continue;
    for (const v of (t.extractedVariables || [])) {
      if (!byVal.has(v.value)) byVal.set(v.value, { ...v, slotIndex: 0 });
    }
  }
  return [...byVal.values()];
}

function renderValueForm() {
  const scope = elements.valueScope.value;
  if (!scope) {
    elements.valueForm.innerHTML = '<p class="empty">请先选择作用域</p>';
    return;
  }
  const vars = getCurrentScopeVariables();
  if (!vars.length) {
    elements.valueForm.innerHTML = '<p class="empty">所选模板无变量</p>';
    return;
  }
  // 查找变量类型（从 templates 的 extractedVariables / variables 系统）
  const sysVars = window.__sysVariables || [];
  elements.valueForm.innerHTML = vars.map((v) => {
    const sysVar = sysVars.find((s) => s.value === v.value);
    const type = sysVar?.type || 'single';
    const isEnum = type === 'enum';
    const existing = state.values.filter((x) => x.scope === scope && x.variableValue === v.value);
    const slot0Value = existing.find((x) => x.slotIndex === 0)?.realValue || '';
    return `<div class="value-row" data-var="${escapeHtml(v.value)}" data-type="${type}">
      <label>${escapeHtml(v.name)}（${escapeHtml(v.value)}${isEnum ? ' / 枚举' : ''}）
        ${isEnum
          ? renderEnumSlots(existing)
          : `<input type="text" class="value-input" data-slot="0" value="${escapeHtml(slot0Value)}" placeholder="输入真实值">`}
      </label>
    </div>`;
  }).join('');
  // enum 类的「+ 添加一项」
  for (const row of elements.valueForm.querySelectorAll('.value-row')) {
    const addBtn = row.querySelector('.enum-add-slot');
    if (addBtn) addBtn.onclick = () => addEnumSlot(row);
  }
}

function renderEnumSlots(existing) {
  const slots = [...existing, { slotIndex: existing.length, realValue: '' }];
  return `<div class="enum-slots">${slots.map((s) => renderEnumSlot(s.slotIndex, s.realValue)).join('')}</div>
    <button type="button" class="enum-add-slot">+ 添加一项</button>`;
}

function renderEnumSlot(slotIndex, value) {
  return `<div class="enum-slot">
    <input type="text" class="value-input" data-slot="${slotIndex}" value="${escapeHtml(value || '')}" placeholder="第 ${slotIndex + 1} 项">
    <button type="button" class="enum-remove-slot" data-slot="${slotIndex}">×</button>
  </div>`;
}

function addEnumSlot(row) {
  const slotsDiv = row.querySelector('.enum-slots');
  const nextIndex = slotsDiv.querySelectorAll('.enum-slot').length;
  const div = document.createElement('div');
  div.className = 'enum-slot';
  div.innerHTML = renderEnumSlot(nextIndex, '');
  slotsDiv.appendChild(div);
  div.querySelector('.enum-remove-slot').onclick = () => {
    const slots = slotsDiv.querySelectorAll('.enum-slot');
    if (slots.length <= 1) return;
    div.remove();
    reindexEnumSlots(slotsDiv);
  };
}

function reindexEnumSlots(slotsDiv) {
  slotsDiv.querySelectorAll('.enum-slot').forEach((div, i) => {
    div.querySelector('input').dataset.slot = i;
    div.querySelector('.enum-remove-slot').dataset.slot = i;
  });
}

elements.valueScope.onchange = renderValueForm;

elements.saveValues.onclick = async () => {
  const scope = elements.valueScope.value;
  if (!scope) return notice(elements.toast, '请先选择作用域', true);
  try {
    // 收集所有 input
    for (const row of elements.valueForm.querySelectorAll('.value-row')) {
      const variableValue = row.dataset.var;
      const inputs = row.querySelectorAll('.value-input');
      for (const input of inputs) {
        const slotIndex = Number(input.dataset.slot);
        const realValue = input.value.trim();
        // 找现有值判断是新增/更新/删除
        const existing = state.values.find((x) => x.scope === scope && x.variableValue === variableValue && x.slotIndex === slotIndex);
        if (!realValue && existing) {
          await request(`/api/projects/${state.currentProject.id}/values`, {
            method: 'DELETE',
            body: JSON.stringify({ scope, variableValue, slotIndex }),
          });
        } else if (realValue) {
          await request(`/api/projects/${state.currentProject.id}/values`, {
            method: 'POST',
            body: JSON.stringify({ scope, variableValue, slotIndex, realValue }),
          });
        }
      }
    }
    notice(elements.toast, '已保存真实值');
    await selectProject(state.currentProject.id);
    renderValueForm();
  } catch (error) {
    notice(elements.toast, error.message, true);
  }
};

elements.previewTemplate.onchange = async () => {
  const tid = Number(elements.previewTemplate.value);
  if (!tid) return;
  try {
    const result = await request(`/api/projects/${state.currentProject.id}/templates/${tid}/render`);
    elements.renderPreview.innerHTML = result.html || '<p class="empty">无渲染内容</p>';
  } catch (error) {
    notice(elements.toast, error.message, true);
    elements.renderPreview.innerHTML = '';
  }
};

/* ---------------------------- 导出中心 ---------------------------- */
function renderExportList() {
  const tplProgress = state.progress?.templates || [];
  if (!tplProgress.length) {
    elements.exportList.innerHTML = '<p class="empty">暂无可导出模板，请先挂接</p>';
    return;
  }
  elements.exportList.innerHTML = tplProgress.map((tp) => {
    const pct = Math.round(tp.ratio * 100);
    const complete = tp.missing.length === 0;
    return `<label class="export-item ${complete ? 'complete' : 'incomplete'}">
      <input type="checkbox" data-id="${tp.templateId}" ${complete ? 'checked' : ''}>
      <span class="export-info">
        <strong>${escapeHtml(tp.name)}</strong>
        <small>${tp.filled}/${tp.total} 已填${complete ? ' · 可导出' : ` · 缺 ${tp.missing.length} 项`}</small>
        <span class="progress-bar"><span style="width:${pct}%"></span></span>
      </span>
      <button type="button" class="export-single" data-id="${tp.templateId}" ${complete ? '' : 'disabled'}>导出</button>
    </label>`;
  }).join('');
  for (const btn of elements.exportList.querySelectorAll('.export-single')) {
    btn.onclick = async (e) => {
      e.preventDefault();
      const tid = btn.dataset.id;
      await downloadFile(`/api/projects/${state.currentProject.id}/templates/${tid}/export`, 'POST', { format: 'docx' });
    };
  }
}

elements.selectExportAll.onclick = () => {
  for (const cb of elements.exportList.querySelectorAll('input[type=checkbox]')) cb.checked = true;
};
elements.selectExportNone.onclick = () => {
  for (const cb of elements.exportList.querySelectorAll('input[type=checkbox]')) cb.checked = false;
};

elements.batchExport.onclick = async () => {
  const ids = [...elements.exportList.querySelectorAll('input[type=checkbox]:checked')].map((cb) => Number(cb.dataset.id));
  if (!ids.length) return notice(elements.toast, '请勾选要导出的模板', true);
  try {
    await downloadFile(`/api/projects/${state.currentProject.id}/export-batch`, 'POST', { templateIds: ids, format: 'docx' });
    notice(elements.toast, '已开始批量导出');
  } catch (error) {
    notice(elements.toast, error.message, true);
  }
};

async function downloadFile(url, method, body) {
  const response = await fetch(url, {
    method,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    const err = await response.json().catch(() => ({}));
    notice(elements.toast, err.message || `导出失败：${response.status}`, true);
    return;
  }
  const blob = await response.blob();
  const fileName = decodeURIComponent(response.headers.get('content-disposition')?.match(/filename\*=UTF-8''([^;]+)/)?.[1] || 'export');
  const link = document.createElement('a');
  link.href = URL.createObjectURL(blob);
  link.download = fileName;
  link.click();
  URL.revokeObjectURL(link.href);
}

/* ---------------------------- 项目 CRUD ---------------------------- */
$('newProject').onclick = () => {
  state.currentProject = null;
  elements.form.reset();
  elements.form.id.value = '';
  elements.detailTitle.textContent = '新建项目';
  renderProjectList();
};

elements.form.onsubmit = async (e) => {
  e.preventDefault();
  const data = Object.fromEntries(new FormData(elements.form));
  try {
    if (state.currentProject) {
      await request(`/api/projects/${state.currentProject.id}`, {
        method: 'PUT',
        body: JSON.stringify(data),
      });
      notice(elements.toast, '已保存');
    } else {
      await request('/api/projects', { method: 'POST', body: JSON.stringify(data) });
      notice(elements.toast, '已创建');
    }
    await loadProjects();
    if (state.currentProject) await selectProject(state.currentProject.id);
  } catch (error) {
    notice(elements.toast, error.message, true);
  }
};

elements.deleteBtn.onclick = async () => {
  if (!state.currentProject) return;
  if (!confirm(`确认删除项目「${state.currentProject.name}」？关联的编组和真实值也会一并删除。`)) return;
  try {
    await request(`/api/projects/${state.currentProject.id}`, { method: 'DELETE' });
    notice(elements.toast, '已删除');
    state.currentProject = null;
    elements.form.reset();
    elements.detailTitle.textContent = '项目详情';
    await loadProjects();
  } catch (error) {
    notice(elements.toast, error.message, true);
  }
};

/* ---------------------------- Tab 切换 ---------------------------- */
for (const btn of document.querySelectorAll('.template-tabs button')) {
  btn.onclick = () => {
    document.querySelectorAll('.template-tabs button').forEach((b) => b.classList.remove('active'));
    document.querySelectorAll('.tab-panel').forEach((p) => p.classList.remove('active'));
    btn.classList.add('active');
    document.querySelector(`.tab-panel[data-panel="${btn.dataset.tab}"]`).classList.add('active');
  };
}

$('projectKeyword').oninput = async (e) => {
  const keyword = e.target.value.trim();
  state.projects = await request(`/api/projects?keyword=${encodeURIComponent(keyword)}`);
  renderProjectList();
};

/* ---------------------------- 初始化 ---------------------------- */
async function init() {
  await loadAllTemplates();
  await loadProjects();
  // 加载系统变量用于显示类型
  try {
    window.__sysVariables = await request('/api/variables');
  } catch {
    window.__sysVariables = [];
  }
}
init();
