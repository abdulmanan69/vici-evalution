# VICIdial integration

How this platform reads data from VICIdial, what each source can and cannot
provide, and how calls, transfers and recordings are linked. Written for the
engineer connecting real dialer servers.

## Two data sources per dialer

Each dialer server row stores credentials for up to two sources and a
`source_mode` that picks the strategy:

| Mode | Call logs | Recordings | When to use |
|---|---|---|---|
| `db` | read-only MySQL | `recording_log` (MySQL) | you can grant SELECT on the asterisk DB (recommended) |
| `hybrid` | read-only MySQL | MySQL + `recording_lookup` API fallback | default |
| `api` | **not available** | `recording_lookup` only | no DB access at all — limited |

### Why the API alone is not enough — a documented limitation

The VICIdial **Non-Agent API** (`/vicidial/non_agent_api.php`) has no function
that exports the outbound call log (`vicidial_log`) or the closer log
(`vicidial_closer_log`). It is used here for:

- `version` — connectivity/credential checks (admin "Test connection"),
- `recording_lookup` — recording metadata per lead or agent+date. Responses are
  parsed by the header row the server itself returns (`header=YES`), not by
  hard-coded column positions, because layouts differ between VICIdial builds.

Everything else requires the **read-only MySQL** source. Grant a dedicated
MySQL user SELECT-only access; the adapter (`server/src/vicidial/dbClient.ts`)
only ever issues SELECTs. Tables read:

| Table | Used for |
|---|---|
| `vicidial_log` | outbound (fronter) call legs |
| `vicidial_closer_log` | inbound/closer call legs (its `campaign_id` column holds the in-group) |
| `recording_log` | recording metadata; `vicidial_id` = the recorded leg's `uniqueid` |
| `vicidial_users` | agent roster |
| `vicidial_campaigns` | campaigns |
| `vicidial_inbound_groups` | closer in-groups |

**Verify against your build before first production sync.** The column lists in
`dbClient.ts` match stock VICIdial; if your cluster has custom schemas, the
sync job will fail with an explicit SQL error visible in the Sync monitor (no
silent bad data).

## Timezones

VICIdial stores timestamps in the **dialer server's local time**. Every dialer
row carries an IANA timezone; the sync converts to UTC on import
(`timezone.ts`, DST-safe, unit-tested) and converts back when building MySQL
`WHERE` bounds. A wrong timezone shifts every call and breaks transfer
matching — set it correctly in the dialer form.

## Identity rules (why there is no single key)

- `uniqueid` is unique **per dialer, per log table** — never globally. Call
  rows are deduplicated by `(dialer_server_id, source, uniqueid)`.
- `lead_id` is only meaningful **within one dialer**. The same customer has
  different lead ids on different dialers, and different customers can share a
  lead id across dialers.
- Agent usernames can repeat across dialers; agents are keyed by
  `(dialer_server_id, vici_user)`.

## Transfer detection and call linking

1. **Detection** — a fronter call becomes a transfer when its disposition is
   explicitly mapped to `transfer` in Disposition mappings (default: `XFER`).
   No mapping ⇒ no transfers, and the sync job notes it.
2. **Matching** — each transfer is scored against closer-log calls from **all**
   of the company's dialers inside a window (−2 min … +10 min around the end of
   the fronter leg):
   - same-dialer `lead_id` match **+40** (mismatch on the same dialer −20),
   - phone match on the last 10 digits **+40**,
   - start-time proximity **+10…+30**.
3. **Decision** (thresholds configurable via env):
   - ≥ `MATCH_AUTO_THRESHOLD` (70) and unambiguous → **matched**,
   - two candidates within 10 points, or a mid score → **flagged** for a human
     (the call detail page shows scored candidates with one-click linking),
   - below `MATCH_FLAG_THRESHOLD` (40) → **unmatched** after a 2-hour grace
     period (closer legs and dispositions can arrive late).

A call is **never silently linked** on a weak signal — that is the flagged
queue's job. Manual resolutions are audit-logged with the actor.

## Queue state machine

```
transfer ──(closer leg matched)──▶ unclosed ──(dispo mapped to sale)──▶ closed
                                      ▲                                   │
                                      └─────(disposition corrected)───────┘
```

Dispositions re-sync on every pass (`ON CONFLICT … UPDATE`), so late or
corrected dispositions move calls between queues; every change writes a
`transfer_events` row, including sale regressions.

## Recordings

- DB mode: `recording_log` rows are linked to calls via `vicidial_id =
  calls.uniqueid` (exact), else kept unlinked and counted in sync stats.
- API mode: `recording_lookup` per lead for recent calls missing recordings.
- Playback is **proxy-only**: the browser hits
  `/api/v1/recordings/:id/stream`, the server checks the session, permission
  and company, writes an audit row, and streams from the dialer (Range
  passthrough for seeking). Recording URLs are never exposed to clients.
- Missing files: the worker HEAD-checks recordings, marks them `missing` after
  repeated failures, and retries later (recordings often appear minutes after
  the call; mixing/transfer to the archive server can lag).

## Sync reliability

- **Cursors** per `(dialer, stream)` with a 2-minute overlap re-read; restarts
  and downtime resume where they left off (recovery = just run again).
- **Idempotent** upserts everywhere; one transfer row per fronter call.
- **Dedup at the queue level**: BullMQ job id `sync:<dialerId>` means a dialer
  is never synced concurrently; manual triggers coalesce with scheduled runs.
- **Retries**: 3 attempts, exponential backoff; failures land in `sync_jobs`
  with the error text (Sync monitor shows them).
- **Historical import**: trigger "Full sync" (imports `SYNC_HISTORICAL_DAYS`,
  default 30; raise it for a deeper backfill).

## Known limitations / assumptions (deliberately explicit)

1. API-only mode cannot import call logs — documented above; use `db`/`hybrid`.
2. `vicidial_xfer_log` is not read; transfer detection relies on dispositions
   plus closer-log matching. If your workflow needs xfer-log timestamps, add a
   fetch in `dbClient.ts` after verifying that table's columns on your build.
3. Calls lacking a `uniqueid` are skipped and counted in sync stats
   (`*_skipped_no_uniqueid`) rather than guessed at.
4. Multi-hop transfers (fronter → closer → second closer) appear as separate
   closer-log candidates; the ambiguity rule flags them for a human.
5. Recording column layouts from `recording_lookup` vary by build; parsing is
   header-driven, and unknown layouts surface as unmatched fields in `raw`
   (kept verbatim for diagnosis).
