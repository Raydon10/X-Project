import { request, notice, renderLogs, formatTime, escapeHtml } from '/ui-shared.js';

const state = {
  projects: [],
  templates: [],
  currentProject: null,
  groups: [],
  values: [],
  progress: null,
  selectedTemplateId: null,
  selectedScope: '',
  previewIndex: 0,
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
  openLinkPicker: $('openLinkPicker'),
  linkedSummary: $('linkedSummary'),
  templateLinkList: $('templateLinkList'),
  linkPicker: $('linkPicker'),
  linkPickerMask: $('linkPickerMask'),
  linkPickerClose: $('linkPickerClose'),
  linkPickerDone: $('linkPickerDone'),
  ungroupedList: $('ungroupedList'),
  groupList: $('groupList'),
  valueScopeLabel: $('valueScopeLabel'),
  valueForm: $('valueForm'),
  saveValues: $('saveValues'),
  renderPreview: $('renderPreview'),
  previewToolbar: $('previewToolbar'),
  previewPrev: $('previewPrev'),
  previewNext: $('previewNext'),
  previewLabel: $('previewLabel'),
  previewDropdown: $('previewDropdown'),
  valueFilter: $('valueFilter'),
  batchExport: $('batchExport'),
  logs: $('projectLogs'),
  toast: $('toast'),
  deleteBtn: $('deleteProject'),
  drawer: $('projectDrawer'),
  drawerMask: $('drawerMask'),
  drawerClose: $('projectDrawerClose'),
};

function openDrawer(after) {
  if (typeof after === 'function') after();
  elements.drawer.classList.add('show');
  elements.drawerMask.classList.add('show');
  document.body.style.overflow = 'hidden';
}

function closeDrawer() {
  elements.drawer.classList.remove('show');
  elements.drawerMask.classList.remove('show');
  document.body.style.overflow = '';
  state.currentProject = null;
  renderProjectList();
}

elements.drawerClose.onclick = closeDrawer;
elements.drawerMask.onclick = closeDrawer;
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeDrawer(); });

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
        return `<tr data-id="${p.id}">
          <td>${escapeHtml(p.name)}<small>${escapeHtml(p.detail || '—')}</small></td>
          <td>${p.id}</td>
          <td>${tplCount} 个模板</td>
          <td>—</td>
          <td>${formatTime(p.updatedAt)}</td>
          <td class="row-actions"><button type="button" class="open-detail" data-id="${p.id}">详情</button></td>
        </tr>`;
      }).join('')
    : '<tr><td colspan="6" class="empty">暂无项目</td></tr>';
  bindRowClicks();
}

function bindRowClicks() {
  for (const btn of elements.rows.querySelectorAll('.open-detail')) {
    btn.onclick = () => openDrawer(() => selectProject(Number(btn.dataset.id)));
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
  renderLinkedSummary();
  renderUngroupedList();
  renderGroupList();
  // 选中作用域失效时清空
  if (state.selectedScope && !scopeExists(state.selectedScope)) { state.selectedScope = ''; state.previewIndex = 0; }
  renderValueScope();
  renderValueForm();
  renderBatchExport();
  elements.logs.innerHTML = renderLogs(p.changeLogs || []);
}

/* ---------------------------- 关联模板（弹窗多选） ---------------------------- */
function openLinkPicker() {
  renderTemplateLinkList();
  elements.linkPicker.classList.add('show');
  elements.linkPickerMask.classList.add('show');
}

function closeLinkPicker() {
  elements.linkPicker.classList.remove('show');
  elements.linkPickerMask.classList.remove('show');
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
          notice(elements.toast, `已关联模板 ${tid}`);
        } else {
          await request(`/api/projects/${state.currentProject.id}/templates/${tid}`, { method: 'DELETE' });
          notice(elements.toast, `已取消关联 ${tid}`);
        }
        await selectProject(state.currentProject.id);
        renderTemplateLinkList();
      } catch (error) {
        notice(elements.toast, error.message, true);
        cb.checked = !cb.checked;
      }
    };
  }
}

function renderLinkedSummary() {
  const linked = state.currentProject?.templateIds || [];
  if (!linked.length) {
    elements.linkedSummary.innerHTML = '<p class="empty">尚未关联任何模板</p>';
    return;
  }
  elements.linkedSummary.innerHTML = linked.map((tid) => {
    const t = state.templates.find((x) => x.id === tid);
    const varCount = t?.extractedVariables?.length || 0;
    return `<div class="linked-summary-item">
      <strong>${escapeHtml(t?.name || String(tid))}</strong>
      <small>id: ${tid} · ${varCount} 个变量</small>
    </div>`;
  }).join('');
}

