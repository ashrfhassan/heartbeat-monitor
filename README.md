# Heartbeat monitor

Every minute, on a **cron schedule** (`HEARTBEAT_CRON`, default `* * * * *`), this service:

1. Queries **Prometheus** for the CPU % and memory of **every backend node**. Each node runs **node_exporter**, and Prometheus scrapes them all.
2. Counts **order requests** in the orders DB and **chats** in the chats DB for that minute. Both databases are simulated.
3. Saves one record to a **MongoDB time-series collection**

A REST API and a dashboard with a date/time picker then chart the data.

**How the data gets from node_exporter to MongoDB, hop by hop:** [docs/HOW-DATA-IS-COLLECTED.md](docs/HOW-DATA-IS-COLLECTED.md)

```
 backend server                     monitoring
┌──────────────────┐  scrape 15s ┌────────────┐
│ node_exporter    │ ◄────────── │ Prometheus │
│ :9100/metrics    │             └─────▲──────┘
└──────────────────┘                   │ PromQL over HTTP (/api/v1/query)
                                       │
┌──────────────┐  COUNT()     ┌────────┴───────┐  insert 1/s  ┌──────────────────────┐
│ orders DB    │ ◄─────────── │   collector    │ ───────────► │ MongoDB (time-series)│
│ chats DB     │              │  (server.js)   │              │   heartbeats         │
└──────────────┘              └────────┬───────┘              └──────────▲───────────┘
   (simulated)                         │ Express                         │ $dateTrunc
                                       ▼                                 │
                            GET /api/heartbeats ─────────────────────────┘
                                       ▲
                               dashboard (public/index.html)
```

## Connect to your backend server's node_exporter

1. Check node_exporter is reachable from the Prometheus machine:
   ```bash
   curl http://<backend-server-ip>:9100/metrics | grep node_cpu_seconds_total | head
   ```
2. Add it to `prometheus/prometheus.yml` (or to your existing Prometheus config) and reload Prometheus. The usual 15s scrape is enough:
   ```yaml
   - job_name: node
     static_configs:
       - targets: ['<backend-server-ip>:9100']
   ```
3. Check http://<prometheus>:9090/targets shows it as **UP**.
4. Set `.env`:
   ```env
   PROMETHEUS_URL=http://<prometheus>:9090
   NODE_EXPORTER_JOB=node
   NODE_EXPORTER_INSTANCE=<backend-server-ip>:9100
   ```

`src/config.js` builds the CPU and memory queries from those values. The next section explains how they work.

If the query matches more than one server, the collector logs an error instead of picking one at random. Set `NODE_EXPORTER_INSTANCE` to choose which server.

## Clusters and nodes

List every node in the Prometheus job, grouped by a `cluster` label, and leave `NODE_EXPORTER_INSTANCE` empty:

```yaml
- job_name: node
  static_configs:
    - targets: ['10.0.0.12:9100', '10.0.0.13:9100', '10.0.0.14:9100']
      labels: { cluster: backend }
    - targets: ['10.0.1.20:9100', '10.0.1.21:9100']
      labels: { cluster: workers }
```

A target without a `cluster` label falls back to its job name, so `NODE_EXPORTER_JOB=node|workers` works too (the job is matched as a regex). Each record stores `meta: { cluster, node }`, and the dashboard filters by cluster first, then by nodes inside it.

The collector then queries `avg by (instance)`, gets one series per node, and writes one record per node per minute. Nodes are discovered from the query result, so adding a machine to `prometheus.yml` is enough — no code or config change here. Setting `NODE_EXPORTER_INSTANCE` to one address narrows it back to a single machine.

In the dashboard, **Cluster** narrows to one cluster (or all of them), and the **Nodes** picker then lists that cluster's machines as a checkbox list: tick any set and the charts average just those. Unticking everything means all of them again. Changing the cluster reloads the node list.

On *All nodes* you get both views: the **Server CPU / memory** charts show the cluster average, and **CPU by node / Memory by node** draw one line per machine underneath, so a single hot node is obvious instead of being flattened into the average. Up to 8 nodes are drawn (the palette has 8 distinguishable hues); past that the busiest 8 are shown and the subtitle says how many were left out.

