let variables = [];
let selectedValue = '';

const rows = document.querySelector('#variableRows');
const count = document.querySelector('#count');
const form = document.querySelector('#variableForm');
const toast = document.querySelector('#toast');
const detailTitle = document.querySelector('#detailTitle');
const changeLogs = document.querySelector('#changeLogs');
const deleteButton = document.querySelector('#deleteVariable');

document.querySelector('#newVariable').addEventListener('click', () => selectVariable(null));
document.querySelector('#keyword').addEventListener('input', loadVariables);
document.querySelector('#typeFilter').addEventListener('change', loadVariables);
deleteButton.addEventListener('click', removeSelected);
form.addEventListener('submit', saveVariable);

await loadVariables();
selectVariable(variables[0] || null);

async function loadVariables() {
  const keyword = document.querySelector('#keyword').value;
  const type = document.querySelector('#typeFilter').value;
  variables = await request(`/api/variables?keyword=${encodeURIComponent(keyword)}&type=${encodeURIComponent(type)}`);
  renderRows();
}

function renderRows() {
  count.textContent = `${variables.length} 个变量`;
  rows.innerHTML = variables.map((item) => `
    <tr class="${item.value === selectedValue ? 'selected' : ''}" data-value="${item.value}">
      <td><strong>${escapeHtml(item.name)}</strong><small>${escapeHtml(item.description || '无描述')}</small></td>
      <td><code>${escapeHtml(item.value)}</code></td>
      <td><span class="tag">${item.type === 'enum' ? '枚举' : '单一'}</span></td>
      <td>${new Date(item.updatedAt).toLocaleString()}</td>
    </tr>
  `).join('');
  rows.querySelectorAll('tr').forEach((row) => {
    row.addEventListener('click', () => selectVariable(variables.find((item) => item.value === row.dataset.value)));
  });
}

function selectVariable(variable) {
  selectedValue = variable?.value || '';
  detailTitle.textContent = variable ? '变量详情' : '新建变量';
  deleteButton.disabled = !variable;
  form.name.value = variable?.name || '';
  form.value.value = variable?.value || '';
  form.value.disabled = Boolean(variable);
  form.type.value = variable?.type || 'single';
  form.description.value = variable?.description || '';
  form.status.value = variable?.status || 'active';
  changeLogs.innerHTML = variable?.changeLogs?.length
    ? variable.changeLogs.slice().reverse().map((log) => `<p><b>${escapeHtml(log.summary)}</b><span>${new Date(log.createdAt).toLocaleString()} · ${escapeHtml(log.operator)}</span></p>`).join('')
    : '<p class="empty">暂无变更日志</p>';
  renderRows();
}

async function saveVariable(event) {
  event.preventDefault();
  const payload = {
    name: form.name.value,
    value: form.value.value,
    type: form.type.value,
    description: form.description.value,
    status: form.status.value,
  };
  const saved = selectedValue
    ? await request(`/api/variables/${encodeURIComponent(selectedValue)}`, { method: 'PUT', body: JSON.stringify(payload) })
    : await request('/api/variables', { method: 'POST', body: JSON.stringify(payload) });
  notice('变量已保存');
  await loadVariables();
  selectVariable(saved);
}

async function removeSelected() {
  if (!selectedValue || !confirm('确认删除该变量？')) return;
  await request(`/api/variables/${encodeURIComponent(selectedValue)}`, { method: 'DELETE' });
  notice('变量已删除');
  await loadVariables();
  selectVariable(variables[0] || null);
}

async function request(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: { 'content-type': 'application/json', ...(options.headers || {}) },
  });
  if (response.status === 204) return null;
  const body = await response.json();
  if (!response.ok) {
    notice(body.message || '请求失败', true);
    throw new Error(body.message || '请求失败');
  }
  return body;
}

function notice(message, error = false) {
  toast.textContent = message;
  toast.className = error ? 'error show' : 'show';
  setTimeout(() => toast.className = '', 1800);
}

function escapeHtml(text) {
  return String(text).replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' })[char]);
}
