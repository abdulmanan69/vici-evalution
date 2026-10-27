import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  date,
  index,
  integer,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';

// ---------------------------------------------------------------------------
// Enums
// ---------------------------------------------------------------------------
export const userStatusEnum = pgEnum('user_status', ['active', 'disabled']);
export const sourceModeEnum = pgEnum('dialer_source_mode', ['api', 'db', 'hybrid']);
export const callSourceEnum = pgEnum('call_source', ['vicidial_log', 'vicidial_closer_log', 'manual']);
export const agentRoleEnum = pgEnum('agent_role', ['fronter', 'closer', 'blended', 'unknown']);
export const dispoMeaningEnum = pgEnum('dispo_meaning', ['transfer', 'sale', 'no_sale', 'callback', 'dnc', 'other']);
export const matchStatusEnum = pgEnum('match_status', ['pending_match', 'matched', 'flagged', 'unmatched']);
export const queueStatusEnum = pgEnum('queue_status', ['transfer', 'unclosed', 'closed']);
export const transferKindEnum = pgEnum('transfer_kind', ['transfer', 'callback_sale', 'inbound_sale']);
export const recordingStatusEnum = pgEnum('recording_status', ['pending', 'available', 'missing', 'error']);
export const formStateEnum = pgEnum('form_state', ['draft', 'published', 'archived']);
export const formTargetEnum = pgEnum('form_target', ['fronter', 'closer', 'any']);
export const evaluationStatusEnum = pgEnum('evaluation_status', ['draft', 'completed']);
export const syncJobStatusEnum = pgEnum('sync_job_status', ['queued', 'running', 'success', 'failed']);
export const assignmentStatusEnum = pgEnum('assignment_status', ['open', 'in_progress', 'done', 'cancelled']);

// ---------------------------------------------------------------------------
// Tenancy & access control
// ---------------------------------------------------------------------------
export const companies = pgTable('companies', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull(),
  slug: varchar('slug', { length: 64 }).notNull().unique(),
  status: varchar('status', { length: 20 }).notNull().default('active'),
  settings: jsonb('settings').notNull().default({}),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const roles = pgTable(
  'roles',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    // null companyId = global/system role (e.g. super_admin)
    companyId: uuid('company_id').references(() => companies.id, { onDelete: 'cascade' }),
    name: varchar('name', { length: 64 }).notNull(),
    description: text('description'),
    permissions: jsonb('permissions').$type<string[]>().notNull().default([]),
    isSystem: boolean('is_system').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('roles_company_name_uq').on(t.companyId, t.name)],
);

export const users = pgTable(
  'users',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    // null companyId = platform-level user (super admin)
    companyId: uuid('company_id').references(() => companies.id, { onDelete: 'cascade' }),
    roleId: uuid('role_id')
      .notNull()
      .references(() => roles.id),
    email: varchar('email', { length: 255 }).notNull().unique(),
    passwordHash: text('password_hash').notNull(),
    name: text('name').notNull(),
    status: userStatusEnum('status').notNull().default('active'),
    // null/empty = may use every QA form; otherwise the only forms this
    // reviewer can see and evaluate with (set by managers)
    allowedFormIds: jsonb('allowed_form_ids').$type<string[] | null>(),
    lastLoginAt: timestamp('last_login_at', { withTimezone: true }),
    // the company a person with several companies worked in last — their
    // next sign-in opens there
    lastCompanyId: uuid('last_company_id').references(() => companies.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('users_company_idx').on(t.companyId)],
);

export const sessions = pgTable(
  'sessions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    tokenHash: varchar('token_hash', { length: 64 }).notNull().unique(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    ip: text('ip'),
    userAgent: text('user_agent'),
    // the company this session works in; null = the user's own company
    activeCompanyId: uuid('active_company_id').references(() => companies.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('sessions_user_idx').on(t.userId)],
);

/**
 * Extra companies a person works in, besides their own (users.company_id).
 * Each membership carries the person's role and QA-method limits in that
 * company, so someone can be a QA manager in one company and a reviewer in
 * another with one login. Granted by super admins.
 */
