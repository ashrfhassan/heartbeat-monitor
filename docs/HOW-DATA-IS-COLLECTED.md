# How the data is collected

The backend app doesn't expose anything, and the collector never talks to node_exporter. Data moves in separate hops, and each program only talks to its neighbour.

```
 BACKEND SERVER                  PROMETHEUS SERVER                 HEARTBEAT SERVICE (this project)
┌──────────────────┐   ① pull    ┌──────────────────┐   ② PromQL    ┌───────────────────┐
│ node_exporter    │ ◄────────── │ Prometheus       │ ◄──────────── │ collector (cron)  │
│ :9100/metrics    │  every 15s  │ stores history   │  every minute │                   │
└──────────────────┘             └──────────────────┘               │                   │ ③ COUNT
 your backend app                                                   │                   │ ─────────► orders DB
 (not involved)                                                     │                   │ ─────────► chats DB
                                                                    │                   │ ④ insert
                                                                    └───────────────────┘ ─────────► MongoDB
```

| Hop | Who starts it | How often | Where it's configured |
|---|---|---|---|
| ① node_exporter → Prometheus | Prometheus (pull) | every 15s | `prometheus/prometheus.yml` |
| ② Prometheus → collector | collector (cron `* * * * *`) | every minute | `src/services/prometheus.js`, queries in `src/config.js` |
| ③ Orders/chats DBs → collector | collector | every minute | `src/sources/simulatedDatabases.js` |
| ④ collector → MongoDB | collector | every minute | `src/services/collector.js`, `src/models/Heartbeat.js` |

---

## ① node_exporter → Prometheus (Prometheus pulls)

**node_exporter** is a small program that runs on the backend server. It reads the Linux kernel's own counters (`/proc/stat` for CPU, `/proc/meminfo` for memory) and serves them as plain text at `http://<server>:9100/metrics`:

```
node_cpu_seconds_total{cpu="0",mode="idle"} 793.49
node_cpu_seconds_total{cpu="1",mode="idle"} 803.51
node_memory_MemTotal_bytes 8.4222976e+09
node_memory_MemAvailable_bytes 7.804715008e+09
```

It **calculates nothing and remembers nothing**. It only reports the current values when asked. The CPU values are running totals: seconds each core has spent idle since boot.

**Prometheus** asks every 15 seconds, because `prometheus/prometheus.yml` tells it to scrape that address:

```yaml
- job_name: node
  scrape_interval: 15s          # the Prometheus default; 4 samples per one-minute record
  static_configs:
    - targets: ['<backend-server-ip>:9100']
```

This is a **pull** model: node_exporter never sends anything on its own. Prometheus saves each reading with a timestamp in its time-series database, so it builds up a history like:

```
14:05:00  idle(cpu0)=793.49
14:05:15  idle(cpu0)=804.99
14:05:30  idle(cpu0)=816.52
14:05:45  idle(cpu0)=828.01
14:06:00  idle(cpu0)=839.49
```

You can check Prometheus is scraping the server at `http://<prometheus>:9090/targets`. The target should show **UP**.

---

## ② Collector → Prometheus (we ask)

Every minute, a `node-cron` job in the collector sends an HTTP request to **Prometheus**, not to node_exporter:

```
GET http://prometheus:9090/api/v1/query
    ?query=100 * (1 - avg by (instance) (rate(node_cpu_seconds_total{job="node",mode="idle"}[1m])))
    &time=2026-09-17T14:06:00Z
```

Prometheus uses the samples it already stored for **14:05:00–14:06:00** to answer:

1. `rate(...[1m])`: idle seconds gained per real second, for each core
2. `avg by (instance)`: the average across all cores of that server
3. `100 * (1 - …)`: converts idle into a usage percentage

It returns a single number:

```json
{
  "status": "success",
  "data": {
    "resultType": "vector",
    "result": [
      { "metric": { "instance": "10.0.0.12:9100" }, "value": [1789653935, "71.38"] }
    ]
  }
}
```

The collector takes `71.38` and saves it as `71`. Memory works the same way with this query:

```
100 * (1 - node_memory_MemAvailable_bytes / node_memory_MemTotal_bytes)
```

Memory isn't a rate, so Prometheus returns the latest reading at 14:06:00.

If Prometheus has fewer than 2 samples in the window — right after it starts, or if the target is down — `rate()` returns nothing and that record's `cpuUsage` is saved as `null`.

For the full math with a worked example, see [How CPU and memory % are calculated](../README.md#how-cpu-and-memory--are-calculated) in the README.

---

## ③ Collector → your databases

Orders and chats **don't go through Prometheus**. The collector queries those databases directly for the same minute:

```sql
-- orders DB (example)
SELECT COUNT(*) FROM order_requests
WHERE created_at >= '2026-09-17 14:05:00' AND created_at < '2026-09-17 14:06:00';
```

```js
// chats DB (example)
db.messages.countDocuments({ createdAt: { $gte: from, $lt: to } });
```

In this sample, both databases are simulated in `src/sources/simulatedDatabases.js`.

---

## ④ Collector → MongoDB

The collector runs ②, the memory query and the two ③ counts **in parallel**, waits for all of them, and inserts one record:

```json
{
  "datetime": "2026-09-17T14:05:00.000Z",
  "cpuUsage": 71,
  "memoryUsage": 60,
  "orders": 100,
  "chats": 500
}
```

If one source fails, only that field is saved as `null`, and the rest of the record is still stored.

---

## One heartbeat, step by step

```
14:05:00.000  ─┐
14:05:15       │  Prometheus scrapes node_exporter every 15s (4 samples in this minute)
14:05:30       │  orders and chats happen in your app and are written to their DBs
14:05:45       │
14:06:00.000  ─┘  cron fires for window [14:05:00, 14:06:00)
   │
   ├─► Prometheus: CPU rate over [1m] at 14:06:00      → 71.38 → 71
   ├─► Prometheus: memory at 14:06:00                  → 60.12 → 60
   ├─► orders DB: count in [14:05:00, 14:06:00)        → 100
   ├─► chats DB:  count in [14:05:00, 14:06:00)        → 500
   │
   └─► MongoDB insert { datetime: 14:05:00, cpuUsage: 71, memoryUsage: 60, orders: 100, chats: 500 }
       (about 20–50 ms after 14:06:00, then the next minute starts)
```

---

## Could the collector skip Prometheus and read node_exporter directly?

Yes. It could fetch `:9100/metrics` once a minute and do the math itself:

```
cpu idle % = (idle now − idle 1 minute ago) / (60 seconds × number of cores)
cpu usage % = 100 − cpu idle %
```

In the sample, Prometheus does it for good reasons:

| Collector reads node_exporter directly | Through Prometheus (what this project does) |
|---|---|
| You parse the text format and keep the previous reading in memory | Prometheus stores all the readings |
| If the collector restarts, the first record after it has no CPU value (no previous reading) | A restart doesn't matter, because the history is already in Prometheus |
| You handle edge cases yourself, like counters resetting when the server reboots | `rate()` handles them |
| Port 9100 must be open to the collector too | Only Prometheus needs to reach the server |
| Adding more servers means changing collector code | You add a target in `prometheus.yml` and adjust the query |

Going direct makes sense if you had no Prometheus at all. Since you already run one, and it may also feed Grafana and alerts, reading from it keeps one source of truth and keeps the collector simple.
