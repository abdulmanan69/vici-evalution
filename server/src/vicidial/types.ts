/** Rows as read from VICIdial sources, before normalization to UTC. */

export interface ViciCallRow {
  uniqueid: string | null;
  lead_id: number | null;
  list_id: number | null;
  /** outbound: campaign; closer log: in-group id (VICIdial reuses the column name) */
  campaign_id: string | null;
  call_date: string; // 'YYYY-MM-DD HH:MM:SS' in dialer-local time
  length_in_sec: number | null;
  status: string | null;
  phone_number: string | null;
  user: string | null;
  term_reason: string | null;
}

export interface ViciRecordingRow {
  recording_id: number;
  start_time: string | null;
  length_in_sec: number | null;
  filename: string | null;
  location: string | null;
  lead_id: number | null;
  user: string | null;
  /** uniqueid of the call leg this recording belongs to (recording_log.vicidial_id) */
  vicidial_id: string | null;
}

export interface ViciUserRow {
  user: string;
  full_name: string | null;
  user_group: string | null;
  user_level: number | null;
  active: string | null; // 'Y' | 'N'
}

export interface ViciCampaignRow {
  campaign_id: string;
  campaign_name: string | null;
  active: string | null;
}

export interface ViciIngroupRow {
  group_id: string;
  group_name: string | null;
  active: string | null;
}

export interface DialerConnection {
  id: string;
  companyId: string;
  name: string;
  baseUrl: string;
  timezone: string;
  sourceMode: 'api' | 'db' | 'hybrid';
  apiUser?: string;
  apiPass?: string;
  db?: {
    host: string;
    port: number;
    database: string;
    user: string;
    password: string;
  };
  recordingBaseUrl?: string;
  recordingAuth?: { user: string; pass: string };
}
