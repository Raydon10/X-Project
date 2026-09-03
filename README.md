# 签字页项目 MVP

本项目是一个本地单体 Web 应用，用于演示签字页模板管理、变量管理、项目编组录入、Word-like 预览渲染和 DOCX/ZIP 导出流程。

当前仓库包含 `workspace/` 演示数据。别人 clone 后安装依赖即可直接看到已配置好的变量、模板、项目、编组和录入值。

## 环境要求

- Node.js >= 20
- npm

如果使用 nvm：

```bash
nvm use
```

## 安装与运行

```bash
npm install
npm run dev
```

浏览器打开：

```text
http://localhost:5173
```

也可以使用：

```bash
npm start
```

## 常用命令

```bash
npm run check
npm test
```

- `npm run check`：检查服务端和前端脚本语法。
- `npm test`：运行项目、模板、变量和页面结构测试。

## 功能模块

- 项目管理：创建、编辑、删除项目，关联模板。
- 编组与录入：将项目下多个模板编为一组，同变量在组内只需录入一次。
- 渲染预览：按当前项目和当前编组真实值替换模板中的 `{{变量值}}`。
- 导出：支持单模板导出、导出整组、导出全部；批量导出返回 ZIP。
- 模板管理：模板增删改查、导入 `.doc` / `.docx`、Word-like HTML 预览。
- AI 提取变量：调用云端模型，参考已有变量和模板文案，输出带 `{{变量值}}` 的完整模板正文。
- 变量管理：变量增删改查，支持单一变量和枚举变量。

## 演示数据

仓库已提交 `workspace/data/`，包含：

- `variables.json`：演示变量。
- `templates.json`：演示模板及 AI 提取后的变量。
- `templates/{templateId}/`：导入的原始 Word 模板。
- `projects.json`：演示项目。
- `template-groups.json`：项目模板编组。
- `project-values/`：项目真实值录入数据。
- `template-prompts.json`：模板变量提取提示词。
- `audit.ndjson`：演示操作审计日志。

如果需要重置演示状态，可以删除 `workspace/` 后重新从 git 恢复：

```bash
git checkout -- workspace
```

## 典型体验流程

1. 打开 `http://localhost:5173/projects.html`。
2. 进入项目详情。
3. 在“关联模板”里确认项目已关联模板。
4. 在“编组与录入”里选择编组。
5. 检查右侧真实值录入表单。
6. 查看“渲染预览”，确认 `{{变量值}}` 已替换成真实值。
7. 点击“导出整组”或“批量导出全部 DOCX”。

导出失败时，页面会显示具体未填完的模板和变量数量。补齐后再次导出即可。

## 注意事项

- 这是本地 MVP，不包含登录注册、多账号、数据库或生产级权限隔离。
- `workspace/` 在本仓库中作为演示数据提交；实际生产项目不建议提交运行时数据。
- 代码中包含演示用云端 AI 配置。公开仓库或生产使用时，应改为环境变量或服务端密钥管理。
- `.docx` 预览采用 Word-like HTML，还原常见段落、表格、字体、颜色和对齐格式，不等同于完整 Word 排版引擎。
