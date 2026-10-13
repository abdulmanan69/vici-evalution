# VICIdial QA Platform

Enterprise quality-assurance platform for VICIdial call centers: syncs real call
logs and recordings from one or many dialer servers, tracks fronter→closer
transfers (same-dialer and cross-dialer), and gives QA teams versioned
scorecards, secure recording playback, and full admin/audit tooling — all
multi-company with strict data isolation.

## Stack

| Piece | Technology |
|---|---|
| API | Node.js 22, TypeScript, Fastify 5 |
| Worker | BullMQ (Redis) — scheduled dialer sync + recording checks |
| Database | PostgreSQL 16, Drizzle ORM, SQL migrations |
| VICIdial sources | Non-Agent API + read-only MySQL (per dialer, configurable) |
| Frontend | React 18, Vite, Tailwind, TanStack Query |
| Packaging | Docker Compose (postgres, redis, api, worker, web) |

## Quick start

```bash
cp .env.example .env
# edit .env: set POSTGRES_PASSWORD, APP_ENCRYPTION_KEY (openssl rand -hex 32),
# SUPERADMIN_EMAIL / SUPERADMIN_PASSWORD

docker compose up -d --build
```

Open http://localhost:3000 and sign in with the super-admin credentials from
`.env`. Migrations and the seed run automatically when the API starts.

Optional demo data: set `SEED_DEMO=true` before first boot to create a
"Demo Company (MOCK DATA)" with synthetic, clearly flagged (`is_mock=true`)
calls — mock rows are excluded from real queues, stats and sync.

## Connecting your VICIdial servers

1. Sign in as super admin → **Companies** → create the company.
2. Pick the company in the top scope selector → **Dialer servers** → *Add dialer*:
   - **Base URL** — the dialer web root (hosts `/vicidial/non_agent_api.php`).
   - **API user/pass** — your existing VICIdial API user.
   - **MySQL host/db/user/pass** — read-only (SELECT-only) access to the
     `asterisk` database. This is the recommended call-log source; the
     Non-Agent API has no full call-log export (see
     [docs/VICIDIAL_INTEGRATION.md](docs/VICIDIAL_INTEGRATION.md)).
   - **Server timezone** — the IANA zone the dialer logs in (VICIdial stores
     local time); wrong timezone = wrongly linked calls.
3. Press **Test connection** — both the API and MySQL checks must pass.
4. **Dispositions** → map your codes explicitly: `XFER → Transfer`, each sale
   code → `Sale`. Nothing is ever treated as a sale by its name alone.
5. **Sync monitor** → *Sync all active dialers* (first run imports
   `SYNC_HISTORICAL_DAYS` of history; the worker then polls every
   `SYNC_POLL_SECONDS`).
6. **Agents** → classify fronters/closers. **QA forms** → build and publish a
   scorecard. Queues fill up under Transfers / Unclosed / Closed.

## Development

```bash
# backend (needs local postgres+redis, or: docker compose up -d postgres redis)
cd server && npm install
npm run migrate && npm run seed
npm run dev          # API on :8080
npm run dev:worker   # sync worker

# frontend
cd web && npm install
npm run dev          # :3000, proxies /api to :8080

# tests (46 unit tests: matching, scoring, dispositions, timezone, crypto)
cd server && npm test
```

## Repository layout

```
docker-compose.yml       postgres + redis + api + worker + web
server/
  drizzle/               generated SQL migrations
  src/db/                schema, migrator, seed
  src/auth/              sessions, RBAC permissions, company scoping
  src/routes/            REST API (auth, queues, recordings, QA, admin…)
  src/vicidial/          API/MySQL adapters, timezone, matcher, queue logic, sync
  src/services/          QA form schema + scoring engine
  src/worker.ts          BullMQ schedulers/processors
web/src/                 React app (queues, call detail, form builder, admin)
docs/                    architecture + VICIdial integration notes
```

More detail: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) ·
[docs/VICIDIAL_INTEGRATION.md](docs/VICIDIAL_INTEGRATION.md)
