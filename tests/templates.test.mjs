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

test('cloud AI config uses Zhipu GLM without exposing the API key', () => {
  const config = getAiConfig();
  assert.equal(config.provider, 'zhipu');
  assert.equal(config.baseUrl, 'https://open.bigmodel.cn/api/paas/v4');
  assert.equal(config.model, 'glm-5.2');
  assert.equal(config.configured, true);
  assert.equal(JSON.stringify(config).includes('5b71ba'), false);
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

    assert.match(aiInput, /批量生成正式签署页/);
    assert.match(aiInput, /# 输入/);
    assert.match(aiInput, /识别公司名称变量/);
    assert.match(aiInput, /"value": "companyName"/);
    assert.match(aiInput, /templateContent/);
    assert.match(aiInput, /公司名称：星河科技/);
    assert.match(aiInput, /禁止输出 templateText/);
    assert.match(aiInput, /replacements/);
    assert.match(aiInput, /original/);
    assert.ok(aiInput.length < 2600);
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

test('parses pretty-printed multiline JSON from the AI without losing variables', async () => {
  await withStore(async (store) => {
    const template = await createTemplate(store, { name: '多行JSON模板', detail: '' }, { timestamp: 20260903121010 });
    await updateTemplate(store, template.id, { previewText: '公司名称：星河科技' });

    const updated = await analyzeTemplateVariables(store, template.id, { prompt: '提取变量' }, [], async () => `{
  "templateText": "公司名称：{{companyName}}",
  "variables": [
    { "name": "公司名称", "value": "companyName" }
  ]
}`);

    assert.equal(updated.previewText, '公司名称：{{companyName}}');
    assert.deepEqual(updated.extractedVariables.map((item) => item.value), ['companyName']);
    assert.equal(updated.extractedVariables[0].matchStatus, 'new');
  });
});

test('extracts variables from prose-wrapped AI output with surrounding text', async () => {
  await withStore(async (store) => {
    const template = await createTemplate(store, { name: '杂质JSON模板', detail: '' }, { timestamp: 20260903121111 });
    await updateTemplate(store, template.id, { previewText: '公司名称：星河科技' });

    const updated = await analyzeTemplateVariables(store, template.id, { prompt: '提取变量' }, [], async () => '好的，提取结果如下：{"templateText":"公司名称：{{companyName}}","variables":[{"name":"公司名称","value":"companyName"}]} 以上。');

    assert.equal(updated.previewText, '公司名称：{{companyName}}');
    assert.deepEqual(updated.extractedVariables.map((item) => item.value), ['companyName']);
  });
});

test('applies AI replacements on the original HTML template while preserving all formatting', async () => {
  await withStore(async (store) => {
    const template = await createTemplate(store, { name: '格式保留模板', detail: '' }, { timestamp: 20260903130001 });
    const sourceHtml = '<p>公司名称：<u>星河科技</u></p><table><tbody><tr><td>负责人：【张三】</td><td>日期：2026年9月3日</td></tr></tbody></table>';
    const sourceText = '公司名称：星河科技\n负责人：【张三】 日期：2026年9月3日';
    await updateTemplate(store, template.id, { previewText: sourceText, previewHtml: sourceHtml });

    const updated = await analyzeTemplateVariables(store, template.id, {
      prompt: '提取变量',
      textOverride: sourceText,
      textHtml: sourceHtml,
    }, [
      { name: '公司名称', value: 'companyName', type: 'single' },
    ], async () => JSON.stringify({
      replacements: [
        { original: '星河科技', name: '公司名称', value: 'companyName' },
        { original: '【张三】', name: '负责人', value: 'firmHeadName' },
        { original: '2026年9月3日', name: '签署日期', value: 'signDate' },
      ],
    }));

    assert.match(updated.previewHtml, /<u><span class="variable-chip" data-status="existing" data-variable="companyName">\{\{companyName\}\}<\/span><\/u>/);
    assert.match(updated.previewHtml, /<table><tbody><tr><td>负责人：<span class="variable-chip" data-status="new" data-variable="firmHeadName">/);
    assert.match(updated.previewHtml, /<td>日期：<span class="variable-chip" data-status="new" data-variable="signDate">/);
    assert.ok(updated.previewHtml.includes('</tbody></table>'));
    assert.ok(!updated.previewHtml.includes('【张三】'));
    assert.deepEqual(updated.extractedVariables.map((item) => item.value), ['companyName', 'firmHeadName', 'signDate']);
    assert.equal(updated.extractedVariables[0].matchStatus, 'existing');
    assert.equal(updated.extractedVariables[1].matchStatus, 'new');
    assert.equal(updated.extractedVariables[2].matchStatus, 'new');
    assert.match(updated.previewText, /公司名称：\{\{companyName\}\}/);
    assert.match(updated.previewText, /负责人：\{\{firmHeadName\}\}/);
  });
});

test('replaces every occurrence of the same original fragment and skips unmatched ones', async () => {
  await withStore(async (store) => {
    const template = await createTemplate(store, { name: '多处替换模板', detail: '' }, { timestamp: 20260903130101 });
    await updateTemplate(store, template.id, { previewText: '星河科技与星河科技的合同' });

    const updated = await analyzeTemplateVariables(store, template.id, { prompt: '提取变量' }, [], async () => JSON.stringify({
      replacements: [
        { original: '星河科技', name: '公司名称', value: 'companyName' },
        { original: '这段文字不存在', name: '幽灵变量', value: 'ghostValue' },
      ],
    }));

    assert.equal(updated.previewText, '{{companyName}}与{{companyName}}的合同');
    assert.deepEqual(updated.extractedVariables.map((item) => item.value), ['companyName']);
    assert.ok(!updated.previewText.includes('ghostValue'));
  });
});

test('keeps the latest raw AI input and output in aiDebug for troubleshooting', async () => {
  await withStore(async (store) => {
    const template = await createTemplate(store, { name: '调试信息模板', detail: '' }, { timestamp: 20260903141010 });
    await updateTemplate(store, template.id, { previewText: '公司名称：星河科技' });

    const aiOutput = '{"replacements":[{"original":"星河科技","name":"公司名称","value":"companyName"}]}';
    const updated = await analyzeTemplateVariables(store, template.id, { prompt: '提取变量' }, [], async (input) => {
      assert.match(input, /提取签字页模板/);
      assert.match(input, /公司名称：星河科技/);
      return aiOutput;
    });

    assert.ok(updated.aiDebug);
    assert.match(updated.aiDebug.input, /公司名称：星河科技/);
    assert.match(updated.aiDebug.input, /"userPrompt": "提取变量"/);
    assert.equal(updated.aiDebug.output, aiOutput);
    assert.equal(updated.aiDebug.error, '');
    assert.deepEqual(updated.extractedVariables.map((item) => item.value), ['companyName']);

    await assert.rejects(
      analyzeTemplateVariables(store, template.id, { prompt: '再提取' }, [], async () => 'not json'),
      /AI 提取失败/
    );
    const latest = await getTemplate(store, template.id);
    assert.equal(latest.aiDebug.output, 'not json');
    assert.match(latest.aiDebug.error, /JSON/);
  });
});

test('strips HTML tags from AI original fragments so template formatting survives replacement', async () => {
  await withStore(async (store) => {
    const template = await createTemplate(store, { name: '标签剥离模板', detail: '' }, { timestamp: 20260903150001 });
    const sourceHtml = '<p>负责人：<u>【张三】</u></p><table><tbody><tr><td>日期：<strong>2026年9月3日</strong></td></tr></tbody></table>';
    await updateTemplate(store, template.id, { previewText: '负责人：【张三】', previewHtml: sourceHtml });

    const updated = await analyzeTemplateVariables(store, template.id, {
      prompt: '提取变量',
      textOverride: '负责人：【张三】',
      textHtml: sourceHtml,
    }, [], async () => JSON.stringify({
      replacements: [
        { original: '<u>【张三】</u>', name: '负责人', value: 'firmHead' },
        { original: '日期：<strong>2026年9月3日</strong>', name: '签署日期', value: 'signDate' },
      ],
    }));

    assert.match(updated.previewHtml, /<u><span class="variable-chip" data-status="new" data-variable="firmHead">\{\{firmHead\}\}<\/span><\/u>/);
    assert.match(updated.previewHtml, /<td>日期：<strong><span class="variable-chip" data-status="new" data-variable="signDate">/);
    assert.ok(updated.previewHtml.includes('</strong></td></tr></tbody></table>'));
    assert.ok(!updated.previewHtml.includes('【张三】'));
    assert.deepEqual(updated.extractedVariables.map((item) => item.value), ['firmHead', 'signDate']);
  });
});

test('recovers replacements from legacy templateText via anchor alignment to preserve formatting', async () => {
  await withStore(async (store) => {
    const template = await createTemplate(store, { name: '锚点对齐模板', detail: '' }, { timestamp: 20260903160001 });
    const sourceHtml = '<p>公司名称：星河科技</p><table><tbody><tr><td>负责人：【张三】</td></tr></tbody></table>';
    await updateTemplate(store, template.id, { previewText: '公司名称：星河科技', previewHtml: sourceHtml });

    const updated = await analyzeTemplateVariables(store, template.id, {
      prompt: '提取变量',
      textOverride: '公司名称：星河科技',
      textHtml: sourceHtml,
    }, [], async () => JSON.stringify({
      templateText: '公司名称：{{companyName}}<table><tbody><tr><td>负责人：{{firmHead}}</table>',
      variables: [
        { name: '公司名称', value: 'companyName' },
        { name: '负责人', value: 'firmHead' },
      ],
    }));

    assert.match(updated.previewHtml, /<p>公司名称：<span class="variable-chip"[^>]*data-variable="companyName">/);
    assert.match(updated.previewHtml, /<td>负责人：<span class="variable-chip"[^>]*data-variable="firmHead">/);
    assert.ok(updated.previewHtml.includes('</td></tr></tbody></table>'));
    assert.deepEqual(updated.extractedVariables.map((item) => item.value), ['companyName', 'firmHead']);
  });
});

test('aligns AI variables to existing ones even when value/name differ but semantics overlap', async () => {
  await withStore(async (store) => {
    const template = await createTemplate(store, { name: '语义对齐模板', detail: '' }, { timestamp: 20260903171500 });
    const sourceHtml = '<p>发行人：星河科技股份有限公司</p><p>经办律师：张三</p><p>签署日期：2026年9月3日</p>';
    await updateTemplate(store, template.id, { previewText: '发行人：星河科技', previewHtml: sourceHtml });

    const updated = await analyzeTemplateVariables(store, template.id, {
      prompt: '提取变量',
      textOverride: '',
      textHtml: sourceHtml,
    }, [
      { name: '公司名称', value: 'companyName', type: 'single', description: '公司名称' },
      { name: '签字律师', value: 'lawyerName', type: 'single', description: '律师姓名' },
      { name: '日期', value: 'signDate', type: 'single', description: '签署日期' },
    ], async () => JSON.stringify({
      replacements: [
        { original: '星河科技股份有限公司', name: '发行人名称', value: 'issuerName' },
        { original: '张三', name: '经办律师', value: 'lawyer' },
        { original: '2026年9月3日', name: '签署日期', value: 'signDate' },
      ],
    }));

    assert.deepEqual(updated.extractedVariables.map((item) => item.value), ['companyName', 'lawyerName', 'signDate']);
    assert.equal(updated.extractedVariables[0].matchStatus, 'existing');
    assert.equal(updated.extractedVariables[1].matchStatus, 'existing');
    assert.equal(updated.extractedVariables[2].matchStatus, 'existing');
    assert.match(updated.previewHtml, /data-variable="companyName"/);
    assert.match(updated.previewHtml, /data-variable="lawyerName"/);
    assert.match(updated.previewHtml, /data-variable="signDate"/);
  });
});

test('replaces AI originals that span across split HTML tags in the template', async () => {
  await withStore(async (store) => {
    const template = await createTemplate(store, { name: '跨标签模板', detail: '' }, { timestamp: 20260903192000 });
    const sourceHtml = '<p>经办律师：<span>【</span><span>王五】律师</span></p><p><span>年</span><span>     </span><span>月</span><span>     </span><span>日</span></p>';
    await updateTemplate(store, template.id, { previewText: '经办律师：【王五】  年     月     日', previewHtml: sourceHtml });

    const updated = await analyzeTemplateVariables(store, template.id, {
      prompt: '提取变量',
      textOverride: '经办律师：【王五】  年     月     日',
      textHtml: sourceHtml,
    }, [], async () => JSON.stringify({
      replacements: [
        { original: '【王五】', name: '经办律师', value: 'lawyer1' },
        { original: '年     月     日', name: '签署日期', value: 'signDate' },
      ],
    }));

    assert.match(updated.previewHtml, /data-variable="lawyer1">\{\{lawyer1\}\}<\/span>/);
    assert.match(updated.previewHtml, /data-variable="signDate">\{\{signDate\}\}<\/span>/);
    assert.ok(!updated.previewHtml.includes('【王五】'));
    assert.ok(!updated.previewHtml.includes('王五】'));
    assert.deepEqual(updated.extractedVariables.map((item) => item.value), ['lawyer1', 'signDate']);
  });
});

test('skips invalid replacement items instead of failing the whole extraction', async () => {
  await withStore(async (store) => {
    const template = await createTemplate(store, { name: '部分缺失模板', detail: '' }, { timestamp: 20260903193000 });
    await updateTemplate(store, template.id, { previewText: '公司：星河科技\n日期：2026年9月3日' });

    const updated = await analyzeTemplateVariables(store, template.id, { prompt: '提取' }, [], async () => JSON.stringify({
      replacements: [
        { original: '星河科技', name: '公司名称', value: 'companyName' },
        { original: '', name: '幽灵', value: 'ghost' },                              // original 空，跳过
        { original: '2026年9月3日', name: '签署日期' },                              // 缺 value，跳过
        { target: '不识别的字段名', name: '错位', value: 'wrongName' },              // 不识别字段，跳过
      ],
    }));

    assert.deepEqual(updated.extractedVariables.map((item) => item.value), ['companyName']);
    assert.match(updated.previewText, /公司：\{\{companyName\}\}/);
    assert.ok(!updated.previewText.includes('ghost'));
    assert.ok(!updated.previewText.includes('wrongName'));
  });
});

test('rewrites synonymous template placeholders to use existing system variable values', async () => {
  await withStore(async (store) => {
    const template = await createTemplate(store, { name: '同义占位模板', detail: '' }, { timestamp: 20260903194000 });
    // 模板里已用 {{oldCompany}} 占位，但系统已有变量是 companyName
    await updateTemplate(store, template.id, { previewText: '公司：{{oldCompany}}', previewHtml: '<p>公司：{{oldCompany}}</p>' });

    const updated = await analyzeTemplateVariables(store, template.id, {
      prompt: '提取变量',
      textOverride: '公司：{{oldCompany}}',
      textHtml: '<p>公司：{{oldCompany}}</p>',
    }, [
      { name: '公司名称', value: 'companyName', type: 'single', description: '公司名称' },
    ], async () => JSON.stringify({
      replacements: [
        { original: '{{oldCompany}}', name: '公司名称', value: 'companyName' },
      ],
    }));

    assert.match(updated.previewHtml, /data-variable="companyName">\{\{companyName\}\}<\/span>/);
    assert.ok(!updated.previewHtml.includes('oldCompany'));
    assert.deepEqual(updated.extractedVariables.map((item) => item.value), ['companyName']);
    assert.equal(updated.extractedVariables[0].matchStatus, 'existing');
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
