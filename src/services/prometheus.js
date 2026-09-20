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

// Percentages are saved as whole numbers (71.38 -> 71). Change to 1 decimal: Math.round(v * 10) / 10
const toPercent = (v) => (v == null ? null : Math.min(100, Math.max(0, Math.round(v))));

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
