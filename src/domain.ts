export type Role = 'project_owner' | 'assistant' | 'reviewer' | 'template_admin';
export type Action = 'create_project' | 'import_data' | 'repair_data' | 'start_generation' | 'confirm_ai' | 'submit_review' | 'decide_review' | 'export';

const permissions: Record<Role, Action[]> = {
  project_owner: ['create_project', 'start_generation', 'submit_review', 'export'],
  assistant: ['import_data', 'repair_data'],
  reviewer: ['decide_review'],
  template_admin: ['confirm_ai'],
};

export function can(role: Role, action: Action) {
  return permissions[role].includes(action);
}

export type ImportRow = {
  participantName?: string;
  participantType?: string;
  companyName?: string;
  representativeName?: string;
  meetingDate?: string;
};

export type ValidationError = { row: number; field: keyof ImportRow; code: 'MISSING_REQUIRED' | 'INVALID_DATE'; message: string };

export function validateRows(rows: ImportRow[]) {
  const errors: ValidationError[] = [];
  rows.forEach((row, index) => {
    const rowNumber = index + 2;
    (['participantName', 'participantType', 'companyName'] as const).forEach((field) => {
      if (!row[field]?.trim()) errors.push({ row: rowNumber, field, code: 'MISSING_REQUIRED', message: `${field} 为必填项` });
    });
    if (row.meetingDate && Number.isNaN(Date.parse(row.meetingDate))) {
      errors.push({ row: rowNumber, field: 'meetingDate', code: 'INVALID_DATE', message: 'meetingDate 不是有效日期' });
    }
  });
  return { valid: errors.length === 0, errors };
}

export const roleLabels: Record<Role, string> = {
  project_owner: '项目负责人',
  assistant: '助理律师',
  reviewer: '审核人',
  template_admin: '模板管理员',
};