export const companyMemberships = pgTable(
  'company_memberships',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'cascade' }),
    roleId: uuid('role_id')
      .notNull()
      .references(() => roles.id),
    allowedFormIds: jsonb('allowed_form_ids').$type<string[] | null>(),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('company_memberships_user_company_uq').on(t.userId, t.companyId),
    index('company_memberships_company_idx').on(t.companyId),
  ],
);

// ---------------------------------------------------------------------------
// Dialer infrastructure
// ---------------------------------------------------------------------------
export const dialerServers = pgTable(
  'dialer_servers',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    // e.g. https://dialer1.example.com — base for /vicidial/non_agent_api.php
    baseUrl: text('base_url').notNull(),
    apiUserEnc: text('api_user_enc'),
    apiPassEnc: text('api_pass_enc'),
    sourceMode: sourceModeEnum('source_mode').notNull().default('api'),
    // optional read-only MySQL access (preferred source for call logs)
    dbHost: text('db_host'),
    dbPort: integer('db_port'),
    dbName: text('db_name'),
    dbUserEnc: text('db_user_enc'),
    dbPassEnc: text('db_pass_enc'),
    // recording webserver base, e.g. https://dialer1.example.com/RECORDINGS/MP3/
    recordingBaseUrl: text('recording_base_url'),
    recordingAuthUserEnc: text('recording_auth_user_enc'),
    recordingAuthPassEnc: text('recording_auth_pass_enc'),
    // VICIdial logs are stored in server-local time; needed to normalize to UTC
    timezone: text('timezone').notNull().default('UTC'),
    // measured from the dialer's own clock on every sync (version API call):
    // minutes east of UTC, clock drift vs platform time, and when checked
    tzOffsetMin: integer('tz_offset_min'),
    clockDriftSec: integer('clock_drift_sec'),
    timeCheckedAt: timestamp('time_checked_at', { withTimezone: true }),
    active: boolean('active').notNull().default(true),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }),
    // set when an admin deletes the dialer: it stops syncing at once and the
    // worker removes its data in batches, then the row itself
    deletingAt: timestamp('deleting_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  // a dialer being deleted frees its name so it can be added again right away
  (t) => [uniqueIndex('dialers_company_name_uq').on(t.companyId, t.name).where(sql`${t.deletingAt} is null`)],
);

export const viciAgents = pgTable(
  'vici_agents',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'cascade' }),
    dialerServerId: uuid('dialer_server_id')
      .notNull()
      .references(() => dialerServers.id, { onDelete: 'cascade' }),
    viciUser: varchar('vici_user', { length: 50 }).notNull(),
    fullName: text('full_name'),
    userGroup: varchar('user_group', { length: 50 }),
    agentRole: agentRoleEnum('agent_role').notNull().default('unknown'),
    active: boolean('active').notNull().default(true),
    raw: jsonb('raw'),
    syncedAt: timestamp('synced_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // Same username can exist on different dialers — uniqueness is per dialer.
    uniqueIndex('vici_agents_dialer_user_uq').on(t.dialerServerId, t.viciUser),
    index('vici_agents_company_idx').on(t.companyId),
  ],
);

export const campaigns = pgTable(
  'campaigns',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'cascade' }),
    dialerServerId: uuid('dialer_server_id')
      .notNull()
      .references(() => dialerServers.id, { onDelete: 'cascade' }),
    viciCampaignId: varchar('vici_campaign_id', { length: 50 }).notNull(),
    name: text('name'),
    active: boolean('active').notNull().default(true),
    raw: jsonb('raw'),
    syncedAt: timestamp('synced_at', { withTimezone: true }),
  },
  (t) => [uniqueIndex('campaigns_dialer_cid_uq').on(t.dialerServerId, t.viciCampaignId)],
);

export const ingroups = pgTable(
  'ingroups',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'cascade' }),
    dialerServerId: uuid('dialer_server_id')
      .notNull()
      .references(() => dialerServers.id, { onDelete: 'cascade' }),
    viciGroupId: varchar('vici_group_id', { length: 50 }).notNull(),
    name: text('name'),
    raw: jsonb('raw'),
    syncedAt: timestamp('synced_at', { withTimezone: true }),
  },
  (t) => [uniqueIndex('ingroups_dialer_gid_uq').on(t.dialerServerId, t.viciGroupId)],
);

