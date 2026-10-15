import { eq, and, isNull } from 'drizzle-orm';
import { db, pool } from './client.js';
import {
  calls,
  campaigns,
  companies,
  dialerServers,
  dispositionMappings,
  qaForms,
  qaFormVersions,
  recordings,
  roles,
  transfers,
  users,
  viciAgents,
} from './schema.js';
import { config } from '../config.js';
import { hashPassword } from '../lib/crypto.js';
import { ROLE_PRESETS } from '../auth/permissions.js';
import { runMigrations } from './migrate.js';

/**
 * Idempotent seed: system roles + bootstrap super admin. With SEED_DEMO=true
 * also creates a demo company whose data is entirely synthetic and flagged
 * is_mock=true — never mixed with real VICIdial imports.
 */
export async function seed(): Promise<void> {
  // ---- global system roles ----
  const roleIds: Record<string, string> = {};
  for (const [name, preset] of Object.entries(ROLE_PRESETS)) {
    const existing = await db
      .select()
      .from(roles)
      .where(and(isNull(roles.companyId), eq(roles.name, name)));
    if (existing.length > 0) {
      roleIds[name] = existing[0].id;
      continue;
    }
    const [row] = await db
      .insert(roles)
      .values({
        companyId: null,
        name,
        description: preset.description,
        permissions: preset.permissions,
        isSystem: true,
      })
      .returning();
    roleIds[name] = row.id;
  }

  // ---- bootstrap super admin ----
  const existingAdmin = await db.select().from(users).where(eq(users.email, config.SUPERADMIN_EMAIL));
  if (existingAdmin.length === 0) {
    await db.insert(users).values({
      companyId: null,
      roleId: roleIds.super_admin,
      email: config.SUPERADMIN_EMAIL,
      passwordHash: await hashPassword(config.SUPERADMIN_PASSWORD),
      name: 'Super Admin',
    });
    console.log(`Super admin created: ${config.SUPERADMIN_EMAIL}`);
  }

  if (config.SEED_DEMO) {
    await seedDemo(roleIds);
  }
}