elements.openLinkPicker.onclick = openLinkPicker;
elements.linkPickerClose.onclick = closeLinkPicker;
elements.linkPickerMask.onclick = closeLinkPicker;
elements.linkPickerDone.onclick = closeLinkPicker;

/* ---------------------------- 编组与录入 ---------------------------- */
// 固定 10 个预定义编组位，名称形如「编组1」..「编组10」
const PREDEFINED_GROUPS = Array.from({ length: 10 }, (_, i) => ({ index: i + 1, name: `编组${i + 1}` }));

function renderUngroupedList() {
  const linked = state.currentProject?.templateIds || [];
  const grouped = new Set();
  for (const g of state.groups) for (const t of (g.templateIds || [])) grouped.add(t);
  const ungrouped = linked.filter((tid) => !grouped.has(tid));
  if (!ungrouped.length) {
    elements.ungroupedList.innerHTML = '<p class="empty">无未编组模板</p>';
    return;
  }
  elements.ungroupedList.innerHTML = ungrouped.map((tid) => {
    const t = state.templates.find((x) => x.id === tid);
    const varCount = t?.extractedVariables?.length || 0;
    const scope = `template:${tid}`;
    const selected = state.selectedScope === scope ? 'selected' : '';
    // 进度
    const tp = state.progress?.templates?.find((x) => x.templateId === tid);
    const filled = tp?.filled || 0;
    const total = tp?.total || varCount;
    const pct = total ? Math.round((filled / total) * 100) : 0;
    const complete = filled === total && total > 0;
    // 下拉框列出所有 1-10 编组位；选已存在的编组号则把模板加入该编组（互斥自动从其他组移除）
    const groupMap = new Map(state.groups.map((g) => [g.groupIndex || 0, g]));
    const groupOptions = PREDEFINED_GROUPS.map((p) => {
      const existing = groupMap.get(p.index);
      const label = existing ? `${p.name}（${existing.templateIds.length} 个）` : p.name;
      return `<option value="${p.index}">归入：${label}</option>`;
    }).join('');
    return `<div class="ungrouped-item ${selected}" data-tid="${tid}" data-scope="${scope}">
      <div class="ungrouped-item-main">
        <div class="card-head-row">
          <strong>${escapeHtml(t?.name || String(tid))}</strong>
          <span class="progress-bar"><span style="width:${pct}%"></span></span>
        </div>
        <small>${tid} · ${varCount} 个变量 · ${filled}/${total} 已填</small>
      </div>
      <div class="ungrouped-item-actions">
        <button type="button" class="export-single-btn" data-tid="${tid}" ${complete ? '' : 'disabled'} title="${complete ? '导出此模板' : '未填完无法导出'}">导出</button>
        <select class="ungrouped-to-group">
          <option value="">归入编组...</option>
          ${groupOptions}
        </select>
      </div>
    </div>`;
  }).join('');
  // 点击卡片主体选中作为录入作用域
  for (const card of elements.ungroupedList.querySelectorAll('.ungrouped-item')) {
    card.querySelector('.ungrouped-item-main').onclick = () => {
      state.selectedScope = card.dataset.scope;
      state.previewIndex = 0;
      renderUngroupedList();
      renderValueScope();
      renderValueForm();
    };
    // 单个导出
    const exportBtn = card.querySelector('.export-single-btn');
    if (exportBtn) exportBtn.onclick = (e) => { e.stopPropagation(); exportSingleTemplate(Number(exportBtn.dataset.tid)); };
    const sel = card.querySelector('.ungrouped-to-group');
    sel.onchange = async () => {
      const tid = Number(card.dataset.tid);
      const groupIndex = Number(sel.value);
      if (!groupIndex) return;
      try {
        // 若该编组号已存在，直接把模板加入；否则创建后再加入
        const existing = state.groups.find((g) => (g.groupIndex || 0) === groupIndex);
        let groupId;
        if (existing) {
          groupId = existing.id;
        } else {
          const newGroup = await request(`/api/projects/${state.currentProject.id}/groups`, {
            method: 'POST',
            body: JSON.stringify({ name: `编组${groupIndex}`, groupIndex }),
          });
          groupId = newGroup.id;
        }
        await request(`/api/groups/${groupId}/templates`, {
          method: 'POST',
          body: JSON.stringify({ templateIds: [tid] }),
        });
        notice(elements.toast, `已归入编组${groupIndex}`);
        await selectProject(state.currentProject.id);
      } catch (error) {
        notice(elements.toast, error.message, true);
        sel.value = '';
      }
    };
  }
}