`scripts/seed.js` asks Prometheus which targets exist and seeds history for those real node names, so seeded and live records share one set of nodes.

## How CPU and memory % are calculated

node_exporter doesn't report percentages. It reports raw counters, and the percentage is computed from them with PromQL.

### CPU usage %

node_exporter reports, for **each core**, the total seconds that core has spent in each mode since boot (`idle`, `user`, `system`, `iowait`…):

```
node_cpu_seconds_total{cpu="0",mode="idle"} 793.49
node_cpu_seconds_total{cpu="1",mode="idle"} 803.51
```

The calculation has three steps:

1. **Idle rate per core:** how many idle seconds the core gained per real second over the record's minute. The PromQL is `rate(...[1m])`, queried at the end of the minute.
2. **Average over all cores:** `avg by (instance)`.
3. **Usage = 100 − idle %.**

```
cpuUsage = 100 * (1 - avg by (instance) (rate(node_cpu_seconds_total{mode="idle"}[1m])))
```

**Real example** from testing this project on a 2-core machine:

| Core | Idle counter | Over | Idle % |
|---|---|---|---|
| cpu 0 | 793.49 s → 797.33 s (+3.84 s) | 4 s | 96.0 % |
| cpu 1 | 803.51 s → 807.43 s (+3.92 s) | 4 s | 98.0 % |
| **Average** | | | **97.0 % idle** |

`cpuUsage = 100 − 97 = 3%`. Calculating it by hand gave the same 3.00% as the PromQL query.

With 71% usage, the cores were idle 29% of the time on average. This covers every process on the server, not only your app.

### Why records are every minute, and why cron

CPU usage is a **rate**, so it can only be measured between two readings. Prometheus needs at least 2 scrapes inside the window, so the heartbeat interval has to be comfortably longer than the scrape interval. One minute fits the standard 15s scrape (4 samples per record) with no special Prometheus config.

The collector runs on a **cron schedule** (`node-cron`, `* * * * *`), so runs land on the top of each minute. The CPU window is set to the same minute (`CPU_RATE_WINDOW` defaults to the heartbeat interval), so CPU, orders and chats all describe **exactly the same period**.

This was checked by burning one of the 2 test cores for exactly 17:36:00–17:37:00 UTC, with Prometheus scraping every 15s:

| datetime (UTC) | cpuUsage | orders | chats |
|---|---|---|---|
| 17:35:00 | 2% | 90 | 395 |
| **17:36:00** | **51%** | 86 | 362 |
| 17:37:00 | 1% | 95 | 395 |

One busy core out of two is about 50%, and the load appeared only in the record for that minute.

The rules:

- `scrape_interval` must be **half the heartbeat or less**: 15s (4 samples per minute) or 30s at the slowest.
- `HEARTBEAT_CRON` and `HEARTBEAT_INTERVAL_MS` must agree: `* * * * *` with 60000, `*/5 * * * *` with 300000.

### Memory usage %

```
node_memory_MemTotal_bytes      8422297600   (8032 MB)
node_memory_MemAvailable_bytes  7804715008   (7443 MB)

memoryUsage = 100 * (1 - MemAvailable / MemTotal) = 100 * (1 - 7443 / 8032) = 7.34%  → saved as 7
```

This uses **MemAvailable**, not MemFree. Linux fills spare RAM with file cache and frees it the moment an app needs memory. Counting that cache as "used" would show 90%+ on a perfectly healthy server. MemAvailable is the memory apps can actually still get, so the result matches `free -m`: `total − available`.

With 60% memory usage, 60% of RAM is held by processes and can't be reclaimed, and 40% is still available to them.

### Rounding

Both values are saved as whole numbers, e.g. 71.38 → **71**. To keep one decimal, change `toPercent` in `src/services/prometheus.js` to `Math.round(v * 10) / 10`.

## Run it locally

Requirements: Node 18+, Docker.

Set `REPORT_TIMEZONE` in `.env` (for example `Africa/Cairo`) so day/week/month grouping follows your calendar rather than UTC.

