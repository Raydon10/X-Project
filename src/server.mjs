import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createVariable,
  deleteVariable,
  getVariable,
  listVariables,
  updateVariable,
  VariableStore,
} from './variables.mjs';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const publicDir = path.join(root, 'public');
const store = new VariableStore(path.join(root, 'workspace'));
await store.initialize();

const server = http.createServer(async (request, response) => {
  try {
    const url = new URL(request.url || '/', 'http://localhost:5173');
    if (url.pathname.startsWith('/api/variables')) {
      await handleVariables(request, response, url);
      return;
    }
    await serveStatic(response, url.pathname);
  } catch (error) {
    sendJson(response, 500, { message: error instanceof Error ? error.message : '服务异常' });
  }
});

server.listen(5173, () => {
  console.log('Variable management module running on http://localhost:5173');
});

async function handleVariables(request, response, url) {
  const parts = url.pathname.split('/').filter(Boolean);
  const value = decodeURIComponent(parts[2] || '');
  if (request.method === 'GET' && !value) {
    sendJson(response, 200, await listVariables(store, {
      keyword: url.searchParams.get('keyword') || '',
      type: url.searchParams.get('type') || '',
    }));
    return;
  }
  if (request.method === 'POST' && !value) {
    sendJson(response, 201, await createVariable(store, await readBody(request)));
    return;
  }
  if (request.method === 'GET' && value) {
    const variable = await getVariable(store, value);
    if (!variable) return sendJson(response, 404, { message: '变量不存在' });
    sendJson(response, 200, variable);
    return;
  }
  if (request.method === 'PUT' && value) {
    sendJson(response, 200, await updateVariable(store, value, await readBody(request)));
    return;
  }
  if (request.method === 'DELETE' && value) {
    await deleteVariable(store, value);
    sendJson(response, 204, null);
    return;
  }
  sendJson(response, 405, { message: '不支持的请求方法' });
}

async function readBody(request) {
  let text = '';
  for await (const chunk of request) text += chunk;
  return text ? JSON.parse(text) : {};
}

function sendJson(response, statusCode, body) {
  response.writeHead(statusCode, { 'content-type': 'application/json; charset=utf-8' });
  if (statusCode !== 204) response.end(JSON.stringify(body));
  else response.end();
}

async function serveStatic(response, pathname) {
  const requested = pathname === '/' ? '/index.html' : pathname;
  const filePath = path.join(publicDir, requested);
  if (!filePath.startsWith(publicDir)) return sendJson(response, 403, { message: 'Forbidden' });
  try {
    const content = await fs.readFile(filePath);
    response.writeHead(200, { 'content-type': contentType(filePath) });
    response.end(content);
  } catch {
    response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    response.end('Not found');
  }
}

function contentType(filePath) {
  if (filePath.endsWith('.html')) return 'text/html; charset=utf-8';
  if (filePath.endsWith('.css')) return 'text/css; charset=utf-8';
  if (filePath.endsWith('.js')) return 'application/javascript; charset=utf-8';
  return 'application/octet-stream';
}