// Explicit, validated disposition semantics. A dispo is never treated as a
// sale/transfer because of its name — only via these rows.
export const dispositionMappings = pgTable(
  'disposition_mappings',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'cascade' }),
    // null = applies to all dialers of the company
    dialerServerId: uuid('dialer_server_id').references(() => dialerServers.id, { onDelete: 'cascade' }),
    // null = applies to all campaigns
    campaignId: uuid('campaign_id').references(() => campaigns.id, { onDelete: 'cascade' }),
    dispositionCode: varchar('disposition_code', { length: 50 }).notNull(),
    meaning: dispoMeaningEnum('meaning').notNull(),
    active: boolean('active').notNull().default(true),
    createdBy: uuid('created_by').references(() => users.id),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // NULLS NOT DISTINCT is not portable via drizzle; app layer rejects
    // duplicate scope+code combinations before insert.
    index('dispo_company_idx').on(t.companyId),
    index('dispo_lookup_idx').on(t.companyId, t.dispositionCode, t.active),
  ],
);

// ---------------------------------------------------------------------------
// Calls / transfers / recordings
// ---------------------------------------------------------------------------
export const calls = pgTable(
  'calls',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'cascade' }),
    dialerServerId: uuid('dialer_server_id')
      .notNull()
      .references(() => dialerServers.id, { onDelete: 'cascade' }),
    source: callSourceEnum('source').notNull(),
    viciLeadId: bigint('vici_lead_id', { mode: 'number' }),
    viciUniqueId: varchar('vici_uniqueid', { length: 32 }),
    campaignId: uuid('campaign_id').references(() => campaigns.id),
    ingroupId: uuid('ingroup_id').references(() => ingroups.id),
    viciAgentId: uuid('vici_agent_id').references(() => viciAgents.id),
    // raw agent user as logged — kept even when the agent row is missing
    viciUserRaw: varchar('vici_user_raw', { length: 50 }),
    phoneNumber: varchar('phone_number', { length: 24 }),
    callDate: timestamp('call_date', { withTimezone: true }).notNull(),
    lengthSec: integer('length_sec'),
    status: varchar('status', { length: 20 }),
    termReason: varchar('term_reason', { length: 30 }),
    listId: bigint('list_id', { mode: 'number' }),
    raw: jsonb('raw'),
    isMock: boolean('is_mock').notNull().default(false),
    firstSyncedAt: timestamp('first_synced_at', { withTimezone: true }).notNull().defaultNow(),
    lastSyncedAt: timestamp('last_synced_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // uniqueid is unique per dialer per log table — never globally
    uniqueIndex('calls_dialer_source_uid_uq')
      .on(t.dialerServerId, t.source, t.viciUniqueId)
      .where(sql`${t.viciUniqueId} is not null`),
    index('calls_company_date_idx').on(t.companyId, t.callDate),
    index('calls_dialer_date_idx').on(t.dialerServerId, t.callDate),
    index('calls_phone_idx').on(t.phoneNumber),
    index('calls_lead_idx').on(t.dialerServerId, t.viciLeadId),
    index('calls_status_idx').on(t.status),
    // reviewer agent scopes, agent reports, and deleting an agent/dialer
    // (without it every removed agent scanned the whole calls table)
    index('calls_agent_idx').on(t.viciAgentId),
  ],
);

