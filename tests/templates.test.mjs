import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  analyzeTemplateVariables,
  createTemplate,
  deleteTemplate,
  getAiConfig,
  getTemplate,
  importTemplateDocument,
  listTemplates,
  restoreTemplateVariables,
  TemplateStore,
  updateTemplate,
} from '../src/templates.mjs';

test('cloud AI config uses Agnes without exposing the API key', () => {
  const config = getAiConfig();
  assert.equal(config.provider, 'agnes');
  assert.equal(config.baseUrl, 'https://apihub.agnes-ai.com/v1');
  assert.equal(config.model, 'agnes-2.0-flash');
  assert.equal(config.configured, true);
  assert.equal(JSON.stringify(config).includes('sk-'), false);
});

async function withStore(run) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'template-module-'));
  try {
    const store = new TemplateStore(directory);
    await store.initialize();
    await run(store);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
}

test('creates updates lists and deletes a template with a numeric timestamp id', async () => {
  await withStore(async (store) => {
    const template = await createTemplate(store, {
      name: '自然人股东签字页模板',
      detail: '用于自然人股东逐份生成签字页',
    }, { timestamp: 20260903101010 });

    assert.equal(template.id, 20260903101010);
    assert.equal(template.name, '自然人股东签字页模板');
    assert.equal((await listTemplates(store)).length, 1);

    const updated = await updateTemplate(store, template.id, { detail: '更新后的模板详情' });
    assert.equal(updated.detail, '更新后的模板详情');
    assert.equal(updated.changeLogs.length, 2);

    await deleteTemplate(store, template.id);
    assert.equal(await getTemplate(store, template.id), null);
  });
});

test('imports a docx document as local original-format template data', async () => {
  await withStore(async (store) => {
    const template = await createTemplate(store, { name: '法律意见书签字页', detail: '' }, { timestamp: 20260903102020 });
    const imported = await importTemplateDocument(store, template.id, {
      fileName: '法律意见书签字页模板样例.docx',
      contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      buffer: Buffer.from('docx-original-bytes'),
      extractedText: '签字主体：【naturalPersonShareholder】',
    });

    assert.equal(imported.document.fileName, '法律意见书签字页模板样例.docx');
    assert.equal(imported.previewText, '签字主体：【naturalPersonShareholder】');
    assert.equal(imported.previewHtml, '签字主体：【naturalPersonShareholder】');
    assert.equal(await fs.readFile(imported.document.storagePath, 'utf8'), 'docx-original-bytes');
  });
});

test('builds a formatted docx html preview when importing docx bytes', async () => {
  await withStore(async (store) => {
    const template = await createTemplate(store, { name: '格式预览模板', detail: '' }, { timestamp: 20260903102525 });
    const documentXml = '<w:document><w:body><w:p><w:r><w:rPr><w:b/></w:rPr><w:t>加粗标题</w:t></w:r></w:p><w:p><w:r><w:t>签字人：</w:t></w:r><w:r><w:rPr><w:u w:val="single"/></w:rPr><w:t>【naturalPersonShareholder】</w:t></w:r></w:p></w:body></w:document>';
    const imported = await importTemplateDocument(store, template.id, {
      fileName: '格式预览模板.docx',
      contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      buffer: await buildDocxBuffer(documentXml),
    });

    assert.match(imported.previewHtml, /<strong>加粗标题<\/strong>/);
    assert.match(imported.previewHtml, /<u>【naturalPersonShareholder】<\/u>/);
  });
});

