# VICIdial QA Platform

**Call-quality review for VICIdial call centres — counts that match the dialer, recordings that appear the moment the dialer has them, and scorecards your reviewers actually finish.**

Built for fronter → closer operations: every XFER a fronter makes is tracked to the closer who took it, filed as **Transfer → Unclosed → Closed**, matched to its recordings, and handed to QA with the lead's full record beside the audio. Multi-company, role-based, audited, and shipped as five Docker containers.

> Built and maintained by **Abdul Manan**.

---

## Contents

1. [What you get](#what-you-get)
2. [How it works](#how-it-works)
3. [Install on a server (10 minutes)](#install-on-a-server-10-minutes)
4. [Connect your VICIdial](#connect-your-vicidial)
5. [Built-in QA forms](#built-in-qa-forms)
6. [Day-to-day operations](#day-to-day-operations)
7. [Configuration](#configuration)
8. [Security](#security)
9. [Troubleshooting](#troubleshooting)
10. [Project layout & development](#project-layout--development)

---

## What you get

### Queues that agree with the dialer
| Queue | What lands here |
|---|---|
| **Transfers** | every XFER a fronter dispositioned — built from VICIdial's own agent log, so the daily count equals the *Agent Status Detail* report to the call |
| **Unclosed** | transfers whose closer leg ended in anything other than a sale |
| **Closed** | every sale: on the transfer, on a later callback of the same lead, or straight into the closer group — equals the dialer's SALE count |

Counts are per **dialer day** (the dialer's time zone), with a header switch to show times in the reviewer's own zone. Verified day by day and agent by agent against VICIdial's reports.

### Recordings, live
- A call page shows **Call in progress → Being prepared on the dialer → playable**, refreshing itself every 8 seconds only while something can still change.
- The platform knows how VICIdial names files, so a recording is found the moment the dialer writes it — before the dialer's own list even reports it.
- Stale links heal themselves on play; a **Fetch from dialer** button forces an immediate re-check.
- 0-second "disposition only" entries are recognised and the real conversation is played instead.
- Every leg shows **who hung up** (customer / agent / handoff) and every disposition is a colour-coded pill.

### QA that fits the workflow
- **Three built-in scorecards** — TRA (fronter), Unclosed and Closed (closer) — plus a form builder with weights, critical/auto-fail questions, ratings, dropdowns and conditional questions. Every publish is an immutable version; old scores never change.
- **Evaluation page**: recordings and the lead's full record on the left, the form on the right. Nothing to switch between.
- **Daily tasks**: managers assign a dialer day's calls, per method, to a reviewer — all of them or a sample.
- **Reviewer scoping**: limit a reviewer to specific methods/queues and to specific dialer agents.
- **Reports**: evaluations spreadsheet with one column per question (CSV), QA performance by agent and by reviewer, agent activity straight from the dialer (live + archived days).

### Enterprise basics
Multi-company with strict data isolation · roles & permissions (super admin, company admin, QA manager, reviewer) · full audit log · encrypted dialer credentials · 7-day rolling retention that **keeps every evaluated call forever** · recordings only ever streamed through the authenticated API, never by public URL.

---

## How it works

```
                 ┌──────────────────────────── your VICIdial ────────────────────────────┐
                 │  Non-Agent API   ·   read-only MySQL (vicidial_log, closer_log,       │
                 │  (recordings,       agent_log, vicidial_list …)   ·   recording web   │
                 │   agents, leads)                                       server (MP3)   │
                 └───────▲──────────────────────────▲─────────────────────────▲──────────┘
                         │ every 60 s                │                         │ HEAD/GET
          ┌──────────────┴──────────────┐   ┌────────┴────────┐       ┌────────┴────────┐
          │  worker  (BullMQ)           │   │  api  (Fastify) │◄──────┤  web  (nginx)   │◄── browser
          │  sync · match · recordings  │   │  REST + auth +  │       │  React app +    │
          │  retention · repair         │   │  recording proxy│       │  /api proxy     │
          └──────────────┬──────────────┘   └────────┬────────┘       └─────────────────┘
                         │                           │
                 ┌───────▼───────────────────────────▼───────┐   ┌───────────┐
                 │              PostgreSQL 16                 │   │   Redis   │
                 └────────────────────────────────────────────┘   └───────────┘
```

**Sync** reads the dialer every minute: calls (outbound + closer-group), the agent log (the source of truth for XFER counts), recordings and the agent roster. Calls are re-read for 12 hours because VICIdial writes a row at call start and rewrites it on disposition.
**Match** links each transfer to its closer leg by lead, phone and timing (auto ≥ 70, flagged 40–69 for a manager to resolve).
**Recordings** are linked to calls by start/end time, verified on the dialer's final MP3, and repaired every minute until the retention window ends.

More depth: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) · [docs/VICIDIAL_INTEGRATION.md](docs/VICIDIAL_INTEGRATION.md)

---

## Install on a server (10 minutes)

**Requirements:** a Linux server (Ubuntu 22.04/24.04 or Debian 12), 2 vCPU, 4 GB RAM, 40 GB disk, outbound access to your dialer. Docker is installed for you if missing.

### Option A — HTTPS with your own domain (recommended)

Point a DNS **A record** (e.g. `qa.example.com`) at the server, open ports **80** and **443**, then:

```bash
git clone https://github.com/abdulmanan69/vici-evalution.git vici-qa
cd vici-qa
./deploy/install.sh qa.example.com
```

Certificates are issued automatically (Let's Encrypt via Caddy) and renewed forever.

### Option B — plain HTTP on a port

```bash
git clone https://github.com/abdulmanan69/vici-evalution.git vici-qa
cd vici-qa
./deploy/install.sh
```

The app is on `http://<server-ip>:3000` (change `WEB_PORT` in `.env`). Use this only inside a private network or behind your own reverse proxy.

The installer writes `.env` with **random secrets**, builds and starts the five containers, waits for the API, and prints the super-admin login. Database migrations run automatically at every start. Re-running the installer is safe.

### Option C — Coolify

Coolify builds the stack straight from this repository and gives it a domain with HTTPS; nothing is published on host ports.

1. **+ New Resource → Public Repository** (or your connected GitHub App), repository `https://github.com/abdulmanan69/vici-evalution.git`, branch `main`.
2. **Build Pack:** *Docker Compose*. **Docker Compose Location:** `/docker-compose.coolify.yml`. Continue.
3. **Environment Variables** tab — the variables from the compose file are listed; set:
   - `APP_ENCRYPTION_KEY` — 64 hex characters (`openssl rand -hex 32`)
   - `SUPERADMIN_EMAIL` and `SUPERADMIN_PASSWORD` (8+ characters)
   - leave the rest at their defaults; the Postgres password is generated by Coolify (`SERVICE_PASSWORD_POSTGRES`)
4. On the **`web`** service set your domain, e.g. `https://qa.example.com` (DNS A record pointing at the Coolify server first). Coolify issues and renews the certificate.
5. **Deploy**. The first build takes a few minutes (it compiles the API and the web app); every service shows *healthy* when done. Open the domain and sign in.

Afterwards: a push to `main` redeploys automatically if you enable the webhook / GitHub App auto-deploy, otherwise press **Redeploy**. Back up with Coolify's *Scheduled Tasks* on the `postgres` service, command `pg_dump -U vici_qa vici_qa | gzip > /var/lib/postgresql/data/../backup-$(date +%F).sql.gz`, or from the host: `docker exec <postgres-container> pg_dump -U vici_qa vici_qa | gzip > vici-qa-$(date +%F).sql.gz`.

### After the first login
1. **Change the super-admin password** (top-right menu).
2. **Companies** → create your company, then pick it in the scope selector.
3. **Dialer servers** → add your dialer (next section) and press **Test connection**.
4. **Dispositions** → map your codes (`XFER → Transfer`, each sale code → `Sale`).
5. **Users** → invite managers and reviewers; **QA team** → assign agents and methods.
6. Queues fill within a minute; the first sync imports the retention window.

---

## Connect your VICIdial

You need two things from the dialer. Hand [DB-ACCESS-REQUEST.md](DB-ACCESS-REQUEST.md) to whoever administers it — it asks for exactly this, nothing more.

**1. An API user** (user level 9 with API access) — used for recordings, agent lists and lead lookups.

**2. A read-only MySQL user** on the `asterisk` database, reachable from this server:

```sql
CREATE USER 'qa_readonly'@'<this-server-ip>' IDENTIFIED BY '<strong password>';
GRANT SELECT ON asterisk.* TO 'qa_readonly'@'<this-server-ip>';
FLUSH PRIVILEGES;
```

The platform only ever runs `SELECT`s, mostly small time-bounded reads against indexed columns; the load on the dialer is negligible.

In **Dialer servers → Add dialer** enter the web root (`https://your-dialer`), the API user, the MySQL host/database/user/password, the recording web server if it differs, and the **dialer's time zone** (e.g. `America/New_York`). The time zone matters: VICIdial stores local times, and every count here is per dialer day. The platform also reads the dialer's clock on every sync and warns if the configured zone disagrees.

Press **Test connection**: both the API and the MySQL checks must pass.

---

## Built-in QA forms

Every company starts with three published scorecards (identical closer forms by design):

| Form | For | Queue | Pass mark |
|---|---|---|---|
| **TRA – Transfer Call (Fronter)** | fronters | Transfers | 66 % |
| **Unclosed – Closer Call** | closers | Unclosed | 90 % |
| **Closed – Closer Call** | closers | Closed | 90 % |

They are ordinary forms: edit them, add questions, re-publish (each publish is a new version; past evaluations keep theirs). If one is archived or lost, **QA forms → Load default forms** brings back whatever is missing without touching the rest. The same happens automatically at every start and when a company is created. The definitions live in [`server/src/services/defaultForms.ts`](server/src/services/defaultForms.ts).

---

## Day-to-day operations

| Task | Command |
|---|---|
| Update to the latest version | `./deploy/update.sh` |
| Back up the database (keeps the newest 14) | `./deploy/backup.sh` |
| Nightly backup | `crontab -e` → `15 2 * * * /opt/vici-qa/deploy/backup.sh >> /var/log/vici-qa-backup.log 2>&1` |
| Restore a backup | `./deploy/restore.sh backups/vici-qa-20261018-021500.sql.gz` |
| Status | `docker compose ps` |
| Logs (API / worker) | `docker compose logs -f api` · `docker compose logs -f worker` |
| Restart everything | `docker compose restart` |
| Full re-sync of a dialer | **Dialer servers → Sync (full)** |
| Delete a dialer | **Dialer servers → Delete** (company admins and super admins) |
| Delete a company | **Companies → Delete** (super admins only) |

**Deleting.** The dialog first counts what goes with the item (calls, recordings, transfers, evaluations, users …) and asks for its exact name. A deleted dialer stops syncing at once and leaves every list and filter; a deleted company's users are signed out and disabled at once. The data is then removed by the worker in small batches, so a big dialer never locks the database, and the row disappears from the admin page when it is done. Names and slugs are free for re-use straight away. QA forms stay when only a dialer is deleted. Every delete is in the audit log.

**Retention.** Un-reviewed calls, transfers and recordings older than `RETENTION_DAYS` (default 7) are deleted nightly. Anything with an evaluation, or flagged, is kept forever — nothing a reviewer touched is ever lost. Recordings are never copied; they stay on the dialer and stream through the API on demand.

**Health.** `GET /healthz` on the API (and through the web container) answers `200` when the database and Redis are reachable; `Dialer servers` shows the last sync, its duration and any warnings (time-zone mismatch, unmapped dispositions, archive access).

---

## Configuration

All settings live in `.env` (template: [`.env.example`](.env.example)). The installer fills the secrets.

| Variable | Default | Meaning |
|---|---|---|
| `NODE_ENV` | `production` | production refuses to start with the placeholder encryption key |
| `WEB_PORT` / `WEB_BIND` | `3000` / `0.0.0.0` | where the app listens; `WEB_BIND=127.0.0.1` behind the HTTPS proxy |
| `API_PORT` / `API_BIND` | `8080` / `127.0.0.1` | the API; the web container reaches it internally |
| `DOMAIN` | *(empty)* | enables the HTTPS overlay (`docker-compose.https.yml`) |
| `POSTGRES_DB` / `POSTGRES_USER` / `POSTGRES_PASSWORD` | — | database credentials (Postgres is bound to localhost only) |
| `APP_ENCRYPTION_KEY` | — | 32-byte hex key that encrypts dialer credentials at rest |
| `SESSION_TTL_HOURS` | `12` | login session length |
| `COOKIE_SECURE` | `false` | `false` = automatic (Secure whenever the page is served over HTTPS); `true` forces it on |
| `SUPERADMIN_EMAIL` / `SUPERADMIN_PASSWORD` | — | bootstrap account, created on first start |
| `RETENTION_DAYS` | `7` | rolling window for un-reviewed data (0 = keep everything) |
| `SYNC_POLL_SECONDS` | `60` | how often each dialer syncs |
| `SYNC_LOOKBACK_MINUTES` | `15` | overlap re-read on every incremental sync |
| `SYNC_HISTORICAL_DAYS` | `30` | history imported on a full sync (capped by retention) |
| `RECORDING_CHECK_SECONDS` | `60` | recording repair job cadence |
| `SYNC_CONCURRENCY` | `4` | dialers synced side by side (each dialer still runs one sync at a time) |
| `PG_SHARED_BUFFERS` / `PG_EFFECTIVE_CACHE_SIZE` / `PG_WORK_MEM` | `256MB` / `1GB` / `16MB` | Postgres memory; on a bigger server set shared buffers to about a quarter of RAM |
| `PG_LOG_SLOW_MS` | `2000` | Postgres logs statements slower than this |
| `MATCH_AUTO_THRESHOLD` / `MATCH_FLAG_THRESHOLD` | `70` / `40` | fronter→closer match scores for auto-link and manual review |
| `SEED_DEMO` | `false` | creates a clearly flagged demo company with synthetic data |

---

## Security

- Dialer passwords are encrypted with `APP_ENCRYPTION_KEY` and never returned by the API.
- Recordings are streamed only through `/api/v1/recordings/:id/stream`, behind login, permission and company checks; the dialer's URLs are never exposed to the browser.
- Postgres and the API are bound to `127.0.0.1`; only the web port (or Caddy's 80/443) faces the network.
- Every change — users, roles, forms, dispositions, dialer settings, evaluations, playback — is written to the audit log.
- Sessions are HTTP-only cookies, marked Secure automatically whenever the site is served over HTTPS (`COOKIE_SECURE=true` forces it).

---

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| `port is already allocated` on start | another service owns `WEB_PORT`; change it in `.env` and `docker compose up -d` |
| **Test connection** fails on MySQL | the dialer's firewall/`bind-address` or the user's host (`'qa_readonly'@'<this-server-ip>'`) — ask the dialer admin to allow this server's public IP |
| A transfer shows *Closer leg not found* | the dialer has no closer-side call for it (dropped in queue, outside number, or XFER saved without a transfer) — the page says so after 30 min |
| A recording says *Being prepared on the dialer* for long | the dialer converts files 1–3 min after hangup; press **Fetch from dialer**; if it stays, the dialer never produced the file (the dialer's own lead page will show the same) |
| Counts differ from the dialer by a few | check the dialer **time zone** on the dialer server page and the **Dispositions** mapping — every XFER code must map to *Transfer*, every sale code to *Sale* |
| `502` right after a restart | nginx is waiting for the API; it re-resolves within 10 s |
| The site feels slow | **Sync monitor** shows each sync's seconds per stage — a slow stage is usually the dialer answering slowly. For the database, `docker compose exec postgres psql -U vici_qa -d vici_qa -c "select calls, round(mean_exec_time) ms, left(query, 120) from pg_stat_statements order by total_exec_time desc limit 10"` lists the heaviest queries |
| Lost the super-admin password | it is in `.env` as `SUPERADMIN_PASSWORD` at install time; otherwise reset it from **Users** with another admin |

---

## Project layout & development

```
deploy/                  install.sh · update.sh · backup.sh · restore.sh · Caddyfile
docker-compose.yml       postgres + redis + api + worker + web
docker-compose.https.yml Caddy overlay for automatic HTTPS
docker-compose.coolify.yml  the same stack for Coolify (no host ports, proxy-managed domain)
server/
  drizzle/               SQL migrations (applied automatically at start)
  src/db/                schema, migrator, seed (roles, super admin, default forms)
  src/auth/              sessions, permissions, company scoping
  src/routes/            REST API (queues, recordings, QA forms, tasks, reports, admin…)
  src/services/          default forms · form schema & scoring · live recordings
  src/vicidial/          API + MySQL adapters, sync, matcher, recording URL repair
  src/worker.ts          BullMQ schedulers (sync, recording repair, retention)
web/src/                 React app (queues, call pages, evaluation, forms, reports, admin)
docs/                    architecture and VICIdial integration notes
```

Local development:

```bash
docker compose up -d postgres redis
cd server && npm install && npm run migrate && npm run seed
npm run dev            # API on :8080
npm run dev:worker     # sync worker
cd ../web && npm install && npm run dev   # :3000, proxies /api to :8080

cd server && npm test  # unit tests: matching, scoring, dispositions, time zones, recording URLs
```

---

© 2026 Abdul Manan. All rights reserved.
