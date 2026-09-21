# Heartbeat monitor

Every minute, this service records one snapshot of your system: how hard each backend node is working, and how much business went through it.

```json
{ "datetime": "2026-09-17T14:05:00Z", "meta": { "cluster": "backend", "node": "10.0.0.12:9100" }, "cpuUsage": 71, "memoryUsage": 60 }
{ "datetime": "2026-09-17T14:05:00Z", "meta": { "cluster": "__cluster__", "node": "__cluster__" }, "orders": 100, "chats": 500 }
```

Those records go into a **MongoDB time-series collection**, and a REST API plus a dashboard chart them over any date range.

---

## Contents

1. [How it works](#1-how-it-works)
2. [The heartbeat](#2-the-heartbeat)
3. [Where the numbers come from](#3-where-the-numbers-come-from)
4. [The stored record](#4-the-stored-record)
5. [Clusters and nodes](#5-clusters-and-nodes)
6. [The API](#6-the-api)
7. [The dashboard](#7-the-dashboard)
8. [Running it](#8-running-it)
9. [Configuration](#9-configuration)
10. [Project layout](#10-project-layout)
11. [Going to production](#11-going-to-production)

---

## 1. How it works

Four moving parts. Each one only talks to its neighbour.

```
 BACKEND NODES                   PROMETHEUS                        HEARTBEAT MONITOR (this project)
┌──────────────────┐   ① pull    ┌──────────────────┐   ② PromQL    ┌───────────────────┐
│ node_exporter    │ ◄────────── │ scrapes + stores │ ◄──────────── │ collector (cron)  │
│ :9100/metrics    │  every 15s  │ the raw counters │  every minute │                   │
│ (one per node)   │             └──────────────────┘               │                   │ ③ COUNT
└──────────────────┘                                                │                   │ ─────────► orders DB
 your app runs here,                                                │                   │ ─────────► chats DB
 not involved in this                                               │                   │ ④ insert
                                                                    └───────────────────┘ ─────────► MongoDB
                                                                              │                     (time-series)
                                                                    Express API + dashboard ◄───────┘
```

| Step | Who starts it | How often | Code |
|---|---|---|---|
| ① scrape | Prometheus (pull) | every 15s | `prometheus/prometheus.yml` |
| ② CPU + memory per node | collector | every minute | `src/services/prometheus.js` |
| ③ orders + chats counts | collector | every minute | `src/sources/simulatedDatabases.js` |
| ④ insert | collector | every minute | `src/services/collector.js` |

**Your backend app exposes nothing.** node_exporter — a small agent on each node — reads the Linux kernel's counters and serves them as text. Prometheus scrapes it. The collector asks Prometheus, never the nodes directly.

Full walkthrough with request and response examples: [docs/HOW-DATA-IS-COLLECTED.md](docs/HOW-DATA-IS-COLLECTED.md).

---

## 2. The heartbeat

A `node-cron` job (`src/services/collector.js`) fires at the top of every minute and records the minute that just ended: a run at 14:06:00 writes the window `[14:05:00, 14:06:00)`.

```js
const task = cron.schedule(cronExpression, () => {          // '* * * * *'
  const to = new Date(Math.round(Date.now() / intervalMs) * intervalMs);  // snap to the exact boundary
  const from = new Date(to.getTime() - intervalMs);
  collectHeartbeat(from, to)...
});
```

Three details that matter:

- **Snapping to the boundary.** Cron fires a few milliseconds late, so the timestamp is rounded to the exact minute. Records always land on `:00`, never drifting.
- **Everything runs in parallel.** Two PromQL queries and two database counts go out together; the slowest one sets the pace. If one fails, only its field is saved as `null`, so a Prometheus hiccup never costs you the order counts.
- **Runs are independent.** A slow minute doesn't delay the next one.

### Why a minute, and not a second

CPU usage is a **rate** — it can only be measured between two readings. Prometheus needs at least two scrapes inside the measurement window, which makes a true one-second value impossible. A one-minute window fits the standard 15s scrape (4 samples per record) with no special Prometheus configuration.

The CPU window equals the heartbeat interval, so CPU, orders and chats describe **exactly the same minute**. Verified by loading one of two test cores for precisely 17:36:00–17:37:00:

| datetime (UTC) | cpuUsage | orders | chats |
|---|---|---|---|
| 17:35:00 | 2% | 90 | 395 |
| **17:36:00** | **51%** | 86 | 362 |
| 17:37:00 | 1% | 95 | 395 |

One busy core out of two is ~50%, and the load appeared only in that minute's record.

**The rules:** `scrape_interval` must be half the heartbeat or less (15s is ideal, 30s is the limit), and `HEARTBEAT_CRON` must agree with `HEARTBEAT_INTERVAL_MS` (`* * * * *` ↔ 60000, `*/5 * * * *` ↔ 300000).

---

## 3. Where the numbers come from

node_exporter reports no percentages — only raw counters. The percentages are computed with PromQL.

### CPU usage %

For each core, the kernel counts seconds spent in each mode since boot:

```
node_cpu_seconds_total{cpu="0",mode="idle"} 793.49
node_cpu_seconds_total{cpu="1",mode="idle"} 803.51
```

```
cpuUsage = 100 * (1 - avg by (instance, job, cluster) (rate(node_cpu_seconds_total{mode="idle"}[1m])))
```

1. `rate(...[1m])` — idle seconds gained per real second, per core, over the record's minute
2. `avg by (instance, job, cluster)` — averaged across that node's cores, kept separate per node
3. `100 * (1 - idle)` — what's left is usage

A real reading from a 2-core test machine:

| Core | Idle counter | Over | Idle |
|---|---|---|---|
| cpu 0 | 793.49 → 797.33 s | 4 s | 96.0% |
| cpu 1 | 803.51 → 807.43 s | 4 s | 98.0% |
| **Average** | | | **97.0%** |

`cpuUsage = 100 − 97 = 3%`. Calculated by hand, it matched the PromQL result exactly.

So **71% means the node's cores were busy 71% of the time**, counting every process on that machine — your app, the database if it's co-located, the OS.

### Memory usage %

```
node_memory_MemTotal_bytes      8422297600   (8032 MB)
node_memory_MemAvailable_bytes  7804715008   (7443 MB)

memoryUsage = 100 * (1 - MemAvailable / MemTotal) = 7.34%  → saved as 7
```

It uses **MemAvailable**, not MemFree. Linux fills spare RAM with file cache and releases it the moment an app needs memory; counting that as "used" would show 90%+ on a perfectly healthy server. The result matches `free -m`'s `total − available`.

Unlike CPU, this is a **snapshot** at the end of the minute, not an average. Memory moves slowly, so that's fine.

### Orders and chats

These don't come from Prometheus. The collector queries the databases directly for the same window:

```sql
SELECT COUNT(*) FROM order_requests WHERE created_at >= $1 AND created_at < $2;
```

In this project both databases are simulated in `src/sources/simulatedDatabases.js` — realistic latency, a daily traffic curve, random bursts and occasional failures. Replace `ordersDb.countBetween` and `chatsDb.countBetween` with your real queries.

### Rounding

Percentages are stored as whole numbers (71.38 → 71). For one decimal, change `toPercent` in `src/services/prometheus.js`.

---

## 4. The stored record

One record per node per minute, plus one counts record per minute. A 4-node cluster writes 5 records a minute:

```json
{ "datetime": "…T14:05:00Z", "meta": { "cluster": "backend", "node": "10.0.0.12:9100" }, "cpuUsage": 71, "memoryUsage": 60, "orders": null, "chats": null }
{ "datetime": "…T14:05:00Z", "meta": { "cluster": "backend", "node": "10.0.0.13:9100" }, "cpuUsage": 44, "memoryUsage": 58, "orders": null, "chats": null }
{ "datetime": "…T14:05:00Z", "meta": { "cluster": "workers", "node": "10.0.1.20:9100" }, "cpuUsage": 39, "memoryUsage": 61, "orders": null, "chats": null }
{ "datetime": "…T14:05:00Z", "meta": { "cluster": "__cluster__", "node": "__cluster__" }, "cpuUsage": null, "memoryUsage": null, "orders": 100, "chats": 500 }
```

| Field | Type | Meaning |
|---|---|---|
| `datetime` | Date (BSON `ISODate`, UTC) | Start of the minute covered, `[14:05:00, 14:06:00)` |
| `meta.cluster` | String | From the target's `cluster` label (or its job name); `__cluster__` on the counts record |
| `meta.node` | String | The node_exporter target, e.g. `10.0.0.12:9100`; `__cluster__` on the counts record |
| `cpuUsage` | Number 0–100 | Average % of that node's CPU used during the minute |
| `memoryUsage` | Number 0–100 | % of that node's RAM in use at the end of the minute |
| `orders` | Number | Order requests in that minute, system-wide |
| `chats` | Number | Chats sent in that minute, system-wide |

### Why orders and chats live in their own record

CPU belongs to a machine. Orders don't — a request is served by one node, but the count comes from the database, which knows nothing about nodes. Repeating the counts on every node's record would multiply your totals by the node count.

So they're stored once, and the fields that don't apply are `null`. That's what makes the aggregation work with **no special cases**: `$avg` skips the nulls in the counts record, `$sum` skips the nulls in the node records. One pipeline produces both the cluster average and the correct totals.

### Why a time-series collection

`heartbeats` is a MongoDB **time-series collection** (6.0+). It's the same MongoDB, same driver, same Mongoose — only the storage differs: records are grouped into compressed buckets by `meta` and time.

- **`timeField: datetime`** — required, must be a real Date, never a string
- **`metaField: meta`** — the `{cluster, node}` pair; MongoDB keeps each node's records together on disk
- **`granularity: seconds`** and a TTL of `RETENTION_DAYS`, so old records expire on their own

A full minute of a 5-node cluster is ~6 records; a day is ~8,600; a month ~260,000, compressed.

**Flexible:** adding or removing nodes and clusters needs no change at all — a new `meta` value simply starts new buckets. Proven live: a sixth node appeared in the dashboard one minute after being added to `prometheus.yml`, with no restart and no database change.

**Not flexible:** `timeField`, `metaField` and `granularity` are fixed when the collection is created. Changing them means dropping and re-creating it. Retention is the exception:

```js
db.runCommand({ collMod: "heartbeats", expireAfterSeconds: 7776000 })
```

`src/db.js` creates the collection with the right options on first run, and refuses to start if it finds a normal collection or an old-format one — with the command to fix it.

---

## 5. Clusters and nodes

A cluster is a label on your Prometheus targets. Nothing is hardcoded in this project.

```yaml
- job_name: node
  static_configs:
    # One block per node, so each carries its own name. Setting `instance` overrides the default
    # (the target address), so records are stored under a friendly, stable name.
    - targets: ['10.0.0.12:9100']
      labels: { cluster: backend, instance: backend-1 }
    - targets: ['10.0.0.13:9100']
      labels: { cluster: backend, instance: backend-2 }
    - targets: ['10.0.1.20:9100']
      labels: { cluster: workers, instance: worker-1 }
```

Sharing one block between targets also works when you don't care about names — then `instance` is
the address, and the nodes appear as `10.0.0.12:9100`.

- A target with no `cluster` label falls back to its **job name**, so a job per cluster works too. `NODE_EXPORTER_JOB` is matched as a regex, so `node|workers` covers several jobs.
- Nodes are **discovered from the query result**, not from a list. `avg by (instance, job, cluster)` returns one series per node, and the collector writes whatever came back.
- `NODE_EXPORTER_INSTANCE` narrows everything to a single machine when set.
- Removing a node needs nothing either: its records simply stop. It stays in the picker for 7 days, then its history expires with the retention window.

**Naming matters.** The stored node name is Prometheus's `instance` label. Left at its default, that's the target address, so an IP or port change looks like a brand-new node and the history splits. Setting `instance` to a stable name (`backend-1`) avoids that: the address can change freely underneath it.

**Renaming later** takes two steps — change `prometheus.yml` for new records, then rewrite the old ones:

```js
db.heartbeats.updateMany({ "meta.node": "10.0.0.12:9100" }, { $set: { "meta.node": "backend-1" } })
```

Two MongoDB rules to know here: an update on a time-series collection can only filter by the
`metaField`, so you cannot scope a rename to a time range — it rewrites that node's whole history.
And during Prometheus's 5-minute lookback both names report, so a few minutes end up with two
records for the same node and minute. Harmless (their values are near-identical and the average
absorbs them), but if you want none, relabel, wait 5 minutes, then rename.

---

## 6. The API

### `GET /api/heartbeats`

The main query: aggregated points for the charts, plus totals for the range.

| Parameter | Default | Meaning |
|---|---|---|
| `from` | 1h before `to` | ISO-8601, e.g. `2026-09-17T08:00:00Z` |
| `to` | now | ISO-8601 |
| `cluster` | `all` | One cluster name, or `all` |
| `node` | `all` | One node (`10.0.0.12:9100`), a comma-separated list, or `all` |
| `bucket` | `auto` | Grouping: `1m 5m 15m 1h 6h 1d 1w 1mo`. `auto` picks the smallest bucket that keeps the result under 1,500 points; nothing finer than the heartbeat interval is offered, and a bucket too fine for the range is raised automatically |
| `tz` | `REPORT_TIMEZONE` | IANA timezone for day/week/month grouping |
| `perNode` | off | `1` adds a `series` array: one entry per node, busiest first |

Maximum range: 3 years. Weeks start on `WEEK_START`.

```bash
curl "http://localhost:3000/api/heartbeats?from=2026-09-17T08:00:00Z&to=2026-09-17T09:00:00Z&cluster=backend&tz=Africa/Cairo"
```

```json
{
  "from": "2026-09-17T08:00:00.000Z",
  "to": "2026-09-17T09:00:00.000Z",
  "cluster": "backend",
  "node": "all",
  "bucket": "1m",
  "bucketLabel": "minute",
  "bucketMs": 60000,
  "timezone": "Africa/Cairo",
  "count": 60,
  "totals": { "orders": 18342, "chats": 76120, "avgCpuUsage": 31.2, "maxCpuUsage": 71,
              "avgMemoryUsage": 58.4, "maxMemoryUsage": 60, "samples": 60, "nodeCount": 4 },
  "points": [
    { "datetime": "2026-09-17T08:00:00.000Z", "cpuUsage": 30.1, "cpuUsageMax": 41,
      "memoryUsage": 58.2, "memoryUsageMax": 59, "orders": 311, "chats": 1290,
      "samples": 1, "nodeCount": 4 }
  ]
}
```

Inside a point: `cpuUsage` / `memoryUsage` are averaged across the selected nodes and across the bucket, `…Max` is the highest single record, `orders` / `chats` are summed, `samples` counts the heartbeats, and `nodeCount` is how many nodes contributed.

**How the filtering works.** The counts record must survive every filter, or the order totals would vanish whenever you pick a node. So the match is:

```js
match.$or = [ { $and: scope }, { 'meta.node': CLUSTER_NODE } ];
```

where `scope` holds the cluster and node conditions. Selecting nodes changes the CPU average; it never changes the business counts.

### `GET /api/heartbeats?…&perNode=1`

Adds a second result set, from its own aggregation:

```json
"series": [
  { "node": "10.0.0.12:9100", "cluster": "backend", "avgCpuUsage": 44.2, "avgMemoryUsage": 82.2,
    "points": [ { "datetime": "…", "cpuUsage": 45.1, "memoryUsage": 82 } ] }
]
```

### `GET /api/heartbeats/clusters`

Clusters that reported in the last 7 days.

### `GET /api/heartbeats/nodes?cluster=backend`

Nodes that reported in the last 7 days, optionally within one cluster. Returns `groups` (`[{ cluster, nodes }]`, which is how the picker groups them) and a flat `nodes` list. The 7-day window means a node that is briefly down doesn't disappear from the picker.

### `GET /api/maintenance/cluster-drift` · `POST /api/maintenance/sync-clusters`

Behind the dashboard's **Sync clusters** button. The GET reports which nodes report a different
cluster in Prometheus than the one stored on their old records; the POST rewrites those records
(`meta.cluster`) so a node's history follows it to its new cluster.

The POST re-scans rather than trusting the request, so it can only ever set a cluster Prometheus is
reporting right now. Only the **cluster** can be synced this way: a node is matched by its address,
so if the address itself changed, Prometheus has no way to say which old node it used to be and
those records are left alone — rename them by hand if you want the history joined up:

```js
db.heartbeats.updateMany({ "meta.node": "10.0.0.12:9100" }, { $set: { "meta.node": "orders-api-1:9100" } })
```

### `GET /api/heartbeats/latest?limit=60`

The last N raw records, oldest first, exactly as stored.

### `GET /api/buckets` · `GET /health`

The grouping options with the heartbeat interval and timezone; and a liveness check.

---

## 7. The dashboard

`public/index.html` — one self-contained page, no build step, Chart.js from a CDN.

**Controls**

- **From / To** — native date-time pickers, in your own timezone, sent to the API as UTC
- **Cluster** — all clusters, or one; changing it reloads the node list
- **Nodes** — a checkbox list grouped by cluster: each cluster is a heading whose checkbox ticks all of its nodes (half-ticked when only some are). Tick any set and the charts average just those. The button shows *All nodes*, *3 of 5 nodes*, or the node's name. Unticking everything means all of them again
- **Presets** — 1h, 24h, 7d, 30d, 1y
- **Live (30s)** — re-queries on a rolling window
- **Sync clusters** — after you move a node to another cluster in `prometheus.yml`, this shows what
  changed and updates the stored history to match, so old records follow the node

**Charts**

| Card | Shows |
|---|---|
| Server CPU (%) | Average across the selected nodes |
| Server memory used (%) | Same, for memory |
| CPU by node (%) | One line per node, busiest first |
| Memory by node (%) | Same, for memory |
| Order requests & chats | Counts per bucket, always system-wide |

The per-node charts appear when more than one node is in play — with a single node they'd just repeat the chart above. Up to 8 nodes are drawn (8 distinguishable hues); beyond that the busiest 8 are shown and the subtitle says how many were left out.

**Details worth knowing**

- The grouping is chosen automatically from the range, and the axis and tooltips follow it: `1:25 pm` for minutes, `Mon, Sep 7, 2026` for days, `Week of 9/7 – 9/13`, `September 2026`.
- Times are always shown on a 12-hour clock, whatever the browser's locale.
- Missing buckets break the line instead of bridging the gap, so an outage looks like an outage.
- Requests carry a sequence number; a slow earlier response can't overwrite a newer one.
- Light and dark themes follow the OS; a data table under the charts gives the raw numbers.

---

## 8. Running it

Requirements: Node 18+, Docker (for MongoDB and Prometheus locally).

```bash
npm install
cp .env.example .env          # set REPORT_TIMEZONE, e.g. Africa/Cairo

docker compose up -d          # MongoDB, Prometheus, and 6 node-exporter containers (local cluster)
npm run seed -- 48            # optional: 48h of history for the nodes Prometheus knows about
npm start                     # collector + API + dashboard
```

Open http://localhost:3000. Prometheus targets: http://localhost:9090/targets.

**Against your real cluster:** delete the `node-exporter*` services from `docker-compose.yml`, put your nodes in `prometheus/prometheus.yml` with their `cluster` labels, and point `PROMETHEUS_URL` at your Prometheus.

`npm run seed` asks Prometheus which targets exist and generates history under those real node names, so seeded and live records share one set of nodes. It refuses to run twice over the same range, which would double every count.

---

## 9. Configuration

Everything lives in `.env` (see `.env.example`).

| Variable | Default | Notes |
|---|---|---|
| `PORT` | 3000 | API + dashboard |
| `MONGO_URI` | `mongodb://localhost:27017/heartbeat` | MongoDB 6.0+ |
| `PROMETHEUS_URL` | `http://localhost:9090` | |
| `PROMETHEUS_TIMEOUT_MS` | 800 | Per query; a timeout saves `null`, not a failed record |
| `NODE_EXPORTER_JOB` | `node` | Matched as a regex, so `node|workers` works |
| `NODE_EXPORTER_INSTANCE` | empty | Empty = every node; set = one machine |
| `DEFAULT_CLUSTER` | `default` | Used when a target has neither a `cluster` label nor a job |
| `CPU_RATE_WINDOW` | = heartbeat | Must contain 2+ scrapes |
| `CPU_QUERY`, `MEMORY_PERCENT_QUERY` | generated | Override the PromQL entirely |
| `HEARTBEAT_CRON` | `* * * * *` | |
| `HEARTBEAT_INTERVAL_MS` | 60000 | Whole minutes, must match the cron |
| `REPORT_TIMEZONE` | `UTC` | Day/week/month grouping |
| `WEEK_START` | `monday` | `monday` / `sunday` / `saturday` |
| `RETENTION_DAYS` | 30 | TTL, applied when the collection is created |
| `RUN_COLLECTOR` | on | Set `false` on extra API replicas |

---

## 10. Project layout

| File | Purpose |
|---|---|
| `src/server.js` | Express app, static dashboard, starts the collector |
| `src/config.js` | Settings, and the PromQL built from them |
| `src/db.js` | Connects, creates the time-series collection, validates its shape |
| `src/models/Heartbeat.js` | Schema, `meta` metaField, TTL, `CLUSTER_NODE` marker |
| `src/services/prometheus.js` | PromQL over HTTP, returns one entry per cluster/node |
| `src/services/collector.js` | The cron heartbeat: gather in parallel, insert |
| `src/sources/simulatedDatabases.js` | Stand-in orders and chats databases — replace these |
| `src/routes/heartbeats.js` | The API: buckets, filters, aggregations |
| `public/index.html` | The dashboard |
| `scripts/seed.js` | Historical data for real, discovered nodes |
| `prometheus/prometheus.yml` | Scrape targets, grouped into clusters |
| `docker-compose.yml` | MongoDB, Prometheus, local node-exporters |
| `docs/HOW-DATA-IS-COLLECTED.md` | The four hops, with real requests and responses |

---

## 11. Going to production

- **Real databases.** Replace the two simulated clients. Index `created_at`. At high traffic, don't run `COUNT` every minute — increment a counter as orders and chats are created (for example Redis `INCR hb:orders:<minute>`) and read it in the collector.
- **One collector.** The heartbeat lives inside the API process. With several replicas, run it in exactly one: `RUN_COLLECTOR=false` on the others, or a dedicated worker.
- **Scrape interval.** The CPU window needs 2+ scrapes. 15s is ideal; slower than 30s means a longer heartbeat.
- **First record after a restart.** If Prometheus has fewer than two samples in the window, `rate()` returns nothing and that record's `cpuUsage` is `null`. The next one is fine.
- **After relabeling.** Click **Sync clusters** in the dashboard (or `POST /api/maintenance/sync-clusters`) so old records follow the node to its new cluster. Wait out Prometheus's 5-minute lookback first; the scan already prefers the freshest series (`timestamp(up{…})`), but the collector may still write a few records under the old label during the overlap.
- **Relabeling a live cluster.** Prometheus keeps returning the old series for ~5 minutes (its lookback window), so you may briefly get records under both the old and new names. Wait it out before seeding.
- **Security.** node_exporter has no authentication — let only Prometheus reach port 9100.
- **Long-term history.** Raw records expire after `RETENTION_DAYS`. For years of data, write hourly or daily rollups into a normal collection with a scheduled `$merge` and keep those forever.
