import type { dialerServers } from '../db/schema.js';
import { decryptSecret } from '../lib/crypto.js';
import type { DialerConnection } from './types.js';

type DialerRow = typeof dialerServers.$inferSelect;

/** Decrypts a dialer row's stored credentials into a usable connection spec. */
export function toConnection(row: DialerRow): DialerConnection {
  const conn: DialerConnection = {
    id: row.id,
    companyId: row.companyId,
    name: row.name,
    baseUrl: row.baseUrl.replace(/\/+$/, ''),
    timezone: row.timezone,
    sourceMode: row.sourceMode,
  };
  if (row.apiUserEnc && row.apiPassEnc) {
    conn.apiUser = decryptSecret(row.apiUserEnc);
    conn.apiPass = decryptSecret(row.apiPassEnc);
  }
  if (row.dbHost && row.dbName && row.dbUserEnc && row.dbPassEnc) {
    conn.db = {
      host: row.dbHost,
      port: row.dbPort ?? 3306,
      database: row.dbName,
      user: decryptSecret(row.dbUserEnc),
      password: decryptSecret(row.dbPassEnc),
    };
  }
  if (row.recordingBaseUrl) {
    conn.recordingBaseUrl = row.recordingBaseUrl.replace(/\/+$/, '');
  }
  if (row.recordingAuthUserEnc && row.recordingAuthPassEnc) {
    conn.recordingAuth = {
      user: decryptSecret(row.recordingAuthUserEnc),
      pass: decryptSecret(row.recordingAuthPassEnc),
    };
  }
  return conn;
}
