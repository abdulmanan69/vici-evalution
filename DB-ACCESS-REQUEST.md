# Request: Read-Only Database Access for VICIdial Reporting

**To:** Server administration / hosting support team
**Subject:** Read-only MySQL access for our call-reporting integration
**Action requested:** please review the questions below and let us know what is possible.

---

## Why we are asking

We run an internal call-reporting and review tool for our dialer. It tracks agent
transfers, links calls to their recordings, and produces daily reports that must match
the dialer's own reports exactly.

Right now the tool collects this data through the VICIdial API and per-agent report
exports, because the API has no call-log export. That approach works, but it sends a
large number of requests to the dialer's web server every sync cycle. Direct read-only
database access would replace all of that with a few small indexed queries — more
accurate for us, and noticeably **less load on your servers**.

---

## What we need — please let us know

1. **Could you create a read-only (SELECT-only) MySQL user** on the VICIdial database
   for us? We never need write access of any kind.

2. **What host address and port should we connect to** for the database? (We understand
   the database may run on a separate server from the dialer web interface.)

3. **Could you open the MySQL port through the firewall** so our tool can reach the
   database from outside?

4. **Does MySQL currently accept remote connections**, or would additional configuration
   be needed on your side?

5. **Which database name should we use?** (VICIdial's default is `asterisk` — please
   confirm or correct.)

6. **Are the archived tables available in the same database?** The dialer archives
   older days nightly, so we would also read the `*_archive` variants of the call-log
   tables if they exist.

7. **If a full read-only grant on the database is against your policy**, could you grant
   SELECT on just these tables instead? This is the complete list we read:
   - `vicidial_log` — outbound call legs and their dispositions
   - `vicidial_closer_log` — inbound closer call legs
   - `recording_log` — recording filenames and their link to each call
   - `vicidial_users` — agent names, for readable reports
   - `vicidial_campaigns` — campaign names
   - `vicidial_inbound_groups` — in-group names
   - plus the `*_archive` variants of the three log tables, where present

8. **What is your preferred secure channel** for sending us the credentials once
   created?

9. **Are there any maintenance windows, usage limits, or policies** we should respect
   when querying?

---

## The simplest way to set this up (for your admin)

The whole thing is three small steps on the database server and takes a few minutes:

**Step 1 — create the read-only user** (in MySQL as root):

```sql
CREATE USER 'readonly_report'@'%' IDENTIFIED BY '<choose a strong password>';
GRANT SELECT ON asterisk.* TO 'readonly_report'@'%';
FLUSH PRIVILEGES;
```

This one grant covers every table we listed above, including the archive tables, and
gives no ability to change anything. If policy requires it, the same works as
per-table `GRANT SELECT` statements on the seven tables instead.

**Step 2 — open the MySQL port** in the server firewall:

```bash
# iptables example:
iptables -I INPUT -p tcp --dport 3306 -j ACCEPT

# or with CSF: open port 3306 in /etc/csf/csf.conf (TCP_IN), then: csf -r
```

You may of course scope this rule however your policy prefers.

**Step 3 — confirm MySQL listens for remote connections:**

Check that `bind-address` in the MySQL config (`/etc/my.cnf` or `my.cnf.d/`) is not
`127.0.0.1`. On a multi-server VICIdial cluster this is normally already the case,
since the dialer web server connects to the database server over the network — if so,
nothing to change here.

Then send us the **host, port, database name, username, and password**, and we can
verify the connection together in a couple of minutes.

---

## Our commitments

- **Read-only, always.** Our integration only ever issues SELECT statements. The
  account needs no INSERT, UPDATE, DELETE, or schema rights.
- **Low load.** Queries are time-bounded on the indexed `call_date` columns, batched
  with LIMIT, from a connection pool capped at 3 connections.
- **Revocable at any time.** Drop the user or close the port and our tool simply falls
  back to the current report-export method.
- **Credentials protected.** Stored encrypted (AES-256-GCM) on our side, never logged.
- **Narrow scope.** Only call logs, dispositions, and recording metadata — no lead
  lists, agent scripts, or payment data are part of this request.

---

Thank you — please tell us if any part of this needs to be done differently to fit
your policies.
