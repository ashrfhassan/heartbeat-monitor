import { config } from '../config.js';

/**
 * Runs an instant PromQL query via the Prometheus HTTP API.
 * Returns every series it matched as [{ node, value }] — one entry per node_exporter instance.
 */
export async function queryPrometheus(promql, at = new Date()) {
  const url = new URL('/api/v1/query', config.prometheusUrl);
  url.searchParams.set('query', promql);
  url.searchParams.set('time', (at.getTime() / 1000).toFixed(3));

  const res = await fetch(url, { signal: AbortSignal.timeout(config.prometheusTimeoutMs) });
  const body = await res.json().catch(() => null);

  if (!res.ok || body?.status !== 'success') {
    throw new Error(`Prometheus ${res.status}: ${body?.error ?? 'bad response'}`);
  }

  const { resultType, result } = body.data;
  if (resultType === 'scalar') {
    return [{ cluster: config.defaultCluster, node: config.nodeInstance || config.nodeJob, value: toNumber(result[1]) }];
  }
  return result.map((series) => ({
    // The cluster comes from a `cluster` label on the target; without one, the job name is the cluster.
    cluster: series.metric.cluster || series.metric.job || config.defaultCluster,
    node: series.metric.instance ?? config.nodeJob, // the target address, e.g. 10.0.0.12:9100
    value: toNumber(series.value?.[1]),
  }));
}

function toNumber(raw) {
  if (raw === undefined) return null;
  const value = Number.parseFloat(raw);
  return Number.isFinite(value) ? value : null;
}

// Percentages are saved with 2 decimals (71.384 -> 71.38). Whole numbers would hide a quiet server:
// a 32-core machine at 0.14% busy would be saved as 0, which looks like "no data" rather than "idle".
// Throughput is saved in whole bits per second.
const toBps = (v) => (v == null ? null : Math.max(0, Math.round(v)));
const toPercent = (v) => (v == null ? null : Math.min(100, Math.max(0, Math.round(v * 100) / 100)));

/**
 * Fetches CPU %, memory % and network in/out (bits per second) for every node, for one heartbeat.
 * Returns a Map of "cluster/node" -> { cluster, node, cpuUsage, memoryUsage, netRxBps, netTxBps },
 * plus any query errors. The queries run in parallel and each settles on its own.
 */
export async function getMetricsByNode(at) {
  const [cpu, memory, netRx, netTx] = await Promise.allSettled([
    queryPrometheus(config.queries.cpuUsage, at),
    queryPrometheus(config.queries.memoryUsage, at),
    queryPrometheus(config.queries.netRx, at),
    queryPrometheus(config.queries.netTx, at),
  ]);

  const errors = [];
  const nodes = new Map();
  const collect = (settled, field, label, convert = toPercent) => {
    if (settled.status === 'rejected') {
      errors.push(`${label}: ${settled.reason?.message ?? settled.reason}`);
      return;
    }
    for (const { cluster, node, value } of settled.value) {
      const key = `${cluster}/${node}`;
      const entry = nodes.get(key) ?? { cluster, node, cpuUsage: null, memoryUsage: null, netRxBps: null, netTxBps: null };
      entry[field] = convert(value);
      nodes.set(key, entry);
    }
  };
  collect(cpu, 'cpuUsage', 'cpu');
  collect(memory, 'memoryUsage', 'memory');
  collect(netRx, 'netRxBps', 'network in', toBps);
  collect(netTx, 'netTxBps', 'network out', toBps);

  return { nodes, errors };
}

/**
 * Network now: throughput in and out (average over the last CPU_RATE_WINDOW), the node's bandwidth, and usage.
 * In and out each get the node's full bandwidth, so usage is the BUSIER direction ÷ bandwidth:
 * a 10 Gbps node sending 4 Gbps and receiving 1 Gbps is 40% used, and it is maxed out when either side is.
 */
function networkOf(raw) {
  const rxBps = raw.netRx == null ? null : Math.round(raw.netRx);
  const txBps = raw.netTx == null ? null : Math.round(raw.netTx);
  const speedBps = raw.netSpeed ? Math.round(raw.netSpeed) : null;
  const busiest = rxBps == null && txBps == null ? null : Math.max(rxBps ?? 0, txBps ?? 0);
  return { rxBps, txBps, speedBps, usage: speedBps && busiest != null ? toUsage((busiest / speedBps) * 100) : null };
}
// Network usage keeps more decimals than CPU: 300 Kbps on a 10 Gbps node is 0.003%, not 0.
const toUsage = (v) => Math.min(100, Math.max(0, Math.round(v * 10000) / 10000));

/**
 * Everything the live tiles need, read from Prometheus right now (nothing comes from the database):
 * CPU % (averaged over the last CPU_RATE_WINDOW, 1 minute by default), cores, memory used / total bytes,
 * disk free / total bytes, and network in / out / bandwidth, per node. The queries run in parallel and each settles on its own,
 * so a missing disk metric does not blank the CPU tile.
 */
export async function getLiveByNode(at = new Date()) {
  const q = config.queries;
  const names = ['cpu', 'cores', 'memTotal', 'memAvailable', 'diskAvail', 'diskSize', 'netRx', 'netTx', 'netSpeed'];
  const settled = await Promise.allSettled([q.cpuUsage, q.cpuCores, q.memTotal, q.memAvailable, q.diskAvail, q.diskSize,
    q.netRx, q.netTx, q.netSpeed]
    .map((promql) => queryPrometheus(promql, at)));

  const errors = [];
  const nodes = new Map();
  settled.forEach((s, i) => {
    if (s.status === 'rejected') { errors.push(`${names[i]}: ${s.reason?.message ?? s.reason}`); return; }
    for (const { cluster, node, value } of s.value) {
      const key = `${cluster}/${node}`;
      const entry = nodes.get(key) ?? { cluster, node, raw: {} };
      entry.raw[names[i]] = value;
      nodes.set(key, entry);
    }
  });

  const list = [...nodes.values()].map(({ cluster, node, raw }) => ({
    cluster,
    node,
    cpu: { usage: toPercent(raw.cpu ?? null), cores: raw.cores ?? null },
    memory: {
      usage: raw.memTotal && raw.memAvailable != null ? toPercent(100 * (1 - raw.memAvailable / raw.memTotal)) : null,
      usedBytes: raw.memTotal && raw.memAvailable != null ? raw.memTotal - raw.memAvailable : null,
      totalBytes: raw.memTotal ?? null,
    },
    disk: { availBytes: raw.diskAvail ?? null, sizeBytes: raw.diskSize ?? null },
    network: networkOf(raw),
  }));
  return { nodes: list, errors };
}
