# VICIdial integration

How this platform reads data from VICIdial, what each source can and cannot
provide, and how calls, transfers and recordings are linked. Written for the
engineer connecting real dialer servers.

## Two data sources per dialer

Each dialer server row stores credentials for up to two sources and a
`source_mode` that picks the strategy:

| Mode | Call logs | Recordings | When to use |
|---|---|---|---|
| `db` | read-only MySQL | `recording_log` (MySQL) | you can grant SELECT on the asterisk DB (most accurate) |
| `hybrid` | read-only MySQL | MySQL + `recording_lookup` API fallback | default |
| `api` | **synthesized** from recordings + lead status (see below) | `recording_lookup` | API credentials only, no DB access |

### API-only mode (no MySQL access)

The VICIdial **Non-Agent API** (`/vicidial/non_agent_api.php`) has no function
that exports the outbound call log (`vicidial_log`) or the closer log
(`vicidial_closer_log`). When only API credentials exist, the sync therefore
**synthesizes** call records from what the API does expose (shapes verified
live against a 2.14-189 build):

1. **Roster** — `campaigns_list` (no header row; `id|name|active|…`),
   `agent_stats_export` and `logged_in_agents` (both honor `header=YES`)
   build the campaign and agent lists.
2. **Calls** — `recording_lookup` per agent per dialer-local day: every
   recording becomes one call leg (`uniqueid = rec-<recording_id>`, stable and
   idempotent). Note: with `duration=Y` this build returns one more data cell
   than the header advertises (seconds inserted before the URL); the parser
   repairs that shift (`fixRecordingRow`, unit-tested).
3. **Disposition & phone** — `lead_all_info` per lead supplies `status` (the
   lead's **latest** disposition) and `phone_number` (fallback: the number
   embedded in the recording filename). Lookups are cached and capped per
   cycle; missing statuses backfill on later cycles.
4. **Fronter vs closer leg** — the admin's agent classification (Agents page)
   wins; unclassified agents fall back to time order per lead (first agent on
   the lead = fronter, later different agents = closer legs).
5. **Transfer detection** — on one server the closer's final disposition
   overwrites the lead status, so the fronter leg of a sold call no longer
   shows `XFER`. Transfers are therefore detected **structurally**: a
   fronter leg whose lead has a closer leg starting within 2 hours is created
   as a transfer and linked directly (`matchMethod=structural-lead`,
   confidence 85). Mapping-based detection (`XFER → Transfer`) still runs for
   leads that never reached a closer disposition.

**Accuracy trade-offs of API mode** (inherent, documented):
- per-call dispositions are approximated by the lead's latest status;
- calls without recordings are invisible (no recording ⇒ no row);
- campaign attribution per call is unavailable.
If you ever get read-only MySQL access, switch the dialer to `hybrid` — the
synthesized rows are superseded by exact log rows without duplication.

### Read-only MySQL source (db/hybrid modes)

Grant a dedicated MySQL user SELECT-only access; the adapter
(`server/src/vicidial/dbClient.ts`) only ever issues SELECTs. Tables read:

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

1. API-only mode synthesizes calls from recordings and lead status — see the
   accuracy trade-offs above; `db`/`hybrid` remain the exact sources.
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
