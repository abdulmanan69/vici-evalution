# CRM link: QA scores

This sends each agent's monthly QA score to the CRM (crm.vertexpakistan.com) every hour. It is off unless both settings are set.

```bash
CRM_URL=https://crm.example.com
CRM_API_KEY=…          # one key from the CRM; the CRM may limit it to some companies
```

On Coolify, both are already passed through by `docker-compose.coolify.yml` (`x-app-env`).

## What is sent

The worker job `crm-qa-scores` runs every hour while both settings are set. It covers the current and the previous month (UTC months), from completed evaluations only:

```
POST {CRM_URL}/api/ext/v1/metrics
Authorization: Bearer {CRM_API_KEY}

{ "source": "qa.vertexpakistan.com",
  "items": [ { "agent": "AGENT2001", "metric": "qa_score", "period": "2026-11", "value": 80, "unit": "%",
               "details": { "count": 2, "min": 70, "max": 90, "passRate": 50 } } ] }
→ { "received": 1, "saved": 1, "unknown": [] }
```

- `agent` is the VICIdial user in upper case. If the same user exists on several dialers or companies, it counts as one agent: its evaluations are merged, and the average is weighted by the number of evaluations.
- An evaluation counts for the agent it is about. That is the explicit target agent if one is set, otherwise the leg the form reviews. The QA performance report uses the same rule.
- A request holds at most 5,000 items; longer lists are split. Sending again replaces the value for the same agent, metric and month, so the hourly run is safe.
- Agents the CRM does not know come back in `unknown`. They are skipped, and are picked up by the first run after the CRM knows them.

The last run's result is shown in **Admin → Connections → Outgoing links**.

## Files

```
client.ts   CRM client (fetch, no dependencies), crmClient() from the environment
sync.ts     buildCrmQaItems(), pushCrmQaScores()
```
