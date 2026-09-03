export async function request(url, options = {}) {
  const headers = options.body instanceof FormData ? options.headers || {} : { 'content-type': 'application/json', ...(options.headers || {}) };
  const response = await fetch(url, { ...options, headers });
  if (response.status === 204) return null;
  const body = await response.json();
  if (!response.ok) throw new Error(body.message || '请求失败');
  return body;
}

export function notice(toast, message, error = false) {
  toast.textContent = message;
  toast.className = error ? 'error show' : 'show';
  setTimeout(() => toast.className = '', 3000);
}

export function renderLogs(logs = []) {
  return logs.length
    ? logs.slice().reverse().map((log) => `<p><b>${escapeHtml(log.summary)}</b><span>${formatTime(log.createdAt)} · ${escapeHtml(log.operator)}</span></p>`).join('')
    : '<p class="empty">暂无变更日志</p>';
}

export function formatTime(value) {
  return value ? new Date(value).toLocaleString() : '-';
}

export function escapeHtml(text) {
  return String(text).replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' })[char]);
}
