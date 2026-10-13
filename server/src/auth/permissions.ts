/**
 * Flat permission catalogue. Roles carry arrays of these strings; '*' grants
 * everything (super admin). Checks always happen server-side.
 */
export const PERMISSIONS = [
  'dashboard.view',
  'queues.view',
  'calls.view',
  'recordings.play',
  'qa.forms.manage',
  'qa.evaluate',
  'qa.assign',
  'qa.view',
  'reports.view',
  'reports.export',
  'admin.companies',
  'admin.dialers',
  'admin.agents',
  'admin.dispositions',
  'admin.users',
  'admin.audit',
  'admin.sync',
] as const;

export type Permission = (typeof PERMISSIONS)[number];

export const ROLE_PRESETS: Record<string, { description: string; permissions: string[] }> = {
  super_admin: {
    description: 'Platform-wide administrator (all companies)',
    permissions: ['*'],
  },
  company_admin: {
    description: 'Full administration of one company',
    permissions: PERMISSIONS.filter((p) => p !== 'admin.companies'),
  },
  qa_manager: {
    description: 'Manages QA forms, assignments, reviewers and reporting',
    permissions: [
      'dashboard.view',
      'queues.view',
      'calls.view',
      'recordings.play',
      'qa.forms.manage',
      'qa.evaluate',
      'qa.assign',
      'qa.view',
      'reports.view',
      'reports.export',
      'admin.agents',
      'admin.dispositions',
      'admin.sync',
    ],
  },
  qa_reviewer: {
    description: 'Reviews and scores calls',
    permissions: ['dashboard.view', 'queues.view', 'calls.view', 'recordings.play', 'qa.evaluate', 'qa.view'],
  },
};

export function hasPermission(granted: string[], needed: Permission): boolean {
  return granted.includes('*') || granted.includes(needed);
}
