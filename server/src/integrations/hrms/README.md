# Connecting VICIdial QA to WaveTech HRMS

Written for: whoever maintains the VICIdial QA platform ([github.com/abdulmanan69/vici-evalution](https://github.com/abdulmanan69/vici-evalution)) and wants it to use HRMS data.

This kit adds the HRMS link to the QA platform in about ten minutes. It only adds files and a few lines. Nothing existing in the QA platform changes behaviour, and with no HRMS settings everything stays switched off.

## What you get

| In the QA platform | From HRMS |
| --- | --- |
| Agent `agent1043` | the real person: name, SIP ID, department, designation, team lead, active or left, on leave today or soon |
| QA scores | sent back to HRMS each month and shown on the employee's profile ("QA score 85%, VICIdial, November 2026") |
| Closed sales | sent to HRMS every hour, credited to the closer and the fronter; HRMS pays the monthly sales incentive in payroll |
| Changes in HRMS | a signed webhook as soon as someone joins, changes, leaves or goes on leave, naming the agent user directly |

The QA platform and HRMS keep their own databases. They only meet through the HRMS API, with a key that can read people and leave and write QA figures and sales, nothing else.

## 1. In HRMS (an HR admin, five minutes)

1. Open **Admin → Integrations → VICIdial**.
2. **Create the VICIdial key.** It gets exactly `employees.view`, `leave.view`, `metrics.write` and `sales.write`. Copy the two lines shown (`HRMS_URL`, `HRMS_API_KEY`). The key is shown once.
3. **Match agents to employees.** Paste the agent list (`user, full name` per line; copy it from QA → Admin → Agents). Strong name matches are picked for you. Check them and click **Link**. People can also be linked one at a time on an employee's profile (*Connected accounts*).
4. Optional: **Add webhook** with the QA platform's URL `https://<qa host>/api/v1/hrms/webhook/<qa company slug>`. Copy the `HRMS_WEBHOOK_SECRET` line shown.

If the same agent user exists on two dialers with different people behind it, put the dialer name in the *Dialer* field when linking and set `HRMS_CONTEXT=dialer` below.

## 2. In the QA platform

### Copy the files

Copy `server/src/integrations/hrms/` from this folder into the QA platform's `server/src/integrations/hrms/`:

```
client.ts   HRMS API client (no new dependencies), webhook signature check, per-company keys
sync.ts     pushQaScores(), pushSales(), employeesFor(), unavailableAgents()
routes.ts   webhook receiver + /api/v1/hrms/agents lookup + manual "push now"
```

### Add the settings to `.env`

```bash
HRMS_URL=https://hrms.example.com
HRMS_API_KEY=hrms_xxxxxxxx_…            # one HRMS company for every QA company
# or per QA company slug:
# HRMS_API_KEYS=acme=hrms_…,beta=hrms_…
HRMS_WEBHOOK_SECRET=whsec_…              # or HRMS_WEBHOOK_SECRETS=acme=whsec_…,beta=whsec_…
# HRMS_CONTEXT=dialer                    # only if HRMS links use dialer names
# HRMS_TZ=Asia/Karachi                   # the day a sale counts on (HR's calendar)
```

The kit reads these directly, so `config.ts` doesn't change. In Docker they reach the `api` and `worker` containers through the existing `env_file: .env`.

On Coolify there is no `.env` file. Set the values in the app's Environment Variables tab, and add them to `x-app-env` in `docker-compose.coolify.yml` so both containers get them:

```yaml
  HRMS_URL: ${HRMS_URL:-}
  HRMS_API_KEY: ${HRMS_API_KEY:-}
  HRMS_API_KEYS: ${HRMS_API_KEYS:-}
  HRMS_WEBHOOK_SECRET: ${HRMS_WEBHOOK_SECRET:-}
  HRMS_WEBHOOK_SECRETS: ${HRMS_WEBHOOK_SECRETS:-}
  HRMS_CONTEXT: ${HRMS_CONTEXT:-}
  HRMS_TZ: ${HRMS_TZ:-Asia/Karachi}
```

### Register the routes in `server/src/app.ts`

```ts
import { hrmsWebhookRoutes, hrmsRoutes } from './integrations/hrms/routes.js';

// next to: await app.register(authRoutes, { prefix: '/api/v1/auth' });
await app.register(hrmsWebhookRoutes, { prefix: '/api/v1/hrms' });

// inside the authenticated block, next to: await api.register(reportRoutes, { prefix: '/reports' });
await api.register(hrmsRoutes, { prefix: '/hrms' });
```

### Send QA scores and sales every hour, from `server/src/worker.ts`

```ts
import { pushQaScores, pushSales } from './integrations/hrms/sync.js';

// with the other schedulers:
for (const name of ['hrms-qa-scores', 'hrms-sales']) {
  if (process.env.HRMS_URL) await maintenanceQueue.upsertJobScheduler(name, { every: 3600 * 1000 }, { name, opts: keep });
  else await maintenanceQueue.removeJobScheduler(name).catch(() => false);
}

// in the maintenance worker's job switch:
if (job.name === 'hrms-qa-scores') return pushQaScores();
if (job.name === 'hrms-sales') return pushSales();
```

**QA scores.** Each run sends the current and previous month's average per agent, from completed evaluations only. Sending again just updates the same month, so the hourly run is safe.

**Sales.** Each run sends every closed sale from the first day of last month to today. Each sale is credited to:

- **the closer:** the agent on the sale call
- **the fronter:** the agent who dispositioned the XFER

The run covers the whole period, so a sale that is no longer closed in QA is voided in HRMS. Once HRMS approves a month's payroll, it keeps that month as paid.

**Agents not linked yet** are returned in `unknown` and skipped. They are picked up by the first run after they are linked.

## 3. Use it

**In QA screens**, e.g. the agents list or an evaluation:

```ts
const r = await api<{ data: HrmsPerson[] }>('/hrms/agents', { query: { users: agents.map((a) => a.viciUser).join(',') } });
// r.data[i].found && r.data[i].employee → name, sipId, department, manager, active, onLeaveToday …
```

**When assigning QA tasks**, skip people who left or are away today:

```ts
import { unavailableAgents } from './integrations/hrms/sync.js';
const { left, onLeave } = await unavailableAgents(companyId);   // vici_agents ids
```

**On a webhook** (`routes.ts`), the signature is checked and cached HRMS details are dropped, so screens show the change at once. `event.data.links.vicidial` lists the agent users concerned. Heavier reactions, like moving an agent's open QA tasks when they leave, belong in a queued job started from there.

**Push now:** `POST /api/v1/hrms/push-qa-scores` and `POST /api/v1/hrms/push-sales` (permission `admin.agents`) send right away.

## Checked

- **Typechecks** against the QA platform's own code and packages, including the `app.ts` lines above.
- **`pushQaScores()`** was run against a real QA database built with the platform's own migrations: 2 completed evaluations (90 %, 80 %) and 1 draft became `qa_score 85 %` from 2 evaluations in HRMS.
- **`pushSales()`** was run against the same database: two closed transfers and one closer callback sale credited `agent1043` with 3 sales and the fronter `agent2001` with 2. An open transfer and a mock sale were left out, and a second run changed nothing.
- **`employeesFor()`**, the name matching, linking, the signed webhook (verified with `verifyHrmsWebhook`) and the polling feed were run against a live HRMS.

## Reference

- HRMS connector API (`/api/v1/connect/vicidial/…`): `people`, `roster`, `suggest`, `links`, `metrics`. Full details in the HRMS repo's `docs/INTEGRATIONS.md`.
- **Webhook payloads** never contain CNIC, bank details or date of birth.
- **API key limits:** 600 requests per minute. It can be revoked at any time in HRMS, and stops working at once.
