import { and, desc, eq, gte, inArray, lte, or, sql } from 'drizzle-orm';
import { config } from '../config.js';
import { db } from '../db/client.js';
import { calls, dispositionMappings, recordings, transfers, viciAgents } from '../db/schema.js';
import { isFinalMp3, refreshRecording, type RecordingRow } from '../vicidial/recordingUrl.js';
import { lookupLeadRecordings } from '../vicidial/sync.js';
import type { DialerConnection } from '../vicidial/types.js';

type CallRow = typeof calls.$inferSelect;
type TransferRow = typeof transfers.$inferSelect;

export type Leg = 'fronter' | 'closer' | 'sale';

export interface LegCall {
  call: CallRow;
  agentUser: string | null;
  agentName: string | null;
}

/** VICIdial fills length and final status at hangup; until then the call is up. */
export function isCallInProgress(call: Pick<CallRow, 'lengthSec' | 'status'> | null | undefined): boolean {
  if (!call) return false;
  return call.lengthSec == null || /^(INCALL|QUEUE)$/i.test(call.status ?? '');
}

export function callEndedAt(call: Pick<CallRow, 'callDate' | 'lengthSec'>): Date {
  return new Date(call.callDate.getTime() + (call.lengthSec ?? 0) * 1000);
}

/**
 * Sales with no transfer row of their own (callback / inbound) and transfers
 * whose call row has not landed yet still get a fronter: the latest XFER call
 * on the lead up to 3 days before.
 */
export async function findFronterOnLead(transfer: TransferRow, leadId: number): Promise<LegCall | null> {
  const codes = (
    await db
      .select({ code: dispositionMappings.dispositionCode })
      .from(dispositionMappings)
      .where(
        and(
          eq(dispositionMappings.companyId, transfer.companyId),
          eq(dispositionMappings.meaning, 'transfer'),
          eq(dispositionMappings.active, true),
        ),
      )
  ).map((m) => m.code.toUpperCase());
  if (codes.length === 0) return null;
  const ref = transfer.xferTime;
  const [f] = await db
    .select({ call: calls, agentUser: viciAgents.viciUser, agentName: viciAgents.fullName })
    .from(calls)
    .leftJoin(viciAgents, eq(calls.viciAgentId, viciAgents.id))
    .where(
      and(
        eq(calls.dialerServerId, transfer.dialerServerId),
        eq(calls.source, 'vicidial_log'),
        eq(calls.viciLeadId, leadId),
        sql`upper(coalesce(${calls.status}, '')) in (${sql.join(codes.map((c) => sql`${c}`), sql`, `)})`,
        gte(calls.callDate, new Date(ref.getTime() - 3 * 86_400_000)),
        lte(calls.callDate, new Date(ref.getTime() + 30 * 60_000)),
      ),
    )
    // the real conversation, not a 0-second dispo row
    .orderBy(sql`(coalesce(${calls.lengthSec}, 0) > 0) desc`, desc(calls.callDate))
    .limit(1);
  return f ? { call: f.call, agentUser: f.agentUser ?? f.call.viciUserRaw, agentName: f.agentName } : null;
}

export interface RecordingItem {
  id: string;
  callId: string | null;
  filename: string;
  status: string;
  lengthSec: number | null;
  startTime: Date | null;
  /** verified on the dialer's final MP3 (a .wav is the live, partial file) */
  final: boolean;
  /** 'other' = another call on the same lead (callback, earlier attempt) */
  leg: Leg | 'other';
  callStatus: string | null;
  callSource: string | null;
  callUser: string | null;
  agentName: string | null;
  termReason: string | null;
}

export interface LegState {
  callId: string;
  status: string | null;
  lengthSec: number | null;
  termReason: string | null;
  inProgress: boolean;
  endedAt: Date | null;
}

export interface RecordingBundle {
  items: RecordingItem[];
  legs: Partial<Record<Leg, LegState>>;
  /** true while something here can still change within minutes — the page keeps polling */
  live: boolean;
  checkedAt: Date;
}

const leadLookupAt = new Map<string, number>();
const LEAD_LOOKUP_EVERY_MS = 30_000;
const REFRESH_CAP_MS = 2_500;
const sleep = (ms: number) => new Promise<'timeout'>((r) => setTimeout(() => r('timeout'), Math.max(0, ms)));

/**
 * Every recording that belongs on a call page: the legs' own plus the rest of
 * the lead's around the transfer, newest first. With `refresh` the legs are
 * checked against the dialer right now — a leg with no recording row yet
 * triggers a lead lookup (throttled per lead), unverified files are probed —
 * capped at 2.5 s so the page never waits long; whatever does not finish in
 * time still completes in the background and lands on the next poll.
 */