test('preserves docx paragraph alignment color font size and tables in html preview', async () => {
  await withStore(async (store) => {
    const template = await createTemplate(store, { name: '完整格式预览模板', detail: '' }, { timestamp: 20260903102626 });
    const documentXml = [
      '<w:document><w:body>',
      '<w:p><w:pPr><w:jc w:val="center"/></w:pPr><w:r><w:rPr><w:color w:val="FF0000"/><w:sz w:val="32"/></w:rPr><w:t>红色居中标题</w:t></w:r></w:p>',
      '<w:tbl><w:tr><w:tc><w:p><w:r><w:t>表格单元格</w:t></w:r></w:p></w:tc></w:tr></w:tbl>',
      '</w:body></w:document>',
    ].join('');
    const imported = await importTemplateDocument(store, template.id, {
      fileName: '完整格式预览模板.docx',
      contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      buffer: await buildDocxBuffer(documentXml),
    });

    assert.match(imported.previewHtml, /text-align:center/);
    assert.match(imported.previewHtml, /color:#FF0000/);
    assert.match(imported.previewHtml, /font-size:16pt/);
    assert.match(imported.previewHtml, /<table/);
    assert.match(imported.previewHtml, /<td>表格单元格<\/td>/);
  });
});

test('extracts variables with AI fallback and can restore the previous result', async () => {
  await withStore(async (store) => {
    const template = await createTemplate(store, { name: '签字页模板', detail: '' }, { timestamp: 20260903103030 });
    await importTemplateDocument(store, template.id, {
      fileName: '自然人股东签字页.docx',
      contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      buffer: Buffer.from('docx'),
      extractedText: '签字人：【naturalPersonShareholder】\n项目：{{projectName}}',
    });
    await analyzeTemplateVariables(store, template.id, { prompt: '只返回变量数组' }, [
      { name: '自然人股东', value: 'naturalPersonShareholder', type: 'enum' },
    ], async () => '{"templateText":"签字人：{{naturalPersonShareholder}}\\n项目：{{projectName}}","variables":[{"name":"自然人股东","value":"naturalPersonShareholder"},{"name":"projectName","value":"projectName"}]}');
    await analyzeTemplateVariables(store, template.id, { prompt: '第二次提取', textOverride: '公司：{{companyName}}' }, [
      { name: '公司名称', value: 'companyName', type: 'single' },
    ], async () => '```json\n{"templateText":"公司：{{companyName}}","variables":[{"name":"公司名称","value":"companyName"}]}\n```');

    let latest = await getTemplate(store, template.id);
    assert.deepEqual(latest.extractedVariables.map((item) => item.value), ['companyName']);
    assert.equal(latest.extractedVariables[0].matchStatus, 'existing');

    latest = await restoreTemplateVariables(store, template.id);
    assert.deepEqual(latest.extractedVariables.map((item) => item.value), ['naturalPersonShareholder', 'projectName']);
    assert.equal(latest.aiRuns.length, 2);
  });
});

test('uses full AI report template text to update highlighted preview and deduplicated variables', async () => {
  await withStore(async (store) => {
    const template = await createTemplate(store, { name: 'AI 报告模板', detail: '' }, { timestamp: 20260903103535 });
    await updateTemplate(store, template.id, {
      previewText: '原始签字人：【oldSigner】',
      previewHtml: '<p>原始签字人：【oldSigner】</p>',
      extractedVariables: [{ name: '旧签字人', value: 'oldSigner', matchStatus: 'new' }],
    });

    const updated = await analyzeTemplateVariables(store, template.id, { prompt: '输出完整报告模板' }, [
      { name: '公司名称', value: 'companyName', type: 'single' },
    ], async () => JSON.stringify({
      templateText: '公司：{{companyName}}\n签字人：{{signerName}}\n复核公司：{{companyName}}',
      variables: [
        { name: '公司名称', value: 'companyName' },
        { name: '签字人', value: 'signerName' },
      ],
    }));

    assert.equal(updated.previewText, '公司：{{companyName}}\n签字人：{{signerName}}\n复核公司：{{companyName}}');
    assert.deepEqual(updated.extractedVariables.map((item) => item.value), ['companyName', 'signerName']);
    assert.equal(updated.extractedVariables[0].matchStatus, 'existing');
    assert.equal(updated.extractedVariables[1].matchStatus, 'new');
    assert.match(updated.previewHtml, /class="variable-chip"/);
    assert.match(updated.previewHtml, /data-variable="companyName"/);

    const restored = await restoreTemplateVariables(store, template.id);
    assert.equal(restored.previewText, '原始签字人：【oldSigner】');
    assert.equal(restored.previewHtml, '<p>原始签字人：【oldSigner】</p>');
    assert.deepEqual(restored.extractedVariables.map((item) => item.value), ['oldSigner']);
  });
});

test('sends prompt existing variables and template content as connected AI input sections', async () => {
  await withStore(async (store) => {
    const template = await createTemplate(store, { name: '提示词入参模板', detail: '' }, { timestamp: 20260903103636 });
    await updateTemplate(store, template.id, { previewText: '公司名称：星河科技' });
    let aiInput = '';

    await analyzeTemplateVariables(store, template.id, { prompt: '识别公司名称变量' }, [
      { name: '公司名称', value: 'companyName', type: 'single', description: '发行人公司名称' },
    ], async (input) => {
      aiInput = input;
      return '{"templateText":"公司名称：{{companyName}}","variables":[{"name":"公司名称","value":"companyName"}]}';
    });

    assert.match(aiInput, /# 任务/);
    assert.match(aiInput, /# 输入一：用户提示词/);
    assert.match(aiInput, /识别公司名称变量/);
    assert.match(aiInput, /# 输入二：系统已有变量/);
    assert.match(aiInput, /"value": "companyName"/);
    assert.match(aiInput, /# 输入三：模板内容/);
    assert.match(aiInput, /公司名称：星河科技/);
    assert.match(aiInput, /参考已存在的变量/);
    assert.match(aiInput, /参考模板文案/);
    assert.match(aiInput, /输出替换变量后的全部模板文案/);
    assert.match(aiInput, /# 输出要求/);
    assert.match(aiInput, /templateText/);
    assert.match(aiInput, /variables/);
  });
});

test('accepts AI variables-only response as fallback without losing extracted variables', async () => {
  await withStore(async (store) => {
    const template = await createTemplate(store, { name: '兼容变量数组模板', detail: '' }, { timestamp: 20260903103737 });
    await updateTemplate(store, template.id, { previewText: '公司名称：星河科技' });

    const updated = await analyzeTemplateVariables(store, template.id, { prompt: '识别公司名称' }, [
      { name: '公司名称', value: 'companyName', type: 'single' },
    ], async () => '{"variables":[{"name":"公司名称","value":"companyName"}]}');

    assert.equal(updated.previewText, '公司名称：{{companyName}}');
    assert.deepEqual(updated.extractedVariables.map((item) => item.value), ['companyName']);
    assert.equal(updated.extractedVariables[0].matchStatus, 'existing');
  });
});

test('uses explicit prompt variable hints to complete template placeholders when AI returns original text', async () => {
  await withStore(async (store) => {
    const template = await createTemplate(store, { name: '提示词变量兜底模板', detail: '' }, { timestamp: 20260903103838 });
    await updateTemplate(store, template.id, { previewText: '签字人：张三' });

    const updated = await analyzeTemplateVariables(store, template.id, { prompt: '签字人可创建 signerName' }, [], async () => '{"templateText":"签字人：张三","variables":[]}');

    assert.equal(updated.previewText, '签字人：{{signerName}}');
    assert.deepEqual(updated.extractedVariables.map((item) => item.value), ['signerName']);
    assert.equal(updated.extractedVariables[0].matchStatus, 'new');
  });
});

test('does not overwrite extracted variables when cloud AI fails', async () => {
  await withStore(async (store) => {
    const template = await createTemplate(store, { name: 'AI 失败模板', detail: '' }, { timestamp: 20260903104040 });
    await updateTemplate(store, template.id, {
      previewText: '签字人：【naturalPersonShareholder】',
      extractedVariables: [{ name: '自然人股东', value: 'naturalPersonShareholder', matchStatus: 'existing' }],
    });

    await assert.rejects(
      analyzeTemplateVariables(store, template.id, { prompt: '提取变量' }, [], async () => ''),
      /AI 提取失败/
    );
    const latest = await getTemplate(store, template.id);
    assert.deepEqual(latest.extractedVariables.map((item) => item.value), ['naturalPersonShareholder']);
    assert.equal(latest.aiRuns.at(-1).status, 'failed');
  });
});

async function buildDocxBuffer(documentXml) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'docx-preview-'));
  try {
    await fs.mkdir(path.join(directory, 'word'), { recursive: true });
    await fs.writeFile(path.join(directory, 'word', 'document.xml'), documentXml, 'utf8');
    const archive = path.join(directory, 'template.docx');
    const { execFile } = await import('node:child_process');
    await new Promise((resolve, reject) => {
      execFile('zip', ['-qr', archive, 'word/document.xml'], { cwd: directory }, (error) => error ? reject(error) : resolve());
    });
    return fs.readFile(archive);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
}
