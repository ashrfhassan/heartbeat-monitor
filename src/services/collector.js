import cron from 'node-cron';
import { config } from '../config.js';
import { Heartbeat, CLUSTER_NODE } from '../models/Heartbeat.js';
import { getMetricsByNode } from './prometheus.js';
import { ordersDb, chatsDb } from '../sources/simulatedDatabases.js';

const settle = (promise) =>
  promise.then((value) => ({ status: 'fulfilled', value }), (reason) => ({ status: 'rejected', reason }));

const valueOf = (settled, label, errors) => {
  if (settled.status === 'fulfilled') return settled.value;
  errors.push(`${label}: ${settled.reason?.message ?? settled.reason}`);
  return null;
};

/**
 * Collects one heartbeat for the window [from, to) and saves it.
 *
 * Writes one record per node (CPU + memory from that node's node_exporter) and one cluster record
 * holding the order/chat counts, which belong to the whole cluster rather than to any single node.
 * Every source runs in parallel; a failing source stores null instead of dropping the record.
 */
export async function collectHeartbeat(from, to) {
  const [metrics, orders, chats] = await Promise.all([
    getMetricsByNode(to), // CPU + memory per node, from node_exporter via Prometheus
    settle(ordersDb.countBetween(from, to)),
    settle(chatsDb.countBetween(from, to)),
  ]);

  const errors = [...metrics.errors];
  if (metrics.nodes.size === 0) errors.push('no node_exporter instances returned by Prometheus');

  const nodeDocs = [...metrics.nodes.values()].map((m) => ({
    datetime: from,
    meta: { cluster: m.cluster, node: m.node },
    cpuUsage: m.cpuUsage,
    memoryUsage: m.memoryUsage,
    netRxBps: m.netRxBps,
    netTxBps: m.netTxBps,
    orders: null,
    chats: null,
  }));

  const clusterDoc = {
    datetime: from,
    meta: { cluster: CLUSTER_NODE, node: CLUSTER_NODE },
    cpuUsage: null,
    memoryUsage: null,
    netRxBps: null,
    netTxBps: null,
    orders: valueOf(orders, 'orders', errors),
    chats: valueOf(chats, 'chats', errors),
  };

  const docs = [...nodeDocs, clusterDoc];
  await Heartbeat.collection.insertMany(docs, { ordered: false }); // native insert: skips Mongoose overhead
  return { docs, nodeDocs, clusterDoc, errors };
}

/**
 * Runs the heartbeat on a cron schedule (default: the top of every minute).
 * Each run covers the interval that just ended, e.g. a run at 14:06:00 saves [14:05:00, 14:06:00).
 * Runs are independent: a slow or failed run never delays the next one.
 */
export function startCollector({ cronExpression = config.cronExpression, intervalMs = config.intervalMs, onTick } = {}) {
  if (!cron.validate(cronExpression)) throw new Error(`HEARTBEAT_CRON is not a valid cron expression: ${cronExpression}`);
  let saved = 0;
  let failed = 0;

  const task = cron.schedule(cronExpression, () => {
    // The job fires a few ms after the boundary; snap to the exact boundary so windows never overlap.
    const to = new Date(Math.round(Date.now() / intervalMs) * intervalMs);
    const from = new Date(to.getTime() - intervalMs);

    collectHeartbeat(from, to)
      .then(({ nodeDocs, clusterDoc, errors }) => {
        saved += 1;
        if (errors.length) console.warn(`[heartbeat] ${from.toISOString()} partial:`, errors.join(' | '));
        const perNode = nodeDocs.map((d) => `${d.meta.cluster}/${d.meta.node} cpu=${d.cpuUsage}%`).join(', ') || 'no nodes';
        console.log(
          `[heartbeat] ${from.toISOString()} saved=${saved} failed=${failed} nodes=${nodeDocs.length} [${perNode}] orders=${clusterDoc.orders} chats=${clusterDoc.chats}`,
        );
        onTick?.({ nodeDocs, clusterDoc });
      })
      .catch((err) => {
        failed += 1;
        console.error(`[heartbeat] ${from.toISOString()} failed to save:`, err.message);
      });
  });

  console.log(`[heartbeat] cron "${cronExpression}" started, each record covers ${intervalMs / 60_000} minute(s)`);
  return () => task.stop();
}