function renderGroupList() {
  // 把已存在的编组按 groupIndex 排序展示
  const sorted = [...state.groups].sort((a, b) => (a.groupIndex || 0) - (b.groupIndex || 0));
  if (!sorted.length) {
    elements.groupList.innerHTML = '<p class="empty">暂无编组（未编组模板可通过下拉框归入 编组1-10）</p>';
    return;
  }
  elements.groupList.innerHTML = sorted.map((g) => {
    // 组内每张模板卡片同样显示进度
    const members = (g.templateIds || []).map((tid) => {
      const t = state.templates.find((x) => x.id === tid);
      const varCount = t?.extractedVariables?.length || 0;
      const tp = state.progress?.templates?.find((x) => x.templateId === tid);
      const filled = tp?.filled || 0;
      const total = tp?.total || varCount;
      const pct = total ? Math.round((filled / total) * 100) : 0;
      return `<div class="ungrouped-item grouped-item" data-gid="${g.id}" data-tid="${tid}">
        <div class="ungrouped-item-main">
          <div class="card-head-row">
            <strong>${escapeHtml(t?.name || String(tid))}</strong>
            <span class="progress-bar"><span style="width:${pct}%"></span></span>
          </div>
          <small>${tid} · ${varCount} 个变量 · ${filled}/${total} 已填</small>
        </div>
        <button type="button" class="group-member-remove danger" data-gid="${g.id}" data-tid="${tid}">移出</button>
      </div>`;
    }).join('') || '<span class="empty">无</span>';
    // 整组进度（组内模板进度均值）
    const groupProgress = state.progress?.groups?.find((x) => x.groupId === g.id);
    const gFilled = groupProgress?.filled || 0;
    const gTotal = groupProgress?.total || 0;
    const gPct = gTotal ? Math.round((gFilled / gTotal) * 100) : 0;
    const gComplete = gFilled === gTotal && gTotal > 0;
    const scope = `group:${g.id}`;
    const selected = state.selectedScope === scope ? 'selected' : '';
    return `<div class="group-card ${selected}" data-gid="${g.id}" data-scope="${scope}">
      <div class="group-card-head">
        <div class="card-head-row">
          <strong>${escapeHtml(g.name)}</strong>
          <span class="progress-bar"><span style="width:${gPct}%"></span></span>
        </div>
        <div class="group-card-actions">
          <button type="button" class="export-group-btn" data-gid="${g.id}" ${gComplete ? '' : 'disabled'} title="${gComplete ? '导出整组' : '未填完无法导出'}">导出整组</button>
          <button type="button" class="group-member-remove-all danger" data-gid="${g.id}">解散组</button>
        </div>
      </div>
      <small style="display:block;margin-bottom:8px;color:#64748b;">共 ${(g.templateIds || []).length} 个模板 · ${gFilled}/${gTotal} 已填</small>
      <div class="group-members-list">${members}</div>
    </div>`;
  }).join('');
  // 点击编组卡片整体选中作为录入作用域（点按钮不触发）
  for (const card of elements.groupList.querySelectorAll('.group-card')) {
    card.onclick = (e) => {
      if (e.target.closest('button')) return;
      state.selectedScope = card.dataset.scope;
      state.previewIndex = 0;
      renderGroupList();
      renderValueScope();
      renderValueForm();
    };
  }
  // 整组导出
  for (const btn of elements.groupList.querySelectorAll('.export-group-btn')) {
    btn.onclick = (e) => { e.stopPropagation(); exportGroup(Number(btn.dataset.gid)); };
  }
  // 解散组（删除编组，组内模板回到未编组）
  for (const btn of elements.groupList.querySelectorAll('.group-member-remove-all')) {
    btn.onclick = async (e) => {
      e.stopPropagation();
      if (!confirm('确认解散该编组？组内模板将变为未编组。')) return;
      try {
        await request(`/api/groups/${btn.dataset.gid}`, { method: 'DELETE' });
        notice(elements.toast, '已解散编组');
        await selectProject(state.currentProject.id);
      } catch (error) { notice(elements.toast, error.message, true); }
    };
  }
  // 从组移除单个模板（仅此操作可单独进行）
  for (const btn of elements.groupList.querySelectorAll('.group-member-remove')) {
    btn.onclick = async (e) => {
      e.stopPropagation();
      try {
        await request(`/api/groups/${btn.dataset.gid}/templates/${btn.dataset.tid}`, { method: 'DELETE' });
        notice(elements.toast, '已从组移除');
        await selectProject(state.currentProject.id);
      } catch (error) { notice(elements.toast, error.message, true); }
    };
  }
}

