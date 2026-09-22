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
const toPercent = (v) => (v == null ? null : Math.min(100, Math.max(0, Math.round(v * 100) / 100)));

/**
 * Fetches CPU % and memory % for every node of every cluster, for one heartbeat.
 * Returns a Map of "cluster/node" -> { cluster, node, cpuUsage, memoryUsage }, plus any query errors.
 * The two queries run in parallel and each settles on its own.
 */
export async function getMetricsByNode(at) {
  const [cpu, memory] = await Promise.allSettled([
    queryPrometheus(config.queries.cpuUsage, at),
    queryPrometheus(config.queries.memoryUsage, at),
  ]);

  const errors = [];
  const nodes = new Map();
  const collect = (settled, field, label) => {
    if (settled.status === 'rejected') {
      errors.push(`${label}: ${settled.reason?.message ?? settled.reason}`);
      return;
    }
    for (const { cluster, node, value } of settled.value) {
      const key = `${cluster}/${node}`;
      const entry = nodes.get(key) ?? { cluster, node, cpuUsage: null, memoryUsage: null };
      entry[field] = toPercent(value);
      nodes.set(key, entry);
    }
  };
  collect(cpu, 'cpuUsage', 'cpu');
  collect(memory, 'memoryUsage', 'memory');

  return { nodes, errors };
}

/**
 * Everything the live tiles need, read from Prometheus right now (nothing comes from the database):
 * CPU % (averaged over the last CPU_RATE_WINDOW, 1 minute by default), cores, memory used / total bytes,
 * and disk free / total bytes, per node. The queries run in parallel and each settles on its own,
 * so a missing disk metric does not blank the CPU tile.
 */
export async function getLiveByNode(at = new Date()) {
  const q = config.queries;
  const names = ['cpu', 'cores', 'memTotal', 'memAvailable', 'diskAvail', 'diskSize'];
  const settled = await Promise.allSettled([q.cpuUsage, q.cpuCores, q.memTotal, q.memAvailable, q.diskAvail, q.diskSize]
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
  }));
  return { nodes: list, errors };
}