async function seedDemo(roleIds: Record<string, string>): Promise<void> {
  const existing = await db.select().from(companies).where(eq(companies.slug, 'demo-mock'));
  if (existing.length > 0) {
    console.log('Demo company already present, skipping.');
    return;
  }

  const [company] = await db
    .insert(companies)
    .values({ name: 'Demo Company (MOCK DATA)', slug: 'demo-mock' })
    .returning();

  const [adminRole] = await db
    .insert(roles)
    .values({
      companyId: company.id,
      name: 'company_admin',
      description: ROLE_PRESETS.company_admin.description,
      permissions: ROLE_PRESETS.company_admin.permissions,
      isSystem: true,
    })
    .returning();
  await db.insert(roles).values([
    {
      companyId: company.id,
      name: 'qa_manager',
      description: ROLE_PRESETS.qa_manager.description,
      permissions: ROLE_PRESETS.qa_manager.permissions,
      isSystem: true,
    },
    {
      companyId: company.id,
      name: 'qa_reviewer',
      description: ROLE_PRESETS.qa_reviewer.description,
      permissions: ROLE_PRESETS.qa_reviewer.permissions,
      isSystem: true,
    },
  ]);

  const [demoAdmin] = await db
    .insert(users)
    .values({
      companyId: company.id,
      roleId: adminRole.id,
      email: 'demo-admin@example.com',
      passwordHash: await hashPassword('DemoAdmin123!'),
      name: 'Demo Admin',
    })
    .returning();

  // Two mock dialers: fronters on A, closers on B (cross-dialer scenario).
  const [dialerA] = await db
    .insert(dialerServers)
    .values({
      companyId: company.id,
      name: 'MOCK Dialer A (fronters)',
      baseUrl: 'https://mock-dialer-a.invalid',
      sourceMode: 'db',
      timezone: 'America/New_York',
      active: false, // never synced — mock only
    })
    .returning();
  const [dialerB] = await db
    .insert(dialerServers)
    .values({
      companyId: company.id,
      name: 'MOCK Dialer B (closers)',
      baseUrl: 'https://mock-dialer-b.invalid',
      sourceMode: 'db',
      timezone: 'America/New_York',
      active: false,
    })
    .returning();

  const [fronter] = await db
    .insert(viciAgents)
    .values({
      companyId: company.id,
      dialerServerId: dialerA.id,
      viciUser: '1001',
      fullName: 'Mock Fronter One',
      agentRole: 'fronter',
    })
    .returning();
  const [closer] = await db
    .insert(viciAgents)
    .values({
      companyId: company.id,
      dialerServerId: dialerB.id,
      viciUser: '2001',
      fullName: 'Mock Closer One',
      agentRole: 'closer',
    })
    .returning();

  const [campA] = await db
    .insert(campaigns)
    .values({
      companyId: company.id,
      dialerServerId: dialerA.id,
      viciCampaignId: 'FRONT1',
      name: 'Mock Fronting Campaign',
    })
    .returning();

  await db.insert(dispositionMappings).values([
    { companyId: company.id, dispositionCode: 'XFER', meaning: 'transfer', createdBy: demoAdmin.id },
    { companyId: company.id, dispositionCode: 'SALE', meaning: 'sale', createdBy: demoAdmin.id },
    { companyId: company.id, dispositionCode: 'NI', meaning: 'other', createdBy: demoAdmin.id },
  ]);

  // Mock call pair: fronter XFER on dialer A -> closer SALE on dialer B.
  const base = Date.now() - 24 * 3600 * 1000;
  const [fCall] = await db
    .insert(calls)
    .values({
      companyId: company.id,
      dialerServerId: dialerA.id,
      source: 'vicidial_log',
      viciLeadId: 500123,
      viciUniqueId: '1700000000.12345',
      campaignId: campA.id,
      viciAgentId: fronter.id,
      viciUserRaw: '1001',
      phoneNumber: '5551230001',
      callDate: new Date(base),
      lengthSec: 240,
      status: 'XFER',
      isMock: true,
    })
    .returning();
  const [cCall] = await db
    .insert(calls)
    .values({
      companyId: company.id,
      dialerServerId: dialerB.id,
      source: 'vicidial_closer_log',
      viciLeadId: 900456, // different lead id on the other dialer — expected
      viciUniqueId: '1700000190.54321',
      viciAgentId: closer.id,
      viciUserRaw: '2001',
      phoneNumber: '5551230001',
      callDate: new Date(base + 200 * 1000),
      lengthSec: 600,
      status: 'SALE',
      isMock: true,
    })
    .returning();

  const [xfer] = await db
    .insert(transfers)
    .values({
      companyId: company.id,
      dialerServerId: dialerA.id,
      fronterCallId: fCall.id,
      closerCallId: cCall.id,
      xferTime: new Date(base + 230 * 1000),
      phoneNumber: '5551230001',
      viciLeadId: 500123,
      closerLeadId: 900456,
      matchStatus: 'matched',
      matchConfidence: 90,
      matchMethod: 'mock-seed',
      queueStatus: 'closed',
      saleDisposition: 'SALE',
      closedAt: new Date(base + 830 * 1000),
      isMock: true,
    })
    .returning();

  await db.insert(recordings).values([
    {
      companyId: company.id,
      dialerServerId: dialerA.id,
      callId: fCall.id,
      viciRecordingId: 111,
      viciLeadId: 500123,
      filename: 'MOCK_20260101-120000_5551230001-all.mp3',
      locationUrl: null,
      startTime: new Date(base),
      lengthSec: 240,
      status: 'missing', // mock — no real audio behind it
      isMock: true,
    },
    {
      companyId: company.id,
      dialerServerId: dialerB.id,
      callId: cCall.id,
      viciRecordingId: 222,
      viciLeadId: 900456,
      filename: 'MOCK_20260101-120330_5551230001-all.mp3',
      locationUrl: null,
      startTime: new Date(base + 200 * 1000),
      lengthSec: 600,
      status: 'missing',
      isMock: true,
    },
  ]);

  // Sample published QA form for closers.
  const formSchema = {
    sections: [
      {
        id: 'open',
        title: 'Opening',
        questions: [
          {
            id: 'q_greeting',
            text: 'Did the closer greet the customer and state the company name?',
            type: 'yes_no',
            weight: 10,
            required: true,
            critical: false,
          },
          {
            id: 'q_recap',
            text: 'Did the closer recap the fronter conversation accurately?',
            type: 'rating',
            scaleMax: 5,
            weight: 15,
            required: true,
            critical: false,
          },
        ],
      },
      {
        id: 'compliance',
        title: 'Compliance',
        questions: [
          {
            id: 'q_consent',
            text: 'Was recording consent / required disclosure given?',
            type: 'pass_fail',
            weight: 25,
            required: true,
            critical: true,
          },
          {
            id: 'q_notes',
            text: 'Reviewer notes',
            type: 'text',
            weight: 0,
            required: false,
            critical: false,
          },
        ],
      },
    ],
  };
  const [form] = await db
    .insert(qaForms)
    .values({
      companyId: company.id,
      name: 'Closer QA Scorecard (Demo)',
      description: 'Sample published form seeded for the mock company',
      target: 'closer',
      state: 'published',
      currentVersion: 1,
      draftSchema: formSchema,
      createdBy: demoAdmin.id,
    })
    .returning();
  await db.insert(qaFormVersions).values({
    formId: form.id,
    version: 1,
    schema: formSchema,
    maxScore: '50',
    passThreshold: '80',
    createdBy: demoAdmin.id,
  });

  console.log(`Demo company seeded (MOCK DATA): transfer=${xfer.id}`);
}

if (process.argv[1] && /seed\.(ts|js)$/.test(process.argv[1])) {
  runMigrations()
    .then(() => seed())
    .then(() => {
      console.log('Seed complete.');
      return pool.end();
    })
    .catch((err) => {
      console.error('Seed failed:', err);
      process.exit(1);
    });
}