export const transfers = pgTable(
  'transfers',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'cascade' }),
    dialerServerId: uuid('dialer_server_id')
      .notNull()
      .references(() => dialerServers.id, { onDelete: 'cascade' }),
    // 'transfer' = a fronter XFER. 'callback_sale' / 'inbound_sale' = a sale
    // that reached no fronter transfer (a closer's own callback, or a call
    // that came straight into the closer group) — those have no fronter leg
    // and live only in the Closed queue, so Closed matches the dialer's SALEs.
    kind: transferKindEnum('kind').notNull().default('transfer'),
    fronterCallId: uuid('fronter_call_id').references(() => calls.id, { onDelete: 'cascade' }),
    closerCallId: uuid('closer_call_id').references(() => calls.id, { onDelete: 'set null' }),
    // a sale made on a LATER call of the same lead (closer callback) that
    // closes this transfer when its own closer leg was not the sale
    saleCallId: uuid('sale_call_id').references(() => calls.id, { onDelete: 'set null' }),
    /** the agent's XFER disposition this transfer comes from (DB mode) */
    agentLogId: bigint('agent_log_id', { mode: 'number' }),
    xferTime: timestamp('xfer_time', { withTimezone: true }).notNull(),
    /**
     * when the dialer counts this on its reports (the agent's disposition
     * event); day filters use this so per-day counts match VICIdial exactly.
     * Falls back to xfer_time where unknown.
     */
    countedAt: timestamp('counted_at', { withTimezone: true }),
    phoneNumber: varchar('phone_number', { length: 24 }),
    viciLeadId: bigint('vici_lead_id', { mode: 'number' }),
    closerLeadId: bigint('closer_lead_id', { mode: 'number' }),
    matchStatus: matchStatusEnum('match_status').notNull().default('pending_match'),
    matchConfidence: integer('match_confidence'),
    matchMethod: text('match_method'),
    matchNotes: text('match_notes'),
    queueStatus: queueStatusEnum('queue_status').notNull().default('transfer'),
    saleDisposition: varchar('sale_disposition', { length: 20 }),
    closedAt: timestamp('closed_at', { withTimezone: true }),
    isMock: boolean('is_mock').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // one transfer record per fronter call — duplicate sync runs are idempotent
    uniqueIndex('transfers_fronter_call_uq').on(t.fronterCallId),
    // one sale-only record per sale call
    uniqueIndex('transfers_sale_only_uq')
      .on(t.closerCallId)
      .where(sql`${t.kind} <> 'transfer'`),
    uniqueIndex('transfers_sale_call_uq')
      .on(t.saleCallId)
      .where(sql`${t.saleCallId} is not null`),
    uniqueIndex('transfers_agent_log_uq')
      .on(t.dialerServerId, t.agentLogId)
      .where(sql`${t.agentLogId} is not null`),
    index('transfers_company_queue_idx').on(t.companyId, t.queueStatus, t.xferTime),
    // the Transfers queue lists by kind, newest first
    index('transfers_company_kind_idx').on(t.companyId, t.kind, t.xferTime),
    index('transfers_match_idx').on(t.matchStatus),
    index('transfers_closer_call_idx').on(t.closerCallId),
    index('transfers_lead_idx').on(t.dialerServerId, t.viciLeadId),
  ],
);

/**
 * The disposition each agent actually picked (vicidial_agent_log) — what
 * VICIdial's own Agent Status Detail report counts. The call record's
 * status can disagree or change later, so transfers are built from these.
 * Only rows whose status is a mapped XFER code are kept.
 */
export const agentDispositions = pgTable(
  'agent_dispositions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'cascade' }),
    dialerServerId: uuid('dialer_server_id')
      .notNull()
      .references(() => dialerServers.id, { onDelete: 'cascade' }),
    agentLogId: bigint('agent_log_id', { mode: 'number' }).notNull(),
    viciUser: varchar('vici_user', { length: 50 }),
    eventTime: timestamp('event_time', { withTimezone: true }).notNull(),
    status: varchar('status', { length: 20 }),
    viciLeadId: bigint('vici_lead_id', { mode: 'number' }),
    viciUniqueId: varchar('vici_uniqueid', { length: 32 }),
    viciCampaignId: varchar('vici_campaign_id', { length: 50 }),
    syncedAt: timestamp('synced_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('agent_dispositions_dialer_log_uq').on(t.dialerServerId, t.agentLogId),
    index('agent_dispositions_time_idx').on(t.dialerServerId, t.eventTime),
  ],
);

export const transferEvents = pgTable(
  'transfer_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    transferId: uuid('transfer_id')
      .notNull()
      .references(() => transfers.id, { onDelete: 'cascade' }),
    fromStatus: text('from_status'),
    toStatus: text('to_status').notNull(),
    reason: text('reason'),
    actorUserId: uuid('actor_user_id').references(() => users.id),
    meta: jsonb('meta'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('transfer_events_transfer_idx').on(t.transferId)],
);

