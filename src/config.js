import 'dotenv/config';

const num = (v, d) => (v === undefined || v === '' ? d : Number(v));

// Which node_exporter targets to read. Must match the job_name in prometheus.yml.
// Leave NODE_EXPORTER_INSTANCE empty to collect every node in the job (a cluster);
// set it to one target address to follow a single machine.
const nodeJob = process.env.NODE_EXPORTER_JOB || 'node';
const nodeInstance = process.env.NODE_EXPORTER_INSTANCE || ''; // e.g. "10.0.0.12:9100"
// job=~ so NODE_EXPORTER_JOB can be one job ("node") or several ("node|workers").
const selector = nodeInstance ? `job=~"${nodeJob}",instance="${nodeInstance}"` : `job=~"${nodeJob}"`;

// The cron schedule the collector runs on. '* * * * *' = at the top of every minute.
const cronExpression = process.env.HEARTBEAT_CRON || '* * * * *';

// How much time one record covers. It MUST match the cron schedule:
//   '* * * * *'   -> 60000   (every minute)
//   '*/5 * * * *' -> 300000  (every 5 minutes)
const intervalMs = num(process.env.HEARTBEAT_INTERVAL_MS, 60_000);
if (intervalMs < 60_000 || intervalMs % 60_000 !== 0) {
  throw new Error('HEARTBEAT_INTERVAL_MS must be a whole number of minutes (60000, 300000…), matching HEARTBEAT_CRON');
}

// CPU is a rate, so it is measured over a window. By default the window = the heartbeat interval,
// so cpuUsage is the average over exactly the same minute the orders/chats were counted in.
// Prometheus needs at least 2 scrapes inside the window (1m window -> the usual 15s scrape is fine).
const rateWindow = process.env.CPU_RATE_WINDOW || `${intervalMs / 60_000}m`;

// Which filesystem the "Disk free" tile reports. '/' is the root disk on a normal Linux server.
const diskMountpoint = process.env.DISK_MOUNTPOINT || '/';

export const config = {
  port: num(process.env.PORT, 3000),
  mongoUri: process.env.MONGO_URI || 'mongodb://localhost:27017/heartbeat',
  prometheusUrl: process.env.PROMETHEUS_URL || 'http://localhost:9090',
  prometheusTimeoutMs: num(process.env.PROMETHEUS_TIMEOUT_MS, 800),

  queries: {
    // Whole-server CPU busy %: 100 - idle %, averaged across all cores.
    // Kept per instance (no sum across servers) so a query matching 2 servers is detected, not blended.
    cpuUsage:
      process.env.CPU_QUERY ||
      `100 * (1 - avg by (instance, job, cluster) (rate(node_cpu_seconds_total{${selector},mode="idle"}[${rateWindow}])))`,
    // Memory really in use (excludes reclaimable cache/buffers), as % of total RAM.
    memoryUsage:
      process.env.MEMORY_PERCENT_QUERY ||
      `100 * (1 - node_memory_MemAvailable_bytes{${selector}} / node_memory_MemTotal_bytes{${selector}})`,
    // Live tiles: memory in bytes and the number of cores, so the dashboard can show "used / total"
    // and weight a multi-node average by each node's size.
    memTotal: `node_memory_MemTotal_bytes{${selector}}`,
    memAvailable: `node_memory_MemAvailable_bytes{${selector}}`,
    cpuCores: `count by (instance, job, cluster) (node_cpu_seconds_total{${selector},mode="idle"})`,
    // Disk: free and total bytes of one filesystem per server, read live (not stored).
    // avail = free space a normal user can write (what `df` shows as "Avail").
    diskAvail:
      process.env.DISK_AVAIL_QUERY ||
      `max by (instance, job, cluster) (node_filesystem_avail_bytes{${selector},mountpoint="${diskMountpoint}"})`,
    diskSize:
      process.env.DISK_SIZE_QUERY ||
      `max by (instance, job, cluster) (node_filesystem_size_bytes{${selector},mountpoint="${diskMountpoint}"})`,
  },

  // Day/week/month grouping is done in this timezone, so a "day" is a local day, not a UTC one.
  timezone: process.env.REPORT_TIMEZONE || 'UTC',
  // Which day a week starts on for the 'week' grouping: monday (ISO) / sunday / saturday (common in Egypt).
  weekStart: (process.env.WEEK_START || 'monday').toLowerCase(),

  nodeJob,
  // Used when a target carries no `cluster` label and no job name.
  defaultCluster: process.env.DEFAULT_CLUSTER || 'default',
  nodeInstance, // empty = every node_exporter in the job (the whole cluster)

  cronExpression,
  intervalMs,
  rateWindow,
  diskMountpoint,
  retentionDays: num(process.env.RETENTION_DAYS, 30),
};