/* ---------------------------- 真实值录入 ---------------------------- */
async function loadProjectValues() {
  if (!state.currentProject) return;
  try {
    state.values = await request(`/api/projects/${state.currentProject.id}/values`);
  } catch {
    state.values = [];
  }
}

// 检查选中作用域是否还存在（编组可能被解散、模板可能被取消关联）
function scopeExists(scope) {
  if (!scope) return false;
  const [type, idStr] = scope.split(':');
  const id = Number(idStr);
  if (type === 'group') return state.groups.some((g) => g.id === id);
  if (type === 'template') return (state.currentProject?.templateIds || []).includes(id);
  return false;
}

function renderValueScope() {
  if (!state.selectedScope) {
    elements.valueScopeLabel.textContent = '当前未选中作用域';
    elements.saveValues.disabled = true;
    return;
  }
  const [type, idStr] = state.selectedScope.split(':');
  const id = Number(idStr);
  if (type === 'group') {
    const g = state.groups.find((x) => x.id === id);
    elements.valueScopeLabel.textContent = `当前作用域：编组「${g?.name || id}」（含 ${(g?.templateIds || []).length} 个模板）`;
    // 编组作用域：显示模板筛选下拉框
    const tids = g?.templateIds || [];
    elements.valueFilter.innerHTML = '<option value="">全部模板变量</option>' + tids.map((tid) => {
      const t = state.templates.find((x) => x.id === tid);
      return `<option value="${tid}">${escapeHtml(t?.name || String(tid))}</option>`;
    }).join('');
    elements.valueFilter.style.display = tids.length > 1 ? 'block' : 'none';
    if (elements.valueFilter.value && !tids.includes(Number(elements.valueFilter.value))) elements.valueFilter.value = '';
  } else if (type === 'template') {
    const t = state.templates.find((x) => x.id === id);
    elements.valueScopeLabel.textContent = `当前作用域：未编组模板「${t?.name || id}」`;
    elements.valueFilter.style.display = 'none';
    elements.valueFilter.value = '';
  }
  elements.saveValues.disabled = false;
}

function renderBatchExport() {
  const total = state.currentProject?.templateIds?.length || 0;
  elements.batchExport.disabled = !total;
}

