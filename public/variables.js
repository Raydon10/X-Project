import { escapeHtml, formatTime, notice, renderLogs, request } from './ui-shared.js';

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
deleteButton.addEventListener('click', removeSelectedVariable);
form.addEventListener('submit', saveVariable);

await loadVariables();
selectVariable(variables[0] || null);

async function loadVariables() {
  const keyword = document.querySelector('#keyword').value;
  const type = document.querySelector('#typeFilter').value;
  variables = await request(`/api/variables?keyword=${encodeURIComponent(keyword)}&type=${encodeURIComponent(type)}`);
  renderVariables();
}

function renderVariables() {
  count.textContent = `${variables.length} 个变量`;
  rows.innerHTML = variables.map((item) => `
    <tr class="${item.value === selectedValue ? 'selected' : ''}" data-value="${item.value}">
      <td><strong>${escapeHtml(item.name)}</strong><small>${escapeHtml(item.description || '无描述')}</small></td>
      <td><code>${escapeHtml(item.value)}</code></td>
      <td><span class="tag">${item.type === 'enum' ? '枚举' : '单一'}</span></td>
      <td>${formatTime(item.updatedAt)}</td>
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
  changeLogs.innerHTML = renderLogs(variable?.changeLogs);
  renderVariables();
}

async function saveVariable(event) {
  event.preventDefault();
  try {
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
    notice(toast, '变量已保存');
    await loadVariables();
    selectVariable(saved);
  } catch (error) {
    notice(toast, error.message, true);
  }
}

async function removeSelectedVariable() {
  if (!selectedValue || !confirm('确认删除该变量？')) return;
  try {
    await request(`/api/variables/${encodeURIComponent(selectedValue)}`, { method: 'DELETE' });
    notice(toast, '变量已删除');
    await loadVariables();
    selectVariable(variables[0] || null);
  } catch (error) {
    notice(toast, error.message, true);
  }
}
