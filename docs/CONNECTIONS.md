# Connections

How other apps (CRM, HRMS, reporting tools, scripts) read data from the VICIdial QA platform and get told when something happens.

- **Pull:** a read-only machine API at `/api/v1/ext/…`, authenticated with an API key.
- **Push:** signed webhooks for new evaluations and for sales that close or reopen.

Both are managed in **Admin → Connections**. That page needs the *Users & roles* permission (`admin.users`): company admins manage their own company's keys and webhooks, and super admins manage any company's, plus all-company ones. The page also shows the **outgoing links**: the hourly pushes to the HRMS and the CRM, and the result of each job's last run.

Server code: `server/src/integrations/connections/`.

## API keys

A key looks like `qa_` followed by 43 characters (`qa_` + 32 random bytes, base64url). It is shown once, when it is made. Only its SHA-256 is stored, so a lost key cannot be recovered: revoke it and make a new one.

Send it as a Bearer token:

```bash
curl -H "Authorization: Bearer qa_…" https://qa.example.com/api/v1/ext/me
```

Each key:

- **belongs to one company**, and only sees that company's data. Super admins can make an *all companies* key, which sees every active company. Add `?company=<slug>` to narrow it to one company.
- **has scopes**, and each endpoint needs one of them:

| Scope | Gives |
|---|---|
| `agents.read` | `GET /agents` |
| `transfers.read` | `GET /transfers`, without phone numbers |
| `transfers.read_pii` | adds the customer `phone` to transfers. It includes `transfers.read` |
| `evaluations.read` | `GET /evaluations` |
| `scores.read` | `GET /scores` |
| `calls.read` | `GET /activity` |

Revoking a key takes effect within 10 seconds. `last_used_at` is updated at most once a minute. Each key may make 600 requests per minute.

Errors are JSON `{ "error": "<code>", "message": "…" }`:

| Status | When |
|---|---|
| `401` | no key, a malformed key, or a key that is unknown or revoked |
| `403` | the key lacks the scope, or `?company=` names another company |
| `400` | a bad parameter or cursor |
| `429` | the rate limit was exceeded |

## Endpoints

All endpoints are `GET` requests. Lists are ordered and **cursor-paginated**. Pass `limit` (1 to 1000, default 100). While the answer's `next` is not `null`, pass it back as `?cursor=` to get the next page. Times are ISO 8601 in UTC. For `from` and `to`, a plain `YYYY-MM-DD` means that UTC day, and `to` includes the whole day.

### `GET /api/v1/ext/me`

```json
{ "key": { "name": "CRM", "prefix": "qa_3fK9a1Bz", "company": "wavetech-infomatics", "scopes": ["agents.read", "scores.read"] } }
```

### `GET /api/v1/ext/agents` (`agents.read`)

Parameters: `company`, `active=true|false`, `limit`, `cursor`.

```json
{ "data": [ { "id": "…", "vici_user": "agent1043", "full_name": "Ali Khan", "user_group": "FRONTERS", "agent_role": "fronter", "active": true, "dialer": "D1", "company": "wavetech-infomatics" } ], "next": null }
```

### `GET /api/v1/ext/transfers` (`transfers.read`)

These are the Transfer, Unclosed and Closed queues. The list is ordered by last change (`updated_at`, then `id`), so `updated_since` together with the cursor gives an incremental sync.

Parameters: `company`, `status=transfer|unclosed|closed`, `from` and `to` (on `xfer_time`), `updated_since`, `limit`, `cursor`.

```json
{
  "data": [
    {
      "id": "fd236658-…", "company": "wavetech-infomatics", "kind": "transfer",
      "queue_status": "closed", "xfer_time": "2026-11-06T15:36:33.432Z", "closed_at": "2026-11-06T15:50:02.000Z",
      "updated_at": "2026-11-06T15:50:02.120Z", "dialer": "D1", "vici_lead_id": 77,
      "fronter_user": "agent1043", "closer_user": "agent2001", "sale_disposition": "SALE", "match_status": "matched"
    }
  ],
  "next": "MjAyNi0xMS0wNlQxNTo1MDowMi4xMjAwMDBafGZkMjM2NjU4LS4uLg"
}
```