export const recordings = pgTable(
  'recordings',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'cascade' }),
    dialerServerId: uuid('dialer_server_id')
      .notNull()
      .references(() => dialerServers.id, { onDelete: 'cascade' }),
    callId: uuid('call_id').references(() => calls.id, { onDelete: 'set null' }),
    viciRecordingId: bigint('vici_recording_id', { mode: 'number' }),
    viciLeadId: bigint('vici_lead_id', { mode: 'number' }),
    filename: text('filename').notNull(),
    locationUrl: text('location_url'),
    startTime: timestamp('start_time', { withTimezone: true }),
    lengthSec: integer('length_sec'),
    status: recordingStatusEnum('status').notNull().default('pending'),
    checkAttempts: integer('check_attempts').notNull().default(0),
    lastCheckedAt: timestamp('last_checked_at', { withTimezone: true }),
    raw: jsonb('raw'),
    isMock: boolean('is_mock').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('recordings_dialer_recid_uq')
      .on(t.dialerServerId, t.viciRecordingId)
      .where(sql`${t.viciRecordingId} is not null`),
    uniqueIndex('recordings_dialer_filename_uq').on(t.dialerServerId, t.filename),
    index('recordings_call_idx').on(t.callId),
    index('recordings_company_time_idx').on(t.companyId, t.startTime),
    index('recordings_lead_idx').on(t.dialerServerId, t.viciLeadId),
  ],
);

// ---------------------------------------------------------------------------
// QA forms & evaluations
// ---------------------------------------------------------------------------
export const qaForms = pgTable(
  'qa_forms',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    description: text('description'),
    target: formTargetEnum('target').notNull().default('any'),
    // the queue this form evaluates (null = any queue); drives which queues
    // a reviewer restricted to this form may see
    queue: queueStatusEnum('queue'),
    campaignId: uuid('campaign_id').references(() => campaigns.id),
    state: formStateEnum('state').notNull().default('draft'),
    currentVersion: integer('current_version').notNull().default(0),
    // mutable draft schema; published versions are frozen in qa_form_versions
    draftSchema: jsonb('draft_schema'),
    createdBy: uuid('created_by').references(() => users.id),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('qa_forms_company_idx').on(t.companyId)],
);

export const qaFormVersions = pgTable(
  'qa_form_versions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    formId: uuid('form_id')
      .notNull()
      .references(() => qaForms.id, { onDelete: 'cascade' }),
    version: integer('version').notNull(),
    // immutable snapshot of sections/questions/weights/critical rules
    schema: jsonb('schema').notNull(),
    maxScore: numeric('max_score', { precision: 8, scale: 2 }).notNull(),
    passThreshold: numeric('pass_threshold', { precision: 5, scale: 2 }).notNull().default('80'),
    publishedAt: timestamp('published_at', { withTimezone: true }).notNull().defaultNow(),
    createdBy: uuid('created_by').references(() => users.id),
  },
  (t) => [uniqueIndex('qa_form_versions_uq').on(t.formId, t.version)],
);

export const evaluations = pgTable(
  'evaluations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'cascade' }),
    transferId: uuid('transfer_id').references(() => transfers.id, { onDelete: 'set null' }),
    callId: uuid('call_id').references(() => calls.id, { onDelete: 'set null' }),
    formVersionId: uuid('form_version_id')
      .notNull()
      .references(() => qaFormVersions.id),
    targetAgentId: uuid('target_agent_id').references(() => viciAgents.id),
    reviewerId: uuid('reviewer_id')
      .notNull()
      .references(() => users.id),
    status: evaluationStatusEnum('status').notNull().default('draft'),
    answers: jsonb('answers').notNull().default({}),
    score: numeric('score', { precision: 8, scale: 2 }),
    maxScore: numeric('max_score', { precision: 8, scale: 2 }),
    percent: numeric('percent', { precision: 5, scale: 2 }),
    passed: boolean('passed'),
    autoFailed: boolean('auto_failed').notNull().default(false),
    comments: text('comments'),
    coachingNotes: text('coaching_notes'),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('evaluations_company_idx').on(t.companyId, t.status),
    index('evaluations_transfer_idx').on(t.transferId),
    index('evaluations_agent_idx').on(t.targetAgentId),
    index('evaluations_call_idx').on(t.callId),
  ],
);