```bash
npm install
cp .env.example .env

docker compose up -d        # MongoDB 7, Prometheus, and a local node-exporter
npm run seed -- 48          # optional: 48h of history for the nodes Prometheus knows about
npm start                   # collector + API + dashboard
```

Open http://localhost:3000. With a real server, remove the `node-exporter` service from `docker-compose.yml` and follow the steps above.

## Project layout

| File | Purpose |
|---|---|
| `src/config.js` | Settings, including the PromQL queries built from the node_exporter job and instance |
| `src/services/prometheus.js` | Instant PromQL queries through `GET /api/v1/query`, run in parallel |
| `src/sources/simulatedDatabases.js` | Two fake DBs (`ordersDb`, `chatsDb`) with latency, a daily traffic curve, bursts and rare failures |
| `src/services/collector.js` | The heartbeat: a `node-cron` job at the top of each minute, all sources queried in parallel, a failed source is saved as `null` |
| `src/models/Heartbeat.js` | Mongoose schema with `timeseries` options and TTL |
| `src/db.js` | Connects and creates the time-series collection, and refuses to run on a normal collection with the same name |
| `src/routes/heartbeats.js` | Dashboard API |
| `public/index.html` | Dashboard: date/time pickers, presets, live mode, KPIs, charts, data table |
| `scripts/seed.js` | Generates historical data |
| `docs/HOW-DATA-IS-COLLECTED.md` | How the data flows: node_exporter → Prometheus → collector → MongoDB |

## Stored record

One record per minute:

With a 3-node cluster, each minute writes 3 node records plus 1 cluster record:

```json
{ "datetime": "…T14:05:00Z", "meta": { "cluster": "backend", "node": "10.0.0.12:9100" }, "cpuUsage": 71, "memoryUsage": 60, "orders": null, "chats": null }
{ "datetime": "…T14:05:00Z", "meta": { "cluster": "backend", "node": "10.0.0.13:9100" }, "cpuUsage": 44, "memoryUsage": 58, "orders": null, "chats": null }
{ "datetime": "…T14:05:00Z", "meta": { "cluster": "workers", "node": "10.0.1.20:9100" }, "cpuUsage": 39, "memoryUsage": 61, "orders": null, "chats": null }
{ "datetime": "…T14:05:00Z", "meta": { "cluster": "__cluster__", "node": "__cluster__" }, "cpuUsage": null, "memoryUsage": null, "orders": 100, "chats": 500 }
```

CPU and memory belong to one machine; orders and chats belong to the whole cluster, so they are stored once instead of being repeated on every node's record (which would multiply the totals by the node count). The unused fields are `null`, which is what makes the aggregation work with no special cases: `$avg` skips the nulls in the cluster record, `$sum` skips the nulls in the node records.

| Field | Type | Meaning |
|---|---|---|
| `datetime` | Date (BSON `ISODate`, UTC) | Start of the minute the record covers, `[14:05:00, 14:06:00)` |
| `meta.cluster` | String | Cluster name from the target's `cluster` label (or its job), `__cluster__` on the counts record |
| `meta.node` | String | The node_exporter target (`10.0.0.12:9100`), or `__cluster__`. `meta` is the collection's `metaField`. |
| `cpuUsage` | Number 0–100 | Average % of that node's CPU in use during the minute, all cores together |
| `memoryUsage` | Number 0–100 | % of the server's RAM in use |
| `orders` | Number | Order requests created during that minute, cluster-wide |
| `chats` | Number | Chats sent during that minute, cluster-wide |

A source that fails for that interval is saved as `null`, so a failure is never recorded as 0.

In `mongosh` the record looks like `datetime: ISODate('2026-09-17T14:05:00.000Z')`. `datetime` must be a real Date, not a string: time-series collections require it, and it's what makes range queries and date grouping work. Format it only for display. For example, `new Date(datetime).toLocaleString()` in the dashboard shows it in the viewer's timezone (Cairo is UTC+3 → 5:05 PM).

## API

### `GET /api/heartbeats`