function getCurrentScopeVariables() {
  const scope = state.selectedScope;
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
  // 模板筛选：若选了某模板，只取该模板的变量
  const filterTid = elements.valueFilter ? Number(elements.valueFilter.value) : 0;
  if (filterTid) templateIds = templateIds.filter((tid) => tid === filterTid);
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
  const scope = state.selectedScope;
  if (!scope) {
    elements.valueForm.innerHTML = '<p class="empty">请在左侧选择模板或编组</p>';
    return;
  }
  const vars = getCurrentScopeVariables();
  if (!vars.length) {
    elements.valueForm.innerHTML = '<p class="empty">所选作用域无变量</p>';
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
  // 自动渲染预览
  renderPreviewForScope();
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

elements.saveValues.onclick = async () => {
  const scope = state.selectedScope;
  if (!scope) return notice(elements.toast, '请在左侧选择作用域', true);
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

// 根据当前选中作用域自动渲染预览
async function renderPreviewForScope() {
  const scope = state.selectedScope;
  if (!scope) {
    elements.renderPreview.innerHTML = '';
    elements.previewToolbar.style.display = 'none';
    return;
  }
  const [type, idStr] = scope.split(':');
  if (type === 'group') {
    const id = Number(idStr);
    const g = state.groups.find((x) => x.id === id);
    const tids = g?.templateIds || [];
    if (!tids.length) {
      elements.renderPreview.innerHTML = '<p class="empty">编组内无模板</p>';
      elements.previewToolbar.style.display = 'none';
      return;
    }
    // 切换作用域时重置到组内第一个模板
    if (state.previewIndex >= tids.length) state.previewIndex = 0;
    renderPreviewToolbar(tids);
    await renderTemplatePreview(tids[state.previewIndex]);
    return;
  }
  // 模板作用域：单个模板
  elements.previewToolbar.style.display = 'none';
  await renderTemplatePreview(Number(idStr));
}

function renderPreviewToolbar(tids) {
  elements.previewToolbar.style.display = tids.length > 1 ? 'flex' : 'none';
  const idx = state.previewIndex + 1;
  elements.previewLabel.textContent = `${idx} / ${tids.length}`;
  elements.previewPrev.disabled = state.previewIndex === 0;
  elements.previewNext.disabled = state.previewIndex >= tids.length - 1;
  elements.previewDropdown.innerHTML = tids.map((tid, i) => {
    const t = state.templates.find((x) => x.id === tid);
    const sel = i === state.previewIndex ? 'selected' : '';
    return `<option value="${i}" ${sel}>${escapeHtml(t?.name || String(tid))}</option>`;
  }).join('');
}

async function renderTemplatePreview(tid) {
  try {
    const result = await request(`/api/projects/${state.currentProject.id}/templates/${tid}/render`);
    elements.renderPreview.innerHTML = result.html || '<p class="empty">无渲染内容</p>';
  } catch (error) {
    elements.renderPreview.innerHTML = `<p class="empty">${escapeHtml(error.message)}</p>`;
  }
}

// 预览工具栏：左右切换 + 模板下拉
elements.previewPrev.onclick = async () => {
  const tids = getScopeTemplateIds();
  if (!tids || !state.previewIndex) return;
  state.previewIndex -= 1;
  renderPreviewToolbar(tids);
  await renderTemplatePreview(tids[state.previewIndex]);
};

elements.previewNext.onclick = async () => {
  const tids = getScopeTemplateIds();
  if (!tids) return;
  if (state.previewIndex >= tids.length - 1) return;
  state.previewIndex += 1;
  renderPreviewToolbar(tids);
  await renderTemplatePreview(tids[state.previewIndex]);
};

elements.previewDropdown.onchange = async () => {
  const tids = getScopeTemplateIds();
  if (!tids) return;
  state.previewIndex = Number(elements.previewDropdown.value);
  renderPreviewToolbar(tids);
  await renderTemplatePreview(tids[state.previewIndex]);
};

function getScopeTemplateIds() {
  if (!state.selectedScope) return null;
  const [type, idStr] = state.selectedScope.split(':');
  if (type === 'group') {
    const g = state.groups.find((x) => x.id === Number(idStr));
    return g?.templateIds || [];
  }
  return [Number(idStr)];
}

// 录入区：按模板筛选变量
elements.valueFilter.onchange = renderValueForm;

/* ---------------------------- 导出（批量 + 单个） ---------------------------- */
elements.batchExport.onclick = async () => {
  const ids = (state.currentProject?.templateIds || []);
  if (!ids.length) return notice(elements.toast, '本项目无关联模板', true);
  try {
    await downloadFile(`/api/projects/${state.currentProject.id}/export-batch`, 'POST', { templateIds: ids, format: 'docx' });
    notice(elements.toast, '已开始批量导出');
  } catch (error) {
    notice(elements.toast, error.message, true);
  }
};

// 单个模板导出（在卡片上调用）
async function exportSingleTemplate(tid) {
  try {
    await downloadFile(`/api/projects/${state.currentProject.id}/templates/${tid}/export`, 'POST', { format: 'docx' });
    notice(elements.toast, '已导出 DOCX');
  } catch (error) {
    notice(elements.toast, error.message, true);
  }
}

// 批量导出整组（在编组卡片上调用）
async function exportGroup(groupId) {
  const g = state.groups.find((x) => x.id === groupId);
  const ids = g?.templateIds || [];
  if (!ids.length) return notice(elements.toast, '该编组无模板', true);
  try {
    await downloadFile(`/api/projects/${state.currentProject.id}/export-batch`, 'POST', { templateIds: ids, format: 'docx' });
    notice(elements.toast, `已导出编组「${g.name}」`);
  } catch (error) {
    notice(elements.toast, error.message, true);
  }
}

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
$('newProject').onclick = () => openDrawer(() => {
  state.currentProject = null;
  elements.form.reset();
  elements.form.id.value = '';
  elements.detailTitle.textContent = '新建项目';
});

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
      await loadProjects();
      await selectProject(state.currentProject.id);
    } else {
      const created = await request('/api/projects', { method: 'POST', body: JSON.stringify(data) });
      notice(elements.toast, '已创建');
      await loadProjects();
      await selectProject(created.id);
    }
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
    closeDrawer();
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
  try {
    // 并行加载所有依赖数据
    const [templates, projects, sysVariables] = await Promise.all([
      request('/api/templates').catch(() => []),
      request('/api/projects').catch(() => []),
      request('/api/variables').catch(() => []),
    ]);
    state.templates = templates;
    state.projects = projects;
    window.__sysVariables = sysVariables;
    renderProjectList();
  } catch (error) {
    notice(elements.toast, `初始化失败：${error.message}`, true);
  }
}
init();
