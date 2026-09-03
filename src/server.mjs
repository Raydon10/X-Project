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
import {
  analyzeTemplateVariables,
  createTemplate,
  deleteTemplate,
  getTemplate,
  importTemplateDocument,
  getAiConfig,
  listTemplatePrompts,
  listTemplates,
  restoreTemplateVariables,
  saveTemplatePrompt,
  TemplateStore,
  updateTemplate,
} from './templates.mjs';
import {
  ProjectStore,
  listProjects, getProject, createProject, updateProject, deleteProject,
  linkTemplates, unlinkTemplate,
  listGroups, getGroup, createGroup, updateGroup, deleteGroup,
  addTemplatesToGroup, removeTemplatesFromGroup,
  listValues, setValue, deleteValue,
  getProgress, getProgressByTemplate,
  renderSignaturePage, exportSingle, exportBatch,
} from './projects.mjs';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const publicDir = path.join(root, 'public');
const workspaceRoot = path.join(root, 'workspace');
const variableStore = new VariableStore(workspaceRoot);
const templateStore = new TemplateStore(workspaceRoot);
const projectStore = new ProjectStore(workspaceRoot);
await variableStore.initialize();
await templateStore.initialize();
await projectStore.initialize();

const server = http.createServer(async (request, response) => {
  try {
    const url = new URL(request.url || '/', 'http://localhost:5173');
    if (url.pathname.startsWith('/api/variables')) {
      await handleVariables(request, response, url);
      return;
    }
    if (url.pathname.startsWith('/api/templates')) {
      await handleTemplates(request, response, url);
      return;
    }
    if (url.pathname.startsWith('/api/ai-tools')) {
      sendJson(response, 200, getAiConfig());
      return;
    }
    if (url.pathname.startsWith('/api/template-prompts')) {
      await handlePrompts(request, response, url);
      return;
    }
    if (url.pathname.startsWith('/api/projects')) {
      await handleProjects(request, response, url);
      return;
    }
    if (url.pathname.startsWith('/api/groups')) {
      await handleGroups(request, response, url);
      return;
    }
    await serveStatic(response, url.pathname);
  } catch (error) {
    sendJson(response, 500, { message: error instanceof Error ? error.message : '服务异常' });
  }
});

server.listen(5173, () => {
  console.log('Signature config modules running on http://localhost:5173');
});

async function handleVariables(request, response, url) {
  const parts = url.pathname.split('/').filter(Boolean);
  const value = decodeURIComponent(parts[2] || '');
  if (request.method === 'GET' && !value) {
    sendJson(response, 200, await listVariables(variableStore, {
      keyword: url.searchParams.get('keyword') || '',
      type: url.searchParams.get('type') || '',
    }));
    return;
  }
  if (request.method === 'POST' && !value) {
    sendJson(response, 201, await createVariable(variableStore, await readBody(request)));
    return;
  }
  if (request.method === 'GET' && value) {
    const variable = await getVariable(variableStore, value);
    if (!variable) return sendJson(response, 404, { message: '变量不存在' });
    sendJson(response, 200, variable);
    return;
  }
  if (request.method === 'PUT' && value) {
    sendJson(response, 200, await updateVariable(variableStore, value, await readBody(request)));
    return;
  }
  if (request.method === 'DELETE' && value) {
    await deleteVariable(variableStore, value);
    sendJson(response, 204, null);
    return;
  }
  sendJson(response, 405, { message: '不支持的请求方法' });
}

async function handleTemplates(request, response, url) {
  const parts = url.pathname.split('/').filter(Boolean);
  const id = parts[2] || '';
  const action = parts[3] || '';
  if (request.method === 'GET' && !id) {
    sendJson(response, 200, await listTemplates(templateStore, { keyword: url.searchParams.get('keyword') || '' }));
    return;
  }
  if (request.method === 'POST' && !id) {
    sendJson(response, 201, await createTemplate(templateStore, await readBody(request)));
    return;
  }
  if (request.method === 'GET' && id && !action) {
    const template = await getTemplate(templateStore, id);
    if (!template) return sendJson(response, 404, { message: '模板不存在' });
    sendJson(response, 200, template);
    return;
  }
  if (request.method === 'PUT' && id && !action) {
    sendJson(response, 200, await updateTemplate(templateStore, id, await readBody(request)));
    return;
  }
  if (request.method === 'DELETE' && id && !action) {
    await deleteTemplate(templateStore, id);
    sendJson(response, 204, null);
    return;
  }
  if (request.method === 'POST' && id && action === 'import') {
    const file = await readMultipartFile(request);
    sendJson(response, 200, await importTemplateDocument(templateStore, id, file));
    return;
  }
  if (request.method === 'POST' && id && action === 'extract-variables') {
    sendJson(response, 200, await analyzeTemplateVariables(templateStore, id, await readBody(request), await listVariables(variableStore)));
    return;
  }
  if (request.method === 'POST' && id && action === 'restore-variables') {
    sendJson(response, 200, await restoreTemplateVariables(templateStore, id));
    return;
  }
  sendJson(response, 405, { message: '不支持的请求方法' });
}