export async function recordingBundle(
  transfer: TransferRow,
  legCalls: Partial<Record<Leg, CallRow | null | undefined>>,
  opts: { refresh?: boolean; conn?: DialerConnection | null } = {},
): Promise<RecordingBundle> {
  const now = Date.now();
  const legs: Partial<Record<Leg, LegState>> = {};
  const legOfCall = new Map<string, Leg>();
  for (const leg of ['fronter', 'closer', 'sale'] as const) {
    const c = legCalls[leg];
    if (!c) continue;
    const inProgress = isCallInProgress(c);
    legs[leg] = {
      callId: c.id,
      status: c.status,
      lengthSec: c.lengthSec,
      termReason: c.termReason,
      inProgress,
      endedAt: inProgress ? null : callEndedAt(c),
    };
    legOfCall.set(c.id, leg);
  }
  const callIds = [...legOfCall.keys()];
  const leadId = transfer.viciLeadId ?? legCalls.fronter?.viciLeadId ?? legCalls.closer?.viciLeadId ?? null;
  const ref = transfer.xferTime;

  const scope = [
    callIds.length ? inArray(recordings.callId, callIds) : null,
    leadId != null
      ? and(
          eq(recordings.dialerServerId, transfer.dialerServerId),
          eq(recordings.viciLeadId, leadId),
          gte(recordings.startTime, new Date(ref.getTime() - 3 * 86_400_000)),
          lte(recordings.startTime, new Date(ref.getTime() + 86_400_000)),
        )
      : null,
  ].filter((x): x is NonNullable<typeof x> => !!x);

  const load = () =>
    scope.length === 0
      ? Promise.resolve([])
      : db
          .select({
            rec: recordings,
            callStatus: calls.status,
            callSource: calls.source,
            callUser: calls.viciUserRaw,
            termReason: calls.termReason,
            agentName: viciAgents.fullName,
          })
          .from(recordings)
          .leftJoin(calls, eq(recordings.callId, calls.id))
          .leftJoin(viciAgents, eq(calls.viciAgentId, viciAgents.id))
          .where(and(eq(recordings.isMock, false), or(...scope)))
          .orderBy(sql`${recordings.startTime} desc nulls last`)
          .limit(60);
  let rows = await load();

  if (opts.refresh && opts.conn) {
    const conn = opts.conn;
    const deadline = now + REFRESH_CAP_MS;

    // a leg with no recording row yet: ask the dialer for the lead now
    // instead of waiting for the next sync cycle
    const rowless = callIds.filter((cid) => !rows.some((r) => r.rec.callId === cid));
    if (rowless.length > 0 && leadId != null && conn.apiUser) {
      const key = `${conn.id}:${leadId}`;
      if ((leadLookupAt.get(key) ?? 0) < now - LEAD_LOOKUP_EVERY_MS) {
        leadLookupAt.set(key, now);
        const lookback = new Date(now - (config.RETENTION_DAYS > 0 ? config.RETENTION_DAYS : 7) * 86_400_000);
        const lookup = lookupLeadRecordings(conn, leadId, lookback).then(
          () => 'done' as const,
          () => 'done' as const,
        );
        if ((await Promise.race([lookup, sleep(deadline - Date.now())])) === 'done') rows = await load();
      }
    }

    // leg recordings not yet verified on their final file: probe them now
    const unverified = rows.filter((r) => {
      const leg = r.rec.callId ? legOfCall.get(r.rec.callId) : undefined;
      if (!leg) return false;
      const rec = r.rec;
      const verified = rec.status === 'available' && !!rec.locationUrl && isFinalMp3(rec.locationUrl);
      const checkedJustNow = (rec.lastCheckedAt?.getTime() ?? 0) > now - 15_000;
      const young = (rec.startTime ?? rec.createdAt).getTime() > now - 48 * 3600_000;
      return !verified && !checkedJustNow && young;
    });
    if (unverified.length > 0) {
      const fresh = new Map<string, RecordingRow>();
      const probes = unverified.slice(0, 6).map((r) =>
        refreshRecording(r.rec, conn, { inProgress: legs[legOfCall.get(r.rec.callId!)!]?.inProgress })
          .then((u) => {
            fresh.set(u.id, u);
          })
          .catch(() => undefined),
      );
      await Promise.race([Promise.all(probes), sleep(deadline - Date.now())]);
      rows = rows.map((r) => (fresh.has(r.rec.id) ? { ...r, rec: fresh.get(r.rec.id)! } : r));
    }
  }

  const items: RecordingItem[] = rows.map((r) => ({
    id: r.rec.id,
    callId: r.rec.callId,
    filename: r.rec.filename,
    status: r.rec.status,
    lengthSec: r.rec.lengthSec,
    startTime: r.rec.startTime,
    final: r.rec.status === 'available' && !!r.rec.locationUrl && isFinalMp3(r.rec.locationUrl),
    leg: (r.rec.callId && legOfCall.get(r.rec.callId)) || 'other',
    callStatus: r.callStatus,
    callSource: r.callSource,
    callUser: r.callUser,
    agentName: r.agentName,
    termReason: r.termReason,
  }));

  const playable = (leg: Leg) => items.some((i) => i.leg === leg && i.status === 'available');
  const legList = Object.entries(legs) as Array<[Leg, LegState]>;
  const live =
    legList.some(([, l]) => l.inProgress) ||
    legList.some(([leg, l]) => l.endedAt != null && now - l.endedAt.getTime() < 45 * 60_000 && !playable(leg)) ||
    items.some((i) => i.leg !== 'other' && !i.final && (i.startTime?.getTime() ?? now) > now - 6 * 3600_000) ||
    (!legs.closer && transfer.matchStatus === 'pending_match' && now - ref.getTime() < 2 * 3600_000);

  return { items, legs, live, checkedAt: new Date() };
}

/** The shapes the call detail page carried before the live endpoint existed. */
export function toRecordingRows(bundle: RecordingBundle) {
  const row = (i: RecordingItem) => ({
    id: i.id,
    callId: i.callId,
    filename: i.filename,
    startTime: i.startTime,
    lengthSec: i.lengthSec,
    status: i.status,
    isMock: false,
  });
  return {
    recordings: bundle.items.filter((i) => i.leg !== 'other').map(row),
    leadRecordings: bundle.items
      .filter((i) => i.leg === 'other')
      .map((i) => ({
        recording: row(i),
        callStatus: i.callStatus,
        callSource: i.callSource,
        callUser: i.callUser,
        agentName: i.agentName,
      })),
    recordingItems: bundle.items,
  };
}
