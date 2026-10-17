export interface AuthUser {
  userId: string;
  email: string;
  name: string;
  companyId: string | null;
  roleName: string;
  permissions: string[];
  allowedFormIds: string[] | null;
  /** null = every queue; otherwise only these queues are shown */
  allowedQueues: Array<'transfer' | 'unclosed' | 'closed'> | null;
  /** IANA zone of the company's dialer — every date filter is a day on this clock */
  dialerTimezone: string;
}

export interface Company {
  id: string;
  name: string;
  slug: string;
  status: string;
  createdAt: string;
}

export interface Dialer {
  id: string;
  companyId: string;
  name: string;
  baseUrl: string;
  sourceMode: 'api' | 'db' | 'hybrid';
  timezone: string;
  active: boolean;
  lastSeenAt: string | null;
  hasApiCredentials: boolean;
  hasDbCredentials: boolean;
  hasRecordingAuth: boolean;
}

export interface Agent {
  id: string;
  companyId: string;
  dialerServerId: string;
  dialerName?: string;
  viciUser: string;
  fullName: string | null;
  userGroup: string | null;
  agentRole: 'fronter' | 'closer' | 'blended' | 'unknown';
  active: boolean;
}

export interface Campaign {
  id: string;
  dialerServerId: string;
  viciCampaignId: string;
  name: string | null;
  dialerName?: string;
}

export interface DispoMapping {
  id: string;
  companyId: string;
  dialerServerId: string | null;
  campaignId: string | null;
  dispositionCode: string;
  meaning: 'transfer' | 'sale' | 'no_sale' | 'callback' | 'dnc' | 'other';
  active: boolean;
}

export interface Call {
  /** VICIdial term_reason: CALLER = customer hung up, AGENT = agent hung up */
  termReason: string | null;
  id: string;
  dialerServerId: string;
  source: string;
  viciLeadId: number | null;
  viciUniqueId: string | null;
  phoneNumber: string | null;
  callDate: string;
  lengthSec: number | null;
  status: string | null;
  viciUserRaw: string | null;
}

export interface Transfer {
  id: string;
  companyId: string;
  dialerServerId: string;
  /** transfer = fronter XFER; the sale kinds have no fronter leg */
  kind: 'transfer' | 'callback_sale' | 'inbound_sale';
  fronterCallId: string | null;
  closerCallId: string | null;
  /** a sale on a later call of the lead that closed this transfer */
  saleCallId: string | null;
  xferTime: string;
  phoneNumber: string | null;
  viciLeadId: number | null;
  matchStatus: 'pending_match' | 'matched' | 'flagged' | 'unmatched';
  matchConfidence: number | null;
  matchNotes: string | null;
  queueStatus: 'transfer' | 'unclosed' | 'closed';
  saleDisposition: string | null;
  closedAt: string | null;
  isMock: boolean;
}

export interface QueueItem {
  transfer: Transfer;
  fronterCall: Call | null;
  fronterAgentUser: string | null;
  fronterAgentName: string | null;
  closerCallDate: string | null;
  closerStatus: string | null;
  closerLength: number | null;
  closerAgentUser: string | null;
  closerAgentName: string | null;
  dialerName: string;
  campaignName: string | null;
  viciCampaignId: string | null;
}

export interface Recording {
  id: string;
  callId: string | null;
  filename: string;
  startTime: string | null;
  lengthSec: number | null;
  status: 'pending' | 'available' | 'missing' | 'error';
  isMock: boolean;
}

export interface TransferEvent {
  id: string;
  fromStatus: string | null;
  toStatus: string;
  reason: string | null;
  createdAt: string;
}

export interface QaForm {
  id: string;
  companyId: string;
  name: string;
  description: string | null;
  target: 'fronter' | 'closer' | 'any';
  queue: 'transfer' | 'unclosed' | 'closed' | null;
  state: 'draft' | 'published' | 'archived';
  currentVersion: number;
  draftSchema: FormDefinition | null;
  updatedAt: string;
}

export interface FormQuestion {
  id: string;
  text: string;
  type: 'yes_no' | 'pass_fail' | 'rating' | 'dropdown' | 'text' | 'number';
  weight: number;
  required: boolean;
  critical: boolean;
  scaleMax?: number;
  options?: { value: string; label: string; scorePct: number; autoFail: boolean }[];
  visibleIf?: { questionId: string; equals: string | number | boolean };
  helpText?: string;
}

export interface FormSection {
  id: string;
  title: string;
  description?: string;
  questions: FormQuestion[];
}

export interface FormDefinition {
  sections: FormSection[];
}

export interface Evaluation {
  id: string;
  transferId: string | null;
  status: 'draft' | 'completed';
  answers: Record<string, string | number | boolean | null>;
  score: string | null;
  maxScore: string | null;
  percent: string | null;
  passed: boolean | null;
  autoFailed: boolean;
  comments: string | null;
  coachingNotes: string | null;
  completedAt: string | null;
  createdAt: string;
}

export interface PageMeta {
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
}

/** live progress of a running sync (sync_jobs.progress) */
export interface SyncProgress {
  stage: string;
  label: string;
  percent: number;
  detail: string | null;
  etaSeconds: number | null;
  startedAt: string;
  updatedAt: string;
}

export interface SyncJob {
  id: string;
  dialerServerId: string;
  jobType: string;
  status: 'queued' | 'running' | 'success' | 'failed';
  stats: Record<string, unknown> | null;
  progress: SyncProgress | null;
  error: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  createdAt: string;
}

export interface DashboardStats {
  dateFrom: string;
  dateTo: string;
  timezone: string;
  totals: {
    transfers: number;
    closedFromTransfers: number;
    callbackSales: number;
    inboundSales: number;
    transfer: number;
    unclosed: number;
    closed: number;
    closeRate: number;
    flaggedMatches: number;
    missingRecordings: number;
    evaluationsCompleted: number;
    avgQaScore: number | null;
  };
  trend: { day: string; total: number; closed: number }[];
}