async function handlePrompts(request, response, url) {
  const id = decodeURIComponent(url.pathname.split('/').filter(Boolean)[1] || '');
  if (request.method === 'GET') {
    sendJson(response, 200, await listTemplatePrompts(templateStore));
    return;
  }
  if (request.method === 'PUT' && id) {
    const body = await readBody(request);
    sendJson(response, 200, await saveTemplatePrompt(templateStore, id, body.content));
    return;
  }
  sendJson(response, 405, { message: '不支持的请求方法' });
}

async function readBody(request) {
  let text = '';
  for await (const chunk of request) text += chunk;
  return text ? JSON.parse(text) : {};
}

async function readMultipartFile(request) {
  const contentType = request.headers['content-type'] || '';
  const boundary = String(contentType).match(/boundary=(.+)$/)?.[1];
  if (!boundary) throw new Error('缺少上传边界');
  const chunks = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  const body = Buffer.concat(chunks);
  const boundaryBuffer = Buffer.from(`--${boundary}`);
  const start = body.indexOf(Buffer.from('\r\n\r\n'));
  if (start < 0) throw new Error('上传文件格式错误');
  const header = body.subarray(0, start).toString('utf8');
  const fileName = header.match(/filename="([^"]+)"/)?.[1];
  if (!fileName) throw new Error('请选择模板文件');
  const contentStart = start + 4;
  const nextBoundary = body.indexOf(boundaryBuffer, contentStart);
  const contentEnd = nextBoundary > contentStart ? nextBoundary - 2 : body.length;
  return {
    fileName,
    contentType: header.match(/Content-Type:\s*([^\r\n]+)/i)?.[1] || '',
    buffer: body.subarray(contentStart, contentEnd),
  };
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
  if (filePath.endsWith('.docx')) return 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
  if (filePath.endsWith('.zip')) return 'application/zip';
  return 'application/octet-stream';
}

/* =========================================================================
 * 项目 / 编组 / 真实值 / 渲染 / 导出 路由
 * 路径模式：
 *   GET/POST /api/projects
 *   GET/PUT/DELETE /api/projects/:id
 *   POST /api/projects/:id/templates { templateIds: [] }
 *   DELETE /api/projects/:id/templates/:tid
 *   GET/POST /api/projects/:id/groups
 *   GET/POST /api/projects/:id/values
 *   DELETE /api/projects/:id/values
 *   GET /api/projects/:id/progress
 *   GET /api/projects/:id/templates/:tid/render
 *   POST /api/projects/:id/templates/:tid/export
 *   POST /api/projects/:id/export-batch { templateIds: [], format }
 *
 *   PUT/DELETE /api/groups/:id
 *   POST /api/groups/:id/templates { templateIds: [] }
 *   DELETE /api/groups/:id/templates/:tid
 * ========================================================================= */
