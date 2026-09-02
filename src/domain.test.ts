import { describe, expect, test } from 'vitest';
import { can, validateRows } from './domain';

describe('fixed demo role permissions', () => {
  test('allows only the template administrator to confirm AI suggestions', () => {
    expect(can('template_admin', 'confirm_ai')).toBe(true);
    expect(can('project_owner', 'confirm_ai')).toBe(false);
  });
});

describe('import validation', () => {
  test('identifies a missing required company name with its row', () => {
    const result = validateRows([
      { participantName: '华夏证券', participantType: '机构股东', companyName: '' },
    ]);
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toMatchObject({ row: 2, field: 'companyName', code: 'MISSING_REQUIRED' });
  });
});