`kind` is one of these:

- `transfer`: a fronter XFER.
- `callback_sale`: a closer's sale on a callback with no transfer.
- `inbound_sale`: a sale that came straight into the closer group.

`fronter_user` is the agent who dispositioned the XFER. `closer_user` is the agent on the sale call, else the closer leg. `phone` is only included with `transfers.read_pii`.

Note: transfers that were never reviewed, flagged or closed are deleted after `RETENTION_DAYS` (default 7).

```bash
curl -H "Authorization: Bearer $QA_KEY" \
  "https://qa.example.com/api/v1/ext/transfers?status=closed&updated_since=2026-11-01T00:00:00Z&limit=500"
```

### `GET /api/v1/ext/evaluations` (`evaluations.read`)

Lists completed evaluations, ordered by `completed_at`. Parameters: `company`, `from`, `to` (on `completed_at`), `agent` (a user; case does not matter), `limit`, `cursor`.

```json
{ "data": [ { "id": "…", "company": "wavetech-infomatics", "transfer_id": "…", "agent": "agent2001", "agent_name": "Bilal", "dialer": "D1",
  "form": "Closer form", "form_target": "closer", "score": 90, "max_score": 100, "percent": 90, "passed": true, "auto_failed": false,
  "completed_at": "2026-11-06T16:36:33.486Z", "updated_at": "2026-11-06T16:36:33.486Z", "reviewer": "Sara" } ], "next": null }
```

`agent` is the agent the evaluation is about. It is the explicit target agent if one is set, otherwise the leg the form reviews (fronter forms: the fronter; closer forms: the closer). The QA performance report uses the same rule.

A completed evaluation can still be edited during the company's edit window. That changes its score and `updated_at`, but not `completed_at`.

### `GET /api/v1/ext/scores?period=YYYY-MM` (`scores.read`)

Gives the monthly QA score per agent and dialer, from completed evaluations. The month is a UTC month.

```json
{ "data": [ { "company": "wavetech-infomatics", "vici_user": "agent2001", "full_name": "Bilal", "dialer": "D1", "period": "2026-11",
  "count": 2, "avg_percent": 80, "min_percent": 70, "max_percent": 90, "pass_rate": 50 } ] }
```

### `GET /api/v1/ext/activity?from=YYYY-MM-DD&to=YYYY-MM-DD` (`calls.read`)

Gives dialer activity per agent and **shift day**. These are the same figures the HRMS attendance push sends. Optional parameters: `tz` (default `Asia/Karachi`) and `day_starts` (default `12:00`).

A shift day runs from `day_starts` to the same time the next day, and is dated the day it began. For example, a 20:00 → 05:00 night shift is one shift day. The range can be at most 62 days. Days older than `RETENTION_DAYS` are incomplete, because un-reviewed calls are deleted after that.

```json
{ "data": [ { "company": "wavetech-infomatics", "account": "agent1043", "day": "2026-11-05", "firstAt": "2026-11-05T15:00:00.000Z",
  "lastAt": "2026-11-06T00:03:00.000Z", "calls": 41, "talkSec": 5230 } ], "retentionDays": 7 }
```

## Webhooks

A webhook gets an HTTPS `POST` with a JSON body for each event it subscribes to:

| Event | When |
|---|---|
| `evaluation.completed` | an evaluation was completed (`data` = the evaluation, as in `/evaluations`) |
| `transfer.closed` | a transfer became a closed sale (`data.transfer` as in `/transfers` without phone numbers, and `data.change` = `{ from, to, reason }`) |
| `transfer.reopened` | a closed sale is no longer closed, e.g. after a disposition correction (same shape) |
| `ping` | the **Test** button |

An event list can use `*` (every event, including ones added later) and `prefix.*` (e.g. `transfer.*`). A company webhook only gets its own company's events. A super admin's all-companies webhook gets the events of every company.

Body:

