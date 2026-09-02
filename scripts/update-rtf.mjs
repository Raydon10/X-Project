import fs from 'node:fs/promises';

function escapeRtf(text) {
  return [...text].map((character) => {
    const code = character.charCodeAt(0);
    if (character === '\\' || character === '{' || character === '}') return '\\' + character;
    if (code > 127) return '\\u' + (code > 32767 ? code - 65536 : code) + '?';
    return character;
  }).join('');
}
function render(lines) {
  return '{\\rtf1\\ansi\\deff0{\\fonttbl{\\f0\\fnil Arial;}}\\paperw11900\\paperh16840\\margl1440\\margr1440\\pard\\sa220\\sl276\\slmult1\\f0\\fs28\\n' +
    lines.map((line) => (line.bold ? '\\b ' : '') + escapeRtf(line.text) + (line.bold ? '\\b0' : '') + '\\par \\n').join('') + '}';
}
const architecture = [
  { text: '签字页项目 MVP 技术架构设计（14小时真实闭环）', bold: true },
  { text: '1. 交付目标与范围', bold: true },
  { text: '交付本地单体 Web 应用，真实跑通 Excel 导入、字段映射与校验、DOCX 批量生成、失败项局部重试、审核通过后 ZIP 导出，以及通过本机 Codex CLI 生成模板变量建议并由人工确认。' },
  { text: '采用一个预置演示账号和四种可直接切换角色：项目负责人、助理律师、审核人、模板管理员。不实现登录、真实多账号、项目级数据隔离和动态权限配置。' },
  { text: '2. 技术架构', bold: true },
  { text: '前端采用 React + Vite；本地服务采用 Node.js + TypeScript + Express 并提供 REST API；文件系统保存项目、模板、导入数据、任务、生成结果和 NDJSON 审计记录。前端不直接读写文件，写入经临时文件和 rename 原子保存。' },
  { text: '核心目录：workspace/project.json、template.json、rows.json、tasks.json、audit.ndjson、results/<任务ID>/。' },
  { text: '3. 角色切换与固定权限矩阵', bold: true },
  { text: '项目负责人：更新项目、发起生成、提交审核、导出已审核结果。助理律师：Excel 导入、查看校验、修正数据、重试失败结果。审核人：审核通过或驳回。模板管理员：上传 DOCX、发起 AI 识别、确认变量建议。' },
  { text: '所有写操作携带当前演示角色；服务端按固定矩阵拦截越权请求，并将角色、操作、时间和对象写入审计日志。' },
  { text: '4. 真实业务链路', bold: true },
  { text: '模板管理员上传 DOCX 或使用预置模板，调用 Codex CLI 识别变量。AI 仅返回结构化候选建议；超时、不可用或非法 JSON 时不修改正式变量；管理员确认后才保存。' },
  { text: '助理律师上传 Excel，系统映射参与方名称、参与方类型、公司名称、法定代表人、会议日期，并返回行号、字段和错误原因。' },
  { text: '项目负责人发起生成后，系统为每个参与方创建独立结果与数据快照，逐份写出 DOCX。单条失败不影响其他结果；修正后只重新生成该结果，结果版本加一。' },
  { text: '生成全成功后由负责人提交审核，审核人通过后负责人下载成功结果组成的 ZIP。' },
  { text: '5. 最小接口', bold: true },
  { text: '接口包括 POST /api/templates/:id/analyze-variables、POST /api/imports/preview、POST /api/imports/confirm、POST /api/generation-tasks、POST /api/results/:id/retry、POST /api/reviews、POST /api/reviews/:id/decision，以及 GET /api/exports/:taskId。' },
  { text: '6. 验收与明确不做', bold: true },
  { text: '验收：角色切换影响操作权限与审计；样例 Excel 显示缺失必填项；两条合法数据生成 DOCX、通过审核并导出 ZIP；AI 建议未经确认不得落库；重启后项目和任务可恢复。' },
  { text: '不做：模板组、模板 Diff/回滚、数据库、消息队列、多模型 Adapter、SSO、真实数据权限、复杂审批、在线 Word 编辑和 PDF 转换。' },
];
const tracking = [
  { text: '签字页项目开发状态跟踪（14小时真实闭环）', bold: true },
  { text: '已完成', bold: true },
  { text: '☑ 初始化 React + Vite 前端、Node + TypeScript 服务端和本地 workspace。' },
  { text: '☑ 建立项目、模板、导入数据、任务、结果、审计记录的最小文件模型；写入使用原子 rename。' },
  { text: '☑ 单账号四角色切换与固定权限矩阵：负责人、助理律师、审核人、模板管理员。' },
  { text: '☑ 项目创建/更新、角色操作审计和重启后数据恢复。' },
  { text: '☑ DOCX 模板上传、预置模板和本机 Codex CLI 变量识别；AI 建议需人工确认。' },
  { text: '☑ Excel 解析、字段映射、预览及必填/日期校验；参与方数据保存与直接修正。' },
  { text: '☑ 独立 DOCX 批量生成、结果快照、成功/失败状态、失败项局部重试、审核和 ZIP 导出。' },
  { text: '☑ 样例 Excel、DOCX 模板以及自动化权限、校验、持久化测试。' },
  { text: '已验证', bold: true },
  { text: '☑ 样例 Excel 中公司名称缺失可定位到第 4 行及字段名。' },
  { text: '☑ 两条合法参与方数据已完成真实 DOCX 生成、负责人提交、审核人通过和 ZIP 导出。' },
  { text: '☑ npm test：3 项测试通过；npm run build：TypeScript 编译与 Vite 生产构建通过。' },
  { text: '演示执行清单', bold: true },
  { text: '1. 切换为模板管理员，运行 Codex 变量识别并确认建议。' },
  { text: '2. 切换为助理律师，上传 fixtures/签字页导入样例.xlsx，展示第 4 行缺失公司名称；修正或使用合法行确认导入。' },
  { text: '3. 切换为项目负责人，发起批量生成并查看结果和数据快照。' },
  { text: '4. 切换为审核人，审核通过任务；再切回负责人下载 ZIP。' },
  { text: '5. 查看审计记录，说明角色切换后的权限与责任追溯。' },
  { text: '后续项（不纳入本次14小时交付）', bold: true },
  { text: '模板组、模板版本 Diff/回滚、动态权限、真实多账号和数据隔离、多 AI CLI、复杂审批、PDF 转换、在线 Word 编辑和外部系统集成。' },
];
await fs.writeFile('签字页项目 MVP 技术架构设计 .rtf', render(architecture));
await fs.writeFile('开发状态跟踪.rtf', render(tracking));
