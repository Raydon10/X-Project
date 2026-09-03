import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs/promises';

test('template and variable management use independent pages with template menu first', async () => {
  const index = await fs.readFile('public/index.html', 'utf8');
  const templates = await fs.readFile('public/templates.html', 'utf8');
  const variables = await fs.readFile('public/variables.html', 'utf8');
  const projects = await fs.readFile('public/projects.html', 'utf8');

  assert.match(index, /http-equiv="refresh" content="0; url=\/projects\.html"/);
  assert.ok(projects.includes('id="exportStatus"'));
  assert.ok(templates.includes('id="templateModule"'));
  assert.ok(!templates.includes('id="variableModule"'));
  assert.ok(templates.indexOf('id="extractVariables"') < templates.indexOf('id="scanAiTools"'));
  assert.ok(templates.includes('检测云端 AI'));
  assert.ok(!templates.includes('扫描 AI CLI'));
  assert.ok(templates.includes('id="aiStatus"'));
  assert.ok(templates.includes('class="template-tabs"'));
  assert.ok(templates.includes('data-tab="preview"'));
  assert.ok(!templates.includes('data-tab="ai"'));
  assert.ok(!templates.includes('data-panel="ai"'));
  assert.ok(templates.includes('data-panel="variables"'));
  assert.ok(templates.indexOf('id="templateVariables"') < templates.indexOf('id="aiPrompt"'));
  assert.ok(variables.includes('id="variableRows"'));
  assert.ok(!variables.includes('id="templateModule"'));
  assert.ok(templates.indexOf('/templates.html') < templates.indexOf('/variables.html'));
  assert.ok(variables.indexOf('/templates.html') < variables.indexOf('/variables.html'));
});