/**
 * Which dialer agents a reviewer covers, and with which methods. A reviewer
 * with any rows here only sees transfers whose evaluated leg belongs to one
 * of their agents: the fronter leg for 'transfer', the closer leg for
 * 'unclosed' and 'closed'.
 */
export const reviewerAgentAssignments = pgTable(
  'reviewer_agent_assignments',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'cascade' }),
    reviewerUserId: uuid('reviewer_user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    viciAgentId: uuid('vici_agent_id')
      .notNull()
      .references(() => viciAgents.id, { onDelete: 'cascade' }),
    methods: jsonb('methods').$type<Array<'transfer' | 'unclosed' | 'closed'>>().notNull().default([]),
    createdBy: uuid('created_by').references(() => users.id),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('reviewer_agent_uq').on(t.reviewerUserId, t.viciAgentId),
    index('reviewer_agent_reviewer_idx').on(t.reviewerUserId),
  ],
);

export const qaAssignments = pgTable(
  'qa_assignments',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'cascade' }),
    transferId: uuid('transfer_id')
      .notNull()
      .references(() => transfers.id, { onDelete: 'cascade' }),
    assignedTo: uuid('assigned_to')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    assignedBy: uuid('assigned_by').references(() => users.id),
    dueAt: timestamp('due_at', { withTimezone: true }),
    status: assignmentStatusEnum('status').notNull().default('open'),
    /** the dialer-local day the assigned calls happened on */
    taskDate: date('task_date'),
    /** the method the reviewer applies to this call */
    queue: queueStatusEnum('queue'),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // one task per call, reviewer and method: the same XFER can be a Transfer
    // task (fronter review) and an Unclosed/Closed task (closer review)
    uniqueIndex('qa_assignments_transfer_user_queue_uq').on(t.transferId, t.assignedTo, t.queue),
    index('qa_assignments_assignee_idx').on(t.assignedTo, t.status),
    index('qa_assignments_company_date_idx').on(t.companyId, t.taskDate),
  ],
);

// ---------------------------------------------------------------------------
// Operations: audit, sync
// ---------------------------------------------------------------------------
export const auditLogs = pgTable(
  'audit_logs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    companyId: uuid('company_id').references(() => companies.id, { onDelete: 'set null' }),
    userId: uuid('user_id').references(() => users.id, { onDelete: 'set null' }),
    action: varchar('action', { length: 100 }).notNull(),
    entityType: varchar('entity_type', { length: 50 }),
    entityId: text('entity_id'),
    before: jsonb('before'),
    after: jsonb('after'),
    ip: text('ip'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('audit_company_time_idx').on(t.companyId, t.createdAt),
    index('audit_entity_idx').on(t.entityType, t.entityId),
  ],
);

export const syncJobs = pgTable(
  'sync_jobs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    dialerServerId: uuid('dialer_server_id')
      .notNull()
      .references(() => dialerServers.id, { onDelete: 'cascade' }),
    jobType: varchar('job_type', { length: 50 }).notNull(),
    status: syncJobStatusEnum('status').notNull().default('queued'),
    windowStart: timestamp('window_start', { withTimezone: true }),
    windowEnd: timestamp('window_end', { withTimezone: true }),
    stats: jsonb('stats'),
    /** live progress while running: stage, percent, detail, ETA (see SyncProgress in sync.ts) */
    progress: jsonb('progress'),
    error: text('error'),
    startedAt: timestamp('started_at', { withTimezone: true }),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('sync_jobs_dialer_idx').on(t.dialerServerId, t.createdAt)],
);

export const syncCursors = pgTable(
  'sync_cursors',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    dialerServerId: uuid('dialer_server_id')
      .notNull()
      .references(() => dialerServers.id, { onDelete: 'cascade' }),
    stream: varchar('stream', { length: 50 }).notNull(),
    lastTimestamp: timestamp('last_timestamp', { withTimezone: true }),
    lastId: bigint('last_id', { mode: 'number' }),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('sync_cursors_uq').on(t.dialerServerId, t.stream)],
);