```json
{
  "id": "transfer_event:9b0c…",
  "event": "transfer.closed",
  "occurredAt": "2026-11-06T15:50:02.120000Z",
  "company": { "id": "…", "slug": "wavetech-infomatics", "name": "WaveTech Infomatics" },
  "data": { "transfer": { "id": "…", "queue_status": "closed", "…": "…" }, "change": { "from": "unclosed", "to": "closed", "reason": "closer disposition 'SALE' -> closed" } }
}
```

Headers:

| Header | Value |
|---|---|
| `x-qa-event` | the event name |
| `x-qa-delivery` | the delivery id. It stays the same across retries, so use it to drop duplicates |
| `x-qa-timestamp` | the time of sending, in Unix seconds |
| `x-qa-signature` | the hex HMAC-SHA256 of `"<x-qa-timestamp>.<raw body>"`, keyed with the webhook secret |

The webhook secret (`whsec_…`) is shown once, when the webhook is made or its secret is rotated. Rotating replaces the old secret at once.

### Checking the signature (Node)

Compute the signature over the **raw** body, before any JSON parsing:

```js
import { createHmac, timingSafeEqual } from 'node:crypto';

export function verifyQaWebhook(rawBody, headers, secret, toleranceSec = 300) {
  const ts = headers['x-qa-timestamp'];
  const sig = headers['x-qa-signature'];
  if (!ts || !sig || Math.abs(Date.now() / 1000 - Number(ts)) > toleranceSec) return false;
  const expected = createHmac('sha256', secret).update(`${ts}.${rawBody}`).digest('hex');
  const a = Buffer.from(expected);
  const b = Buffer.from(String(sig));
  return a.length === b.length && timingSafeEqual(a, b);
}

// Express: app.post('/qa-webhook', express.raw({ type: 'application/json' }), (req, res) => {
//   if (!verifyQaWebhook(req.body.toString('utf8'), req.headers, process.env.QA_WEBHOOK_SECRET)) return res.sendStatus(401);
//   const event = JSON.parse(req.body.toString('utf8'));
//   …
//   res.sendStatus(204);
// });
```

### Delivery and retries

- The worker looks for new events **every 30 seconds**. An event is sent about 1 to 2 minutes after it happens, because events younger than 60 seconds wait one run so that rows still being saved are never skipped. Events are read in order from where the last run stopped, and each event is queued once per webhook, so nothing is missed or duplicated. A new installation starts from the moment it first runs, and a new webhook gets events from the moment it is added.
- Any `2xx` answer counts as delivered. Anything else is retried: a non-2xx answer, a redirect, a timeout (10 seconds) or a connection error.
- Retries wait 30 s, 1 min, 5 min, 15 min, 30 min, 1 h, 2 h, 4 h, 8 h and 8 h. That is 11 attempts over about 24 hours, after which the delivery is given up.
- One webhook's deliveries go out in order. If its receiver is down (5xx or no answer), the rest of its queue waits for the next try.
- **Connections → Webhooks** shows the status of each webhook (*failing since …* until the next success), its recent deliveries, and a **Retry now** button. **Pause** stops sending. Events that happen while a webhook is paused are queued and sent when it is resumed.
- Delivered deliveries, and given-up ones, are deleted after 14 days.
- Company admins can only add webhooks with public addresses: not `localhost`, not private IP ranges, and not single-word Docker service names. Super admins can also add internal addresses.

## Outgoing links

These run hourly in the worker. Their last results are shown on the Connections page.

| Job | Sends | On when |
|---|---|---|
| `hrms-qa-scores` | monthly QA score per agent → HRMS | `HRMS_URL` and a key |
| `hrms-attendance` | dialer attendance per shift day → HRMS | `HRMS_URL`, a key, and `HRMS_PUSH_ATTENDANCE` is not `false` |
| `hrms-sales` | closed sales → HRMS | `HRMS_URL` and `HRMS_PUSH_SALES=true` |
| `crm-qa-scores` | monthly QA score per agent → CRM | `CRM_URL` and `CRM_API_KEY` |

Details: `server/src/integrations/hrms/README.md` and `server/src/integrations/crm/README.md`.