async function handleProjects(request, response, url) {
  const parts = url.pathname.split('/').filter(Boolean);
  // ['api','projects', :id?, action?, :tid? ]
  const id = parts[2] || '';
  const action = parts[3] || '';
  const tid = parts[4] || '';

  // 列表 / 创建
  if (!id) {
    if (request.method === 'GET') {
      sendJson(response, 200, await listProjects(projectStore, { keyword: url.searchParams.get('keyword') || '' }));
      return;
    }
    if (request.method === 'POST') {
      sendJson(response, 201, await createProject(projectStore, await readBody(request)));
      return;
    }
    sendJson(response, 405, { message: '不支持的请求方法' });
    return;
  }

  // 单项目 CRUD
  if (id && !action) {
    if (request.method === 'GET') {
      const project = await getProject(projectStore, id);
      if (!project) return sendJson(response, 404, { message: '项目不存在' });
      sendJson(response, 200, project);
      return;
    }
    if (request.method === 'PUT') {
      sendJson(response, 200, await updateProject(projectStore, id, await readBody(request)));
      return;
    }
    if (request.method === 'DELETE') {
      await deleteProject(projectStore, id);
      sendJson(response, 204, null);
      return;
    }
    sendJson(response, 405, { message: '不支持的请求方法' });
    return;
  }

  // 模板挂接
  if (action === 'templates' && request.method === 'POST') {
    const body = await readBody(request);
    sendJson(response, 200, await linkTemplates(projectStore, id, body.templateIds));
    return;
  }
  if (action === 'templates' && tid && request.method === 'DELETE') {
    sendJson(response, 200, await unlinkTemplate(projectStore, id, tid));
    return;
  }

  // 编组
  if (action === 'groups') {
    if (request.method === 'GET') {
      sendJson(response, 200, await listGroups(projectStore, id));
      return;
    }
    if (request.method === 'POST') {
      sendJson(response, 201, await createGroup(projectStore, id, await readBody(request)));
      return;
    }
    sendJson(response, 405, { message: '不支持的请求方法' });
    return;
  }

  // 真实值
  if (action === 'values') {
    if (request.method === 'GET') {
      sendJson(response, 200, await listValues(projectStore, id, {
        scope: url.searchParams.get('scope') || '',
        templateId: url.searchParams.get('templateId') || '',
        groupId: url.searchParams.get('groupId') || '',
      }));
      return;
    }
    if (request.method === 'POST') {
      sendJson(response, 201, await setValue(projectStore, id, await readBody(request)));
      return;
    }
    if (request.method === 'DELETE') {
      await deleteValue(projectStore, id, await readBody(request));
      sendJson(response, 204, null);
      return;
    }
    sendJson(response, 405, { message: '不支持的请求方法' });
    return;
  }

  // 进度
  if (action === 'progress' && request.method === 'GET') {
    sendJson(response, 200, await getProgress(projectStore, templateStore, id));
    return;
  }

  // 模板渲染/导出
  if (action === 'templates' && tid) {
    const sub = parts[5] || '';
    if (sub === 'render' && request.method === 'GET') {
      sendJson(response, 200, await renderSignaturePage(projectStore, templateStore, id, tid));
      return;
    }
    if (sub === 'export' && request.method === 'POST') {
      const body = await readBody(request);
      const result = await exportSingle(projectStore, templateStore, id, tid, body.format || 'docx');
      sendBinary(response, result);
      return;
    }
  }

  // 批量导出
  if (action === 'export-batch' && request.method === 'POST') {
    const body = await readBody(request);
    const result = await exportBatch(projectStore, templateStore, id, body.templateIds, body.format || 'docx');
    sendBinary(response, result);
    return;
  }

  sendJson(response, 405, { message: '不支持的请求方法' });
}

async function handleGroups(request, response, url) {
  const parts = url.pathname.split('/').filter(Boolean);
  // ['api','groups', :id?, action?, :tid? ]
  const id = parts[2] || '';
  const action = parts[3] || '';
  const tid = parts[4] || '';
  if (!id) {
    sendJson(response, 405, { message: '不支持的请求方法' });
    return;
  }
  if (!action) {
    if (request.method === 'GET') {
      const g = await getGroup(projectStore, id);
      if (!g) return sendJson(response, 404, { message: '编组不存在' });
      sendJson(response, 200, g);
      return;
    }
    if (request.method === 'PUT') {
      sendJson(response, 200, await updateGroup(projectStore, id, await readBody(request)));
      return;
    }
    if (request.method === 'DELETE') {
      await deleteGroup(projectStore, id);
      sendJson(response, 204, null);
      return;
    }
    sendJson(response, 405, { message: '不支持的请求方法' });
    return;
  }
  if (action === 'templates' && request.method === 'POST') {
    const body = await readBody(request);
    sendJson(response, 200, await addTemplatesToGroup(projectStore, id, body.templateIds));
    return;
  }
  if (action === 'templates' && tid && request.method === 'DELETE') {
    sendJson(response, 200, await removeTemplatesFromGroup(projectStore, id, [Number(tid)]));
    return;
  }
  sendJson(response, 405, { message: '不支持的请求方法' });
}

function sendBinary(response, { fileName, buffer, mime }) {
  const encoded = encodeURIComponent(fileName);
  response.writeHead(200, {
    'content-type': mime || 'application/octet-stream',
    'content-disposition': `attachment; filename*=UTF-8''${encoded}`,
    'content-length': buffer.length,
  });
  response.end(buffer);
}