| Query | Default | Notes |
|---|---|---|
| `from` | 1h before `to` | ISO-8601, e.g. `2026-09-17T08:00:00Z` |
| `to` | now | ISO-8601 |
| `bucket` | `auto` | Grouping: `1m 5m 15m 1h 6h 1d 1w 1mo` (minute … month). Nothing finer than the heartbeat interval is offered. `auto` picks the smallest bucket that keeps the result at 1,500 points or fewer, and a bucket too fine for the range is raised automatically. | The dashboard always sends `auto`.
| `cluster` | `all` | One cluster name, or `all`. |
| `node` | `all` | `all` averages CPU/memory across every node. One address (`10.0.0.12:9100`) shows that machine; a comma-separated list (`10.0.0.12:9100,10.0.0.13:9100`) averages just those. Orders and chats are cluster-wide either way. |
| `perNode` | off | `1` adds a `series` array to the response: one entry per node with its own points, sorted busiest first. Used for the per-node charts. |
| `tz` | `REPORT_TIMEZONE` | IANA timezone used for day/week/month grouping, e.g. `Africa/Cairo`. A "day" is then a local day (Cairo days start at 21:00 UTC the day before). The dashboard sends the viewer's own timezone. |

Max range is 3 years. Weeks start on `WEEK_START` (`monday` by default; `saturday` is the common week start in Egypt).

```bash
curl "http://localhost:3000/api/heartbeats?from=2026-09-17T08:00:00Z&to=2026-09-17T09:00:00Z&bucket=1m"
```

```json
{
  "from": "2026-09-17T08:00:00.000Z",
  "to": "2026-09-17T09:00:00.000Z",
  "bucket": "1m",
  "bucketLabel": "minute",
  "bucketMs": 60000,
  "timezone": "Africa/Cairo",
  "count": 60,
  "totals": { "orders": 18342, "chats": 76120, "avgCpuUsage": 31.2, "maxCpuUsage": 71, "avgMemoryUsage": 58.4, "maxMemoryUsage": 60, "samples": 3600 },
  "points": [
    { "datetime": "2026-09-17T08:00:00.000Z", "cpuUsage": 30.1, "cpuUsageMax": 41, "memoryUsage": 58.2, "memoryUsageMax": 59, "orders": 311, "chats": 1290, "samples": 60 }
  ]
}
```

Each point groups the per-minute records inside it — a `1d` point is one calendar day in `tz`, `1w` a calendar week, `1mo` a calendar month (`bucketMs` for a month is only the average length, used to rank the options). `cpuUsage` and `memoryUsage` are the average over the bucket, and `…Max` is the highest record. `orders` and `chats` are summed.

### `GET /api/heartbeats/clusters`

The clusters that reported in the last 7 days.

### `GET /api/heartbeats/nodes?cluster=backend`

The nodes that reported in the last 7 days, optionally within one cluster.

### `GET /api/heartbeats/latest?limit=60`

Returns the last N raw records, oldest first, in exactly the stored shape shown above.

## Going to production

- **Scrape interval:** the CPU window (1 minute) must contain at least 2 scrapes. The usual 15s interval gives 4, so no special job is needed. Anything slower than 30s needs a longer heartbeat.
- **First record after a restart:** if Prometheus has fewer than 2 samples in the window (for example it just started), `rate()` returns nothing and that record's `cpuUsage` is `null`. The next one is fine.
- **Real databases:** replace `ordersDb.countBetween` and `chatsDb.countBetween` with real queries, and index the `created_at` column. At high traffic, avoid running `COUNT` on every heartbeat. Increment a counter (for example Redis `INCR hb:orders:<epochSecond>`) when an order or chat is created, and read it in the collector.
- **Several API instances:** run the collector in exactly one process. Set `RUN_COLLECTOR=false` on the others, or move it to its own worker.
- **Security:** node_exporter has no authentication. Let only the Prometheus machine reach port 9100 (firewall or security group).
- **Retention:** raw records expire after `RETENTION_DAYS`. The TTL is set when the collection is created, so change it later with `db.runCommand({ collMod: "heartbeats", expireAfterSeconds: N })`.
