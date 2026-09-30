# Plan: move Heartbeat Monitor into `backend` + `dashboard`, driven by the devops Prometheus

> Status (2026-09-30): **Phases 0–9 implemented** on branch `feature/monitoring` in `devops`, `backend`, `dashboard` (uncommitted).
> Verified: Ansible/Prometheus templates render and pass `promtool`; backend `tsc` + ESLint clean, 68 unit suites (569 tests) and the monitoring controller e2e pass, PrometheusService checked against a real Prometheus + node_exporter;
> dashboard `tsc` + ESLint clean, 69 Jest suites (329 tests) and all 38 Playwright specs (7 new) pass, production build OK.
> Still to do on your machine: Phase 10 (Docker bring-up + seed), the Mongo aggregation e2e (`tests/monitoring/heartbeats.aggregation.e2e-spec.ts`, needs mongodb-memory-server's download), Phase 11 rollout.
> Decisions taken: D1 orders source `none` (tile hidden), D2 named connection `monitoring`, D3 labels as proposed, D4 ApexCharts, D5 `MONITORING:view/edit`, D6 5 exporters, D7 profile `monitoring`, D8 no migration.
> Written 2026-09-30 after reading all four repos.
> Source of truth for features: this repo (`heartbeat-monitor`) — `README.md`, `docs/HOW-DATA-IS-COLLECTED.md`, `src/**`, `public/index.html`, `scripts/seed.js`.

---

## 0. Goal and target architecture

Retire the standalone Express app. Everything it does is re-homed:

| Today (`heartbeat-monitor`) | After |
|---|---|
| `prometheus/prometheus.yml` + 6 demo exporters | **devops** `infrastructure_setup/monitoring/` config (with new `cluster` / `instance` labels), run in Docker from `devops/docker-compose.yml` |
| Express API + node-cron collector + Mongoose model | **backend** NestJS module `src/modules/monitoring/` |
| Simulated orders/chats DBs | Real counters in backend (chats = Mongo `messages`; orders = see decision D1) |
| `public/index.html` (Chart.js) | **dashboard** page `/monitoring` (+ `/en/monitoring`, `/ar/monitoring`) with a new **Monitoring** side-menu entry, ApexCharts + antd |
| Own MongoDB container | The devops `mongodb` container, own database `monitoring` |

```
 node_exporter (VMs / DOKS / local containers)
        ▲ ① scrape 15s
 Prometheus  ← config from devops/infrastructure_setup/monitoring (Ansible template + Docker variant)
        ▲ ② PromQL every minute, and live reads
 backend  src/modules/monitoring
   ├─ collector (cron, 1 writer across PM2 workers via Redis lock) ──③ counts──► chat Mongo (messages), orders source
   ├─ ④ insert ──► MongoDB `monitoring.heartbeats` (time-series, TTL)
   └─ REST  /monitoring/*  (JWT + roles + permissions)
        ▲ Axios (cookies)
 dashboard  /monitoring  (tiles, live pop-ups, 10 charts, table, filters, Sync clusters)
```

---

## 1. Decisions to confirm before starting (defaults in bold)

| # | Decision | Options | Default |
|---|---|---|---|
| D1 | **Where "orders" come from.** The backend has no orders / `order_requests` table. | (a) keep the field, pluggable source, **disabled → `null`, UI hides the Orders tile/series until a source exists**; (b) map to an existing business event (e.g. new `User` rows, new `Stream` rows, WebRTC calls); (c) Redis `INCR hb:orders:<minute>` hook called by whatever creates orders | **(a)**, with the source interface ready for (b)/(c). Field names `orders`/`chats` stay so data and API stay compatible. |
| D2 | Mongo database / connection | same DB as chat vs. its own DB | **Own named Mongoose connection `'monitoring'`, DB `monitoring`, same `mongodb` container** (backend rule: chat owns a named connection, never add an unnamed `forRoot`). |
| D3 | Cluster labels for the VM inventory | per-host vars in `ansible_inventory.yml` | **`main_servers` → `cluster: monitoring`; `observed_server_1/2/4` → `cluster: backend`; `observed_server_3` (192.168.100.53, the LiveKit VM per `devops/livekit/README.md`) → `cluster: livekit`; DOKS job → `cluster: doks`.** `instance` = inventory alias (`observed_server_1`…) instead of `ip:9100`. Edit freely — nothing is hard-coded downstream. |
| D4 | Chart library in dashboard | ApexCharts (already installed) vs add Chart.js | **ApexCharts** — no new dependency, matches the existing `components/charts`. |
| D5 | Access control | roles only vs roles + permissions | **Roles `SUPER_ADMIN`/`ADMIN` + new permissions `MONITORING:view` (page + read endpoints) and `MONITORING:edit` (Sync clusters, SUPER_ADMIN only).** |
| D6 | Local Docker exporters | real host vs simulated nodes | **5 `node-exporter` containers named after the inventory hosts** (main + observed 1–4) so the Docker Prometheus config mirrors production labels exactly. On Docker Desktop they all report the same Linux VM (documented limitation). |
| D7 | Compose profile | always-on vs profile | **Profile `monitoring`** — `docker compose --profile monitoring up -d`; keeps the default stack unchanged for others. |
| D8 | Old history in `heartbeat-monitor`'s Mongo | migrate vs reseed | **Don't migrate** — node names change (`backend-1` → `observed_server_1`); reseed with the ported seed script. |

---

## 2. Findings that shape the work

1. **devops Prometheus config is inline Jinja inside `ansible/deploy.yml`** (task "Write Prometheus config"). Job names: `node_exporter` (static: `127.0.0.1:9100` + every `observed_servers` host) and, when `doks_monitoring_enabled`, `doks-nodes` (DigitalOcean SD, sets a `node` label from the droplet name). **No `cluster` label anywhere; `instance` = `ip:9100`.**
2. Heartbeat code reads the cluster from the `cluster` label, falling back to the **job name**, and the node from `instance`. Without new labels every VM would land in cluster `node_exporter` under its IP — hence Phase 1.
3. `NODE_EXPORTER_JOB` is a regex in heartbeat queries → set it to `node_exporter|doks-nodes`. (The seed script uses `job="…"` — must become `job=~"…"`.)
4. Alert rules (`rules/linux.yml`, `rules/doks_nodes.yml`) group `by (instance)` / use `$labels.node`; renaming `instance` keeps them valid, only messages change. Keep `node` on DOKS.
5. **`alertmanager.yml` contains a plaintext Gmail app password (committed).** Rotate it and move to `smtp_auth_password_file` before this work lands (Phase 0/1).
6. Backend runs under **PM2 cluster mode** (`instances: 'max'`) → a plain `@Cron` would fire in every worker. The audit module solves the same problem with a Postgres advisory lock; the collector needs a per-minute lock (Redis `SET NX`).
7. Backend already has every dependency needed: `mongoose`, `@nestjs/mongoose`, `@nestjs/schedule` (+`cron`), `@nestjs/axios`, Redis client (`RedisModule`/`REDIS_CLIENT`). **No new npm packages → no image rebuild** for the dev container (it mounts `src`).
8. `devops/docker-compose.yml` passes backend env vars **one by one** — every new `MONITORING_*` var must be added to the `backend.environment` list and `.env.example`.
9. Dashboard routes come from one `scopedRoutes(scope)` factory (default/en/ar); ids must be `${scope}-…`. Side menu = `app/layout/sidemenu/validateUserAccess.tsx` + `menuKeys` in `sidemenu/index.tsx` (+ its test that asserts the key order).
10. Chat messages: Mongo `messages` collection, `timestamps.createdAt`, indexes on `conversationId/_id`. Counting a minute can use the **`_id` ObjectId time range** (already indexed, minute boundaries are whole seconds) — no new index needed.
11. Heartbeat UI sends the browser timezone as `tz` and asks `perNode=1` unless exactly one node is selected — keep that contract.
12. Port clash: `heartbeat-monitor/docker-compose.yml` publishes 27017 and 9090. Stop it before bringing up the devops monitoring profile.

---

## Phase 0 — Preparation (½ day)

- [ ] Create branches per `Git_Best_Practices`: `feature/monitoring` in `devops`, `backend`, `dashboard` (≤63 chars — pre-push hook).
- [ ] **Rotate the Gmail app password** found in `devops/infrastructure_setup/monitoring/alertmanager.yml`; stop committing it (see 1.6).
- [ ] `docker compose down` in `heartbeat-monitor` (frees 27017/9090). Keep the repo as the parity reference.
- [ ] Take reference screenshots of the current heartbeat dashboard (every tile, pop-up, chart, light + dark) into `heartbeat-monitor/screenshots/reference/` for the parity check in Phase 10.
- [ ] Baseline: backend `npm test`, `npm run test:e2e` (with `test:e2e:up`); dashboard `npm run typecheck && npm run lint && npm test -- --runInBand`. Record current pass counts.

---

## Phase 1 — devops: Prometheus configuration and labels (1 day)

All under `devops/infrastructure_setup/monitoring/`.

### 1.1 Extract the inline config into a template
- [ ] New `templates/prometheus.yml.j2` — the exact content now inline in `deploy.yml`.
- [ ] `deploy.yml`: replace the `copy: content:` task with `ansible.builtin.template: src=../templates/prometheus.yml.j2`, then add a `promtool check config` task and a handler that restarts/reloads Prometheus only when the file changed.
- [ ] Also `promtool check rules` over `rules/*.yml`.

### 1.2 Add `cluster` and `instance` labels to the VM job
- [ ] Inventory (`ansible/ansible_inventory.yml`): per host `monitoring_cluster` and `monitoring_node_name` (fallback: group var `monitoring_cluster: vm`, name = inventory alias). Values per D3.
- [ ] Template: one `static_configs` block **per host** so each carries its own labels:
  ```yaml
  - job_name: "node_exporter"
    static_configs:
      - targets: ["127.0.0.1:9100"]
        labels: { cluster: "{{ hostvars[groups['main_servers'][0]].monitoring_cluster | default('monitoring') }}", instance: "{{ groups['main_servers'][0] }}" }
  {% for h in groups['observed_servers'] | default([]) %}
      - targets: ["{{ hostvars[h].ansible_host | default(h) }}:9100"]
        labels: { cluster: "{{ hostvars[h].monitoring_cluster | default('vm') }}", instance: "{{ hostvars[h].monitoring_node_name | default(h) }}" }
  {% endfor %}
  ```
  Job name stays `node_exporter` so existing alert rules keep matching.

### 1.3 DOKS job
- [ ] Add relabels: `target_label: cluster, replacement: "{{ doks_cluster_label | default('doks') }}"` and `source_labels: [__meta_digitalocean_droplet_name] → target_label: instance` (keep the existing `node` label for `doks_nodes.yml`). New inventory var `doks_cluster_label`.

### 1.4 Alert rules
- [ ] Review `linux.yml` / `doks_nodes.yml` with the new labels (they keep working). Optionally include `{{ $labels.cluster }}` in summaries.
- [ ] Note in rules comments: CPU rules use `[5m]`, heartbeat uses `[1m]` — different on purpose (alerts smooth, records match the minute).

### 1.5 Docker variant of the same config (single source of truth)
- [ ] `docker/inventory.docker.yml` — same groups/vars as production but hosts = container names (`node-exporter-main`, `node-exporter-1..4`), `doks_monitoring_enabled: false`.
- [ ] `docker/render.yml` + `docker/render.sh` — renders `templates/prometheus.yml.j2` with the Docker inventory into `docker/prometheus.yml` (runs Ansible in a throwaway container: `docker run --rm -v "$PWD:/w" -w /w/docker <ansible image> ansible-playbook -i inventory.docker.yml render.yml`). Commit the rendered file; CI/dev re-runs the script and fails on diff.
  - Template must parameterise the two Docker differences: main-server target (`127.0.0.1:9100` → `node-exporter-main:9100`) via `node_exporter_main_target`, and Alertmanager target (`127.0.0.1:9093` → `alertmanager:9093`) via `alertmanager_target`; `rule_files` path via `prometheus_config_dir` (`/etc/prometheus`).
- [ ] `docker/alertmanager.yml` — same routing as production; SMTP password read from `smtp_auth_password_file: /etc/alertmanager/secrets/smtp_password` (gitignored file), or a no-op receiver when absent.

### 1.6 Secrets hygiene
- [ ] Production `alertmanager.yml` → `smtp_auth_password_file`; Ansible copies `../secrets/smtp_password` (gitignored, 0600) like `do_token`.
- [ ] `.gitignore`: `infrastructure_setup/monitoring/secrets/`, `infrastructure_setup/monitoring/docker/secrets/`. Remove the password from git history (`git filter-repo`) — coordinate, rewrites history.

### 1.7 Docs
- [ ] `infrastructure_setup/monitoring/README.md`: labels contract (`cluster`, `instance` are consumed by the backend monitoring module — renaming a node = see "Sync clusters"), how to render the Docker config, how to add a node/cluster.

**Acceptance:** `ansible-playbook --check` passes; rendered prod config shows per-host labels; `promtool check config docker/prometheus.yml` passes.

---

## Phase 2 — devops: run it in Docker (½ day)

### 2.1 `devops/docker-compose.yml` (profile `monitoring`, network `system-proxy`)
- [ ] `prometheus` — `prom/prometheus:<pin, same major as the Ansible install>`, mounts `./infrastructure_setup/monitoring/docker/prometheus.yml:/etc/prometheus/prometheus.yml:ro` and `./infrastructure_setup/monitoring/rules:/etc/prometheus/rules:ro`, volume `prometheus-data`, flags `--storage.tsdb.retention.time=15d --web.enable-lifecycle`, port `${PROMETHEUS_PORT}:9090`, healthcheck `wget -qO- localhost:9090/-/ready`.
- [ ] `alertmanager` — `prom/alertmanager:<pin>`, mounts `docker/alertmanager.yml` + secrets dir, port `${ALERTMANAGER_PORT}:9093`.
- [ ] `node-exporter-main`, `node-exporter-1` … `node-exporter-4` — YAML anchor, `prom/node-exporter:<pin>`, `command: ["--path.rootfs=/host"]`, `volumes: ["/:/host:ro"]` (no `rslave` on Docker Desktop; on Linux hosts add `pid: host` and `/:/host:ro,rslave`). No published ports.
- [ ] Optional `grafana` (mirrors the Ansible install) with a provisioned Prometheus datasource.
- [ ] `volumes: prometheus-data:`.
- [ ] `backend.environment`: add every `MONITORING_*` var (Appendix B). No `depends_on` on Prometheus (the collector tolerates it being down).

### 2.2 `.env.example` (+ your `.env`)
```
PROMETHEUS_PORT=9090
ALERTMANAGER_PORT=9093
MONITORING_MONGO_URL=mongodb://<user>:<pass>@mongodb:27017/monitoring?authSource=admin
MONITORING_PROMETHEUS_URL=http://prometheus:9090
MONITORING_NODE_EXPORTER_JOB=node_exporter|doks-nodes
MONITORING_DISK_MOUNTPOINT=/var/lib        # Docker Desktop; "/" on real Linux hosts
MONITORING_REPORT_TIMEZONE=Africa/Cairo
... (full list: Appendix B)
```

### 2.3 Bring it up
```sh
cd D:\work\codebase\devops
docker compose --env-file .env --profile monitoring up -d prometheus alertmanager node-exporter-main node-exporter-1 node-exporter-2 node-exporter-3 node-exporter-4
docker compose --env-file .env up -d --force-recreate backend      # picks up new env vars (no rebuild needed)
```

**Acceptance:** `http://localhost:9090/targets` shows 5 `node_exporter` targets UP, each with `cluster` + friendly `instance`; `/alerts` lists the rule groups; `docker exec backend_container wget -qO- http://prometheus:9090/-/ready` succeeds.

---

## Phase 3 — backend: module foundation (1 day)

### 3.1 File layout — `backend/src/modules/monitoring/`
```
monitoring.module.ts
monitoring.constants.ts          MONITORING_CONNECTION='monitoring', CLUSTER_NODE='__cluster__', lock keys, BUCKETS, BUCKET_LABELS
monitoring.config.ts             typed getters + PromQL builders (port of src/config.js)
schemas/heartbeat.schema.ts      @Schema (timeseries, TTL, autoCreate:false) — port of models/Heartbeat.js
services/
  heartbeat-collection.service.ts   OnModuleInit: create/validate time-series collection (port of db.js)
  prometheus.service.ts             queryPrometheus, getMetricsByNode, getLiveByNode (port of services/prometheus.js)
  collector.service.ts              cron + Redis lock + collectHeartbeat (port of services/collector.js)
  heartbeats.service.ts             range/bucket/aggregations/summarize/nodes/clusters/latest (port of routes/heartbeats.js)
  live.service.ts                   size-weighted totals (port of routes/live.js)
  maintenance.service.ts            findClusterDrift / syncClusters (port of routes/maintenance.js)
counters/
  business-counter.interface.ts     { key: 'orders'|'chats'; countBetween(from,to): Promise<number|null> }
  chats.counter.ts                  counts chat messages in [from,to)
  orders.counter.ts                 per D1 (default: disabled → null)
utils/
  range.util.ts  bucket.util.ts  format.util.ts   (pure, unit-tested)
dtos/  heartbeats-query.dto.ts  live-query.dto.ts  nodes-query.dto.ts  latest-query.dto.ts  + response DTOs for Swagger
monitoring.controller.ts
```

### 3.2 Configuration
- [ ] `src/config/configuration.ts`: add a `monitoring` block parsed with the existing `parseNumber/parseBoolean/parseCsv` helpers (Appendix B). Keep the validations from `config.js`: interval is a whole number of minutes, cron valid, cron ↔ interval agree, `weekStart ∈ {monday,sunday,saturday}`.
- [ ] Guard: collector refuses to start (logs error, module still serves reads) when config invalid.

### 3.3 Mongo connection + collection bootstrap
- [ ] `MongooseModule.forRootAsync({ connectionName: MONITORING_CONNECTION, useFactory: → uri: monitoringMongoUrl, serverSelectionTimeoutMS: 5000 })` + `forFeature([Heartbeat], MONITORING_CONNECTION)`.
- [ ] `HeartbeatCollectionService.onModuleInit` — exact port of `db.js`: create with `timeseries {timeField:'datetime', metaField:'meta', granularity:'seconds'}` + `expireAfterSeconds`; refuse (clear error + fix command) if a normal collection or wrong `metaField` exists; `syncIndexes` in try/catch. Safe under PM2 (create is idempotent — catch `NamespaceExists`).
- [ ] Register `MonitoringModule` in `app.module.ts`; add `'monitoring'` tag to `bootstrap/swagger.constants.ts`.

**Acceptance:** backend boots in Docker; `db.getSiblingDB('monitoring').getCollectionInfos()` shows `heartbeats` as `timeseries` with TTL.

---

## Phase 4 — backend: Prometheus client, collector, business counters (1–1.5 days)

### 4.1 PrometheusService
- [ ] `GET {url}/api/v1/query?query=…&time=…` via `HttpService` (or `fetch`) with `AbortSignal.timeout(MONITORING_PROMETHEUS_TIMEOUT_MS)`.
- [ ] Port verbatim: scalar handling, `cluster = metric.cluster || metric.job || defaultCluster`, `node = metric.instance`, `toNumber`, `toPercent` (2 decimals, clamp 0–100), `toBps` (whole bps), `toUsage` (4 decimals), `networkOf` (busier direction ÷ speed).
- [ ] All 9 queries (cpu, memory, netRx, netTx, netSpeed, memTotal, memAvailable, cpuCores, diskAvail, diskSize) built from config, each overridable by env (`MONITORING_CPU_QUERY`, …, same as heartbeat), `Promise.allSettled` so one failure only nulls its field.

### 4.2 CollectorService
- [ ] Dynamic cron via `SchedulerRegistry.addCronJob('monitoring-heartbeat', new CronJob(expr, tick, null, true, 'UTC'))` (expression comes from env, so `@Cron()` decorator can't be used).
- [ ] `tick`: snap `to = round(now/interval)*interval`, `from = to - interval` (exact port).
- [ ] **One writer per window across PM2 workers / replicas:** `SET monitoring:heartbeat:<fromISO> <hostname:pid> NX PX <interval-5s>` on the shared Redis client; only the winner collects. Plus `MONITORING_COLLECTOR_ENABLED=false` kill switch (replaces `RUN_COLLECTOR`).
- [ ] `collectHeartbeat(from,to)`: metrics + every counter in parallel; node docs (`orders/chats: null`) + one `__cluster__` doc (`cpu/mem/net: null`); `insertMany(ordered:false)` on the native collection; errors collected → partial log line; runs independent (no await chaining). Same log format (`[heartbeat] … saved= failed= nodes= [...] orders= chats=`) through the Nest/pino logger.
- [ ] `onModuleDestroy` stops the job.

### 4.3 Business counters
- [ ] `ChatsCounter`: count user messages in `[from,to)` on the **chat** connection. Preferred query: `_id` range via `ObjectId.createFromTime()` (indexed, exact on minute boundaries); count `kind ∈ {text, file}` and exclude `kind: 'system'` (join/leave/rename notices — `MessageKind` in `message.schema.ts`). Expose through a new `MessageRepository.countCreatedBetween()` and export it from `ChatModule` (or export the `Message` model provider) — don't open a second chat connection.
- [ ] `OrdersCounter`: per D1. Default returns `null` and the module reports `features.orders=false` via `/monitoring/buckets` so the UI hides the Orders tile/series.
- [ ] Counter registry so a future counter (e.g. streams, calls) is one class + one schema field.

**Acceptance:** with the Docker stack up, one record per exporter + one `__cluster__` record lands every minute (check with `mongosh`); killing Prometheus yields `null` CPU but chats still saved; with 2 backend processes only one writes.

---

## Phase 5 — backend: REST API, security, docs (1–1.5 days)

### 5.1 Endpoints (`@Controller('monitoring')`)
| Method & path | Port of | Guard |
|---|---|---|
| `GET /monitoring/health` | `GET /health` (+ Prometheus reachability, collector enabled, last successful tick) | view |
| `GET /monitoring/buckets` | `GET /api/buckets` (+ `features: { orders, chats }`, `defaultTimezone`, `diskMountpoint`, `cpuWindow`) | view |
| `GET /monitoring/heartbeats` | `GET /api/heartbeats` (`from,to,cluster,node,bucket,tz,perNode`) | view |
| `GET /monitoring/heartbeats/nodes` | `GET /api/heartbeats/nodes?cluster=` | view |
| `GET /monitoring/heartbeats/clusters` | `GET /api/heartbeats/clusters` | view |
| `GET /monitoring/heartbeats/latest` | `GET /api/heartbeats/latest?limit=` | view |
| `GET /monitoring/live` | `GET /api/live?cluster=&node=` (502 when Prometheus down) | view |
| `GET /monitoring/maintenance/cluster-drift` | same | edit |
| `POST /monitoring/maintenance/sync-clusters` | same (recomputes drift server-side) | edit + SUPER_ADMIN |

- [ ] Response bodies **identical** to heartbeat (field names, rounding, `totals`, `points`, `series`, `selectedNodes`, `bucketLabel`, `bucketMs`, `timezone`, `count`) so the UI port is mechanical.
- [ ] Aggregations ported verbatim: main `$group` with `$dateTrunc` (+`startOfWeek`), the `$or` that always keeps the `__cluster__` record, the two-step network sum-then-average, per-node series sorted busiest first, `summarize()` weighted by samples, `pickBucket` (auto ≤1,500 points, never finer than the heartbeat, upgrade too-fine buckets), 3-year max range.

### 5.2 Validation (class-validator DTOs)
- [ ] `from/to` ISO-8601, `from < to`, range ≤ 3 years (400 with the same messages); `bucket ∈ auto|1m|5m|15m|1h|6h|1d|1w|1mo`; `tz` valid IANA (`Intl.DateTimeFormat` try/catch); `node` CSV ≤ N entries and length caps; `cluster` length cap; `perNode` boolean-ish; `limit` 1–3600.
- [ ] Escape nothing into PromQL from the request (live filters are applied in JS after the query, as today) — keep it that way.

### 5.3 Auth, permissions, audit, rate limit
- [ ] `@UseGuards(JwtAuthGuard, RolesGuard, PermissionsGuard)`, `@AuthCookies(dashboardCookieName, deviceIdAdminCookieName)`, `@Roles(['SUPER_ADMIN','ADMIN'])`, `@Can(['MONITORING:view'])`; sync: `@Roles(['SUPER_ADMIN'])` + `@Can(['MONITORING:edit'])`.
- [ ] `src/types/permission.type.ts`: add `'MONITORING'` unit with `view | edit`.
- [ ] `src/seedings/data/permissions.json`: `MONITORING:view` / `MONITORING:edit` (en + ar names); make sure the super-admin seed grants them; run `npm run prisma:seed` in the container.
- [ ] `AuditService` entry for sync-clusters (`action: monitoring.clusters_synced`, `changes: applied[]`).
- [ ] Rate limiter: the page polls `/heartbeats` + `/live` every 30 s and the pop-up can refresh on demand — confirm the global `RateLimiterGuard` budget, add `@RateLimit` overrides if needed.
- [ ] Swagger: `@ApiTags('monitoring')`, `@ApiOperation`, response DTOs, 400/401/403/502 docs.

**Acceptance:** Swagger shows the endpoints; a dashboard admin cookie gets 200; no cookie 401; admin without permission 403; ADMIN (non-super) gets 403 on sync.

---

## Phase 6 — backend: seed, tests, docs (1 day)

- [ ] Port `scripts/seed.js` → `src/seedings/monitoring/seedHeartbeats.ts`, script `"monitoring:seed": "tsx scripts/with-secrets.ts tsx src/seedings/monitoring/seedHeartbeats.ts"`. Discovers nodes from Prometheus (`up{job=~…}`), per-node baselines, traffic curve (`trafficFactor`/`poisson` moved to `utils`), network fields too (the original seed omits them — add plausible values), refuses to overlap existing records, batches of 10k. Run: `docker exec -it backend_container npm run monitoring:seed -- 48`.
- [ ] Unit tests (`tests/unit/modules/monitoring/**`): `pickBucket`, `parseRange`, `summarize`, `toPercent/toBps/toUsage/networkOf`, live totals weighting, PromQL builder with/without instance, `queryPrometheus` mapping (scalar / missing labels / job fallback), collector: boundary snapping, partial failures → nulls, lock lost → no insert, disabled flag; counters.
- [ ] E2E (`tests/monitoring/*.e2e-spec.ts`): controller-level with `createHttpModuleTestApp()` (guards, validation, response shapes); full-stack aggregation test using `mongodb-memory-server` (already a devDependency; supports time-series) seeding known records and asserting points/totals/network/perNode/`$or` behaviour — mirrors the verified example in the heartbeat README (17:36 CPU spike).
- [ ] Docs: `backend/docs/monitoring.md` (port of README §1–5, 11, 12 adapted), update backend `README.md` modules list and `CLAUDE.md` (new named connection `'monitoring'`, collector lock, env vars).

---

## Phase 7 — dashboard: plumbing (½ day)

- [ ] `app/routes.ts` → `dashboardRoutes`: `route('monitoring', './pages/monitoring/index.tsx', { id: \`${scope}-monitoring\` })` (automatically mounted for default/en/ar). `npm run typecheck` to regenerate route types.
- [ ] `app/enum/permissions.ts`: `MonitoringView = 'MONITORING:view'`, `MonitoringEdit = 'MONITORING:edit'`.
- [ ] Side menu: `menuKeys.monitoring = 'monitoring'` in `sidemenu/index.tsx`; in `validateUserAccess.tsx` push a `monitoring` item (icon `FaHeartbeat` from `react-icons/fa`, `data-testid='side-menu-item-monitoring'`, `redirectReload({ path: 'monitoring' })`) right after Dashboard, gated by `canAccess({ roles: [Role.SuperAdmin, Role.Admin], permissions: [Permission.MonitoringView] })`. Update `__tests__/validateUserAccess.test.tsx` expected keys.
- [ ] i18n: `sideMenu.monitoring` + a `monitoring.*` namespace in `app/locales/en/translation.json` and `ar/translation.json` (every label, tooltip, unit, empty/error state, pop-up titles, table headers, Sync texts).
- [ ] `app/api/monitoring.ts` — HOF factories per repo convention with module-scoped `AbortController`s: `fetchMonitoringMeta`, `fetchHeartbeats(params)`, `fetchNodes(cluster)`, `fetchClusters()`, `fetchLive(cluster,node)`, `fetchClusterDrift()`, `syncClusters()`. Errors via `getApiErrorMessage`.
- [ ] `app/interfaces/monitoring.ts` — types mirroring the backend responses.

---

## Phase 8 — dashboard: the Monitoring page (3–4 days)

`app/pages/monitoring/index.tsx` (thin, breadcrumb) → `app/forms/monitoring/`:

```
index.tsx                 state owner: applied vs draft filters, loaders, live timer
FiltersBar.tsx            From/To (antd DatePicker showTime, local tz), presets 1h/24h/7d/30d/1y, Cluster select,
                          Nodes picker, Apply (+ dot & "Changes not applied yet"), Live (30s) switch, Sync clusters button
NodePicker.tsx            grouped checkboxes: cluster heading checkbox ticks all its nodes, indeterminate when partial;
                          button text "All nodes" / "3 of 5 nodes" / node name; none ticked = all
KpiTiles.tsx              Orders*, Chats (range totals from DB) + Avg CPU, Avg memory, Disk free, Bandwidth used (live)
LiveNodesModal.tsx        CPU / Memory / Disk / Bandwidth by node, grouped by cluster, Total row, usage bars
                          (amber ≥80, red ≥90, "high"/"low" text), Refresh, "read at …", network (i) info table,
                          Esc / × / outside click closes; tiles open it on click and Enter
charts/                   ServerCpuChart, ServerMemoryChart, ServerNetworkChart, CpuWithTrafficChart,
                          MemoryWithTrafficChart, NodesLineChart (reused for CPU/mem/rx/tx by node), ActivityChart
DataTable.tsx             raw numbers per bucket (antd Table)
SyncClustersModal.tsx     preview drift (node, from → to, records) → confirm → result (totalModified) → reload clusters
helpers.ts                formatBytes (1024-based), formatBps (bps→Kbps→Mbps→Gbps), bucket-aware tick/tooltip formats,
                          12-hour clock, withGaps (null for missing buckets), node colour map, describeSelection
```
(* hidden when `features.orders === false`, D1)

Behaviour to reproduce exactly:
- [ ] Nothing reloads until **Apply**; dirty indicator while the form differs from what's on screen.
- [ ] Changing Cluster reloads the node list (`/heartbeats/nodes?cluster=`).
- [ ] Request: `bucket=auto`, `tz=<browser IANA tz>`, `cluster`, `node` CSV, `perNode=1` unless exactly one node selected.
- [ ] Stale-response protection: abort previous request + sequence number.
- [ ] Live (30 s): rolling window (keeps range length, moves `to` to now), re-reads heartbeats and `/live`; stops on unmount/leaving the tab.
- [ ] Live tiles ignore From/To; follow applied cluster/nodes; re-read on Apply, on each Live tick, on pop-up open/Refresh (tiles update too); size-weighted totals come from the API.
- [ ] Charts (10): Server CPU %, Server memory %, Server network throughput (rx/tx, sum of nodes, busiest minute in tooltip when bucket > 1m), CPU with orders & chats (tooltip shows the bucket's counts), Memory with orders & chats, CPU by node, Memory by node, Network received by node, Network sent by node, Order requests & chats.
- [ ] Per-node charts only when > 1 node in play; max 8 series (busiest), subtitle says how many were left out; **same colour per node across all four per-node charts**.
- [ ] Axis/tooltip formats follow the bucket (`1:25 pm`, `Mon, Sep 7, 2026`, `Week of 9/7 – 9/13`, `September 2026`), always 12-hour.
- [ ] Missing buckets break the line (nulls, `connectNulls` off).
- [ ] Subtitles show bucket label and averages/maxes like the original.
- [ ] Error/empty states: Prometheus unreachable (tiles show "—" + message from 502), no data in range, partial `errors[]` from `/live`.
- [ ] Theme: follow the dashboard's theme; if it supports dark mode, re-render charts on change (original re-renders on `prefers-color-scheme` change).
- [ ] RTL/Arabic: layout mirrors via `StyleDirectionWrapper`; charts and numbers stay LTR; dates via dayjs locale.
- [ ] Sync clusters button rendered inside `<Can permissions={[Permission.MonitoringEdit]} roles={[Role.SuperAdmin]}>`.
- [ ] Charts lazy-loaded (`lazy(() => import(...))`) like the dashboard page, to keep the route chunk small.
- [ ] Accessibility: tiles are buttons (focus + Enter), modal focus trap, bar colours also conveyed by text.

---

## Phase 9 — dashboard: tests (1 day)

- [ ] Jest: `helpers` (formatBytes/formatBps/tick formats/withGaps/colour map/describeSelection), `api/monitoring` (params, abort), `NodePicker` (tri-state, "3 of 5"), `KpiTiles` (orders hidden when disabled), `LiveNodesModal` thresholds, side-menu test updated.
- [ ] Playwright `e2e/monitoring.spec.ts` (mock API with `page.route`): menu entry visible only with permission, `/monitoring`, `/en/monitoring`, `/ar/monitoring` load, Apply-only behaviour, presets, cluster → nodes reload, pop-up open/refresh/Esc, per-node charts appear with 2+ nodes, Sync flow for super admin, hidden for admin.
- [ ] Screenshots only under `dashboard/_claude_shots/` (repo rule).
- [ ] Pre-push sequence: `npm ci && npm run typecheck && npm run lint && npm test -- --runInBand && npm run build`.

---

## Phase 10 — End-to-end verification in Docker (½–1 day)

1. `docker compose --profile monitoring up -d …` (Phase 2) → targets UP with labels.
2. Backend recreated; logs show `[heartbeat] cron "* * * * *" started` once per worker and **one** `saved=` line per minute.
3. `docker exec -it backend_container npm run monitoring:seed -- 48`.
4. Log in to the dashboard → Monitoring → verify every item in **Appendix A** against the reference screenshots.
5. Load test: `stress-ng`/`yes > /dev/null` inside one exporter's host for exactly one minute → only that minute's record jumps (heartbeat README §2 experiment).
6. Relabel test: move `node-exporter-4` to another cluster in the Docker inventory → render → `curl -X POST localhost:9090/-/reload` → wait 5 min → Sync clusters preview/apply → history follows.
7. Failure tests: stop Prometheus (tiles show error, records keep chats with null CPU); stop Mongo (backend logs failed save, recovers); run 2 backend processes (one writer).
8. Alerts: `HostHighCPU` fires in Alertmanager during the load test (rule uses 5m, so hold load ≥5 min).

---

## Phase 11 — Production rollout and cleanup (½ day + ops window)

- [ ] Ansible: run the monitoring playbook (`--check` first) → Prometheus picks up labels. Wait 5 min lookback, then use Sync clusters if old records exist.
- [ ] Network: allow backend hosts → Prometheus `:9090` only (firewall); node_exporter `:9100` stays reachable only from Prometheus.
- [ ] Secrets: `MONITORING_*` into Infisical (backend already loads it) / Jenkins; `MONITORING_PROMETHEUS_URL=http://192.168.100.50:9090`, `MONITORING_DISK_MOUNTPOINT=/`.
- [ ] PM2 cluster: Redis lock verified in prod; optionally `MONITORING_COLLECTOR_ENABLED=false` everywhere but one host if multiple VMs run the backend.
- [ ] Deploy per Git flow: feature → staging (QA) → release/* squash-merge to main, tag. Order: devops → backend → dashboard.
- [ ] Long-term history (optional, README §11): scheduled `$merge` into hourly/daily rollup collections kept forever.
- [ ] `heartbeat-monitor`: mark README as "moved to backend/dashboard", keep for reference, archive after parity sign-off.
- [ ] Update `devops/CLAUDE.md` (monitoring profile, labels contract; also fix stale refs: `kubernates/automation` → `pipelines`, no `coturn/`), `backend/CLAUDE.md`, `dashboard/CLAUDE.md`.

### Optional follow-ups
- Push instead of poll: after each insert emit `monitoring:heartbeat` on the main Socket.IO gateway; the page refreshes when a new minute lands.
- Disk trend chart: store `diskAvailBytes/diskSizeBytes` per heartbeat (README Q&A).
- Kubernetes stack (`microservices_archeticture/`) is **out of scope** — it has its own monitoring tree.

---

## Appendix A — Feature parity checklist (nothing from heartbeat-monitor may be lost)

**Collection**
- [ ] Cron `* * * * *`, window `[from,to)` snapped to the interval boundary
- [ ] Interval validation (whole minutes, matches cron); CPU rate window defaults to the interval
- [ ] 4 PromQL series per node (CPU %, memory %, net rx/tx bps) in parallel; each failure → only that field `null`
- [ ] Nodes discovered from query results (`by (instance, job, cluster)`); cluster fallback to job, then `defaultCluster`
- [ ] `NODE_EXPORTER_JOB` regex, `NODE_EXPORTER_INSTANCE` single-node mode
- [ ] Network device exclude regex (lo, veth, docker, br-, virbr, cni, flannel, cali, vxlan, tunl, kube-)
- [ ] Separate `__cluster__` counts record; nulls make `$avg`/`$sum` work without special cases
- [ ] Orders + chats counted for the same window, in parallel, failures stored as `null`
- [ ] Rounding: % 2 decimals, bps whole, network usage 4 decimals
- [ ] Runs independent; saved/failed counters and per-run log line; partial-error warning
- [ ] Only one writer when several processes run

**Storage**
- [ ] Time-series `heartbeats`, `timeField: datetime`, `metaField: meta{cluster,node}`, `granularity: seconds`
- [ ] TTL = `RETENTION_DAYS`; documented `collMod` to change it
- [ ] Startup refuses normal collection / old metaField with actionable message; index sync never blocks startup

**API**
- [ ] `/heartbeats` params `from,to,cluster,node(csv),bucket,tz,perNode`; defaults (to=now, from=to−1h)
- [ ] Buckets 1m…1mo, auto ≤1,500 points, not finer than heartbeat, too-fine upgraded, week start config, timezone-aware `$dateTrunc`
- [ ] Counts record survives node/cluster filters
- [ ] Points: cpu/mem avg+max, orders/chats sum, samples, nodeCount, net rx/tx (sum per minute → avg per bucket) + busiest minute, pre-network minutes skipped
- [ ] Totals (weighted by samples) and per-node series (busiest first)
- [ ] `/nodes` (7-day window, grouped + flat), `/clusters` (7-day), `/latest` (1–3600), `/buckets`, `/health`
- [ ] `/live`: 9 queries, per-node cpu/cores, memory used/total, disk avail/size, network rx/tx/speed/usage; totals weighted by size; `errors[]`; 502 when Prometheus down; `cpuWindow`, `mountpoint`, `at`
- [ ] Maintenance: drift via `timestamp(up{…})` freshest series; sync recomputes server-side; address changes left alone

**Dashboard**
- [ ] From/To local pickers → UTC; presets 1h/24h/7d/30d/1y; Cluster; grouped tri-state Nodes picker; Apply + dirty hint; Live 30 s; Sync clusters (preview → confirm)
- [ ] Tiles: Orders, Chats (range) + Avg CPU, Avg memory, Disk free (`50 GB/80 GB`), Bandwidth used (`5.1 Gbps/21 Gbps`) (live)
- [ ] Pop-ups: CPU/Memory/Disk/Bandwidth by node, grouped by cluster, Total row, 80/90 thresholds with text, Refresh, read-at time, network info tip, Esc/×/outside close, keyboard open
- [ ] 10 charts as listed in Phase 8, gaps not bridged, auto units, bucket-aware formats, 12-hour clock
- [ ] Per-node: only with >1 node, max 8, "N more" note, consistent colours
- [ ] Data table; stale-response protection; theme handling; status line / errors

**Tooling & docs**
- [ ] Seed from real Prometheus targets, refuses overlapping ranges
- [ ] All env vars (Appendix B); docs incl. "how data is collected" walkthrough and Q&A

## Appendix B — Environment variables

| heartbeat-monitor | backend | Default |
|---|---|---|
| `PORT` | — (backend port) | — |
| `MONGO_URI` | `MONITORING_MONGO_URL` | `mongodb://localhost:27017/monitoring` |
| `PROMETHEUS_URL` | `MONITORING_PROMETHEUS_URL` | `http://localhost:9090` |
| `PROMETHEUS_TIMEOUT_MS` | `MONITORING_PROMETHEUS_TIMEOUT_MS` | `800` |
| `NODE_EXPORTER_JOB` | `MONITORING_NODE_EXPORTER_JOB` | `node_exporter\|doks-nodes` |
| `NODE_EXPORTER_INSTANCE` | `MONITORING_NODE_EXPORTER_INSTANCE` | empty |
| `DEFAULT_CLUSTER` | `MONITORING_DEFAULT_CLUSTER` | `default` |
| `CPU_RATE_WINDOW` | `MONITORING_CPU_RATE_WINDOW` | = interval |
| `CPU_QUERY`, `MEMORY_PERCENT_QUERY` | `MONITORING_CPU_QUERY`, `MONITORING_MEMORY_PERCENT_QUERY` | generated |
| `NETWORK_RX_QUERY`, `NETWORK_TX_QUERY`, `NETWORK_SPEED_QUERY` | `MONITORING_NETWORK_RX_QUERY`, `…_TX_QUERY`, `…_SPEED_QUERY` | generated |
| `DISK_AVAIL_QUERY`, `DISK_SIZE_QUERY` | `MONITORING_DISK_AVAIL_QUERY`, `MONITORING_DISK_SIZE_QUERY` | generated |
| `DISK_MOUNTPOINT` | `MONITORING_DISK_MOUNTPOINT` | `/` (`/var/lib` on Docker Desktop) |
| `NETWORK_DEVICE_EXCLUDE` | `MONITORING_NETWORK_DEVICE_EXCLUDE` | see config.js |
| `HEARTBEAT_CRON` | `MONITORING_HEARTBEAT_CRON` | `* * * * *` |
| `HEARTBEAT_INTERVAL_MS` | `MONITORING_HEARTBEAT_INTERVAL_MS` | `60000` |
| `REPORT_TIMEZONE` | `MONITORING_REPORT_TIMEZONE` | `UTC` (set `Africa/Cairo`) |
| `WEEK_START` | `MONITORING_WEEK_START` | `monday` |
| `RETENTION_DAYS` | `MONITORING_RETENTION_DAYS` | `30` |
| `RUN_COLLECTOR` | `MONITORING_COLLECTOR_ENABLED` | `true` |
| — | `MONITORING_ORDERS_SOURCE` (D1) | `none` |
| — (devops) | `PROMETHEUS_PORT`, `ALERTMANAGER_PORT` | `9090`, `9093` |

Each backend var must be added to: `configuration.ts`, `backend/.env.example`, `Dockerfile.dev` defaults (optional), `devops/.env.example`, `devops/docker-compose.yml` `backend.environment`, Infisical/Jenkins for prod.

## Appendix C — Files touched per repo

**devops**: `infrastructure_setup/monitoring/{templates/prometheus.yml.j2, ansible/deploy.yml, ansible/ansible_inventory.yml, alertmanager.yml, rules/*.yml, docker/{inventory.docker.yml, render.yml, render.sh, prometheus.yml, alertmanager.yml}, README.md}`, `docker-compose.yml`, `.env.example`, `.gitignore`, `CLAUDE.md`.
**backend**: `src/modules/monitoring/**` (new), `src/app.module.ts`, `src/config/configuration.ts`, `src/bootstrap/swagger.constants.ts`, `src/types/permission.type.ts`, `src/seedings/data/permissions.json` (+ admin grant), `src/seedings/monitoring/seedHeartbeats.ts`, `src/modules/chat/{chat.module.ts, repositories/message.repository.ts}`, `package.json` (script only), `.env.example`, `tests/unit/modules/monitoring/**`, `tests/monitoring/**`, `docs/monitoring.md`, `README.md`, `CLAUDE.md`.
**dashboard**: `app/routes.ts`, `app/layout/sidemenu/{index.tsx, validateUserAccess.tsx, __tests__/*}`, `app/enum/permissions.ts`, `app/api/monitoring.ts`, `app/interfaces/monitoring.ts`, `app/pages/monitoring/**`, `app/forms/monitoring/**`, `app/locales/{en,ar}/translation.json`, `e2e/monitoring.spec.ts`, `README.md`, `CLAUDE.md`.
**heartbeat-monitor**: this plan, README "moved" notice, reference screenshots.

## Appendix D — Risks

| Risk | Mitigation |
|---|---|
| Duplicate records from PM2 workers | Redis `SET NX` per window + kill switch; test with 2 processes |
| Relabel splits node history | Sync clusters (cluster changes); manual `updateMany` for renames (documented) |
| Docker Desktop exporters all read the same VM | Documented; real validation on the VMs in Phase 11 |
| Prometheus reachability from backend in prod | Firewall rule; `/monitoring/health` shows it; collector stores nulls instead of failing |
| Committed secrets (Gmail app password, SSH key in `machines_keys/`) | Rotate + remove from history (Phase 0/1) |
| Rate limiter throttling the 30 s polling | Verify budget / per-route override in Phase 5 |
| Orders tile has no real data (D1) | Hidden until a source exists; interface ready |

**Rough effort:** ~11–14 dev-days total (devops 1.5, backend 4–5, dashboard 5–6, verification/rollout 1–1.5).
