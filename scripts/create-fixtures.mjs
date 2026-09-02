import fs from 'node:fs/promises';
import path from 'node:path';
import * as XLSX from 'xlsx';
import { Document, Packer, Paragraph, TextRun } from 'docx';

const output = path.resolve('fixtures');
await fs.mkdir(output, { recursive: true });
const rows = [
  { 参与方名称: '华夏证券股份有限公司', 参与方类型: '机构股东', 公司名称: '星河科技股份有限公司', 法定代表人: '李明', 会议日期: '2026-09-03' },
  { 参与方名称: '张晓', 参与方类型: '自然人股东', 公司名称: '星河科技股份有限公司', 法定代表人: '李明', 会议日期: '2026-09-03' },
  { 参与方名称: '异常演示参与方', 参与方类型: '机构股东', 公司名称: '', 法定代表人: '李明', 会议日期: '2026-09-03' },
];
const workbook = XLSX.utils.book_new();
XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet(rows), '签字页数据');
XLSX.writeFile(workbook, path.join(output, '签字页导入样例.xlsx'));
const lines = [
  '星河科技股份有限公司',
  '关于 【meetingDate】 临时股东大会会议决议之签字页',
  '',
  '签字主体：【participantName】',
  '主体类型：【participantType】',
  '法定代表人：【representativeName】',
  '',
  '公司名称：【companyName】',
];
const document = new Document({ sections: [{ children: lines.map((line) => new Paragraph({ children: [new TextRun({ text: line || ' ', font: 'STHeiti' })] })) }] });
await fs.writeFile(path.join(output, '签字页模板样例.docx'), await Packer.toBuffer(document));
