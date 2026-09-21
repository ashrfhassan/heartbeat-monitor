import { Router } from 'express';
import { Heartbeat, CLUSTER_NODE } from '../models/Heartbeat.js';
import { queryPrometheus } from '../services/prometheus.js';
import { config } from '../config.js';

export const router = Router();

/**
 * Compares the cluster each node currently reports in Prometheus with the cluster stored on its
 * older records, and returns the differences.
 *
 * Only nodes whose ADDRESS is unchanged can be matched this way. If a node's address changed too,
 * Prometheus has no way to say which old node it used to be, so those are left alone.
 */
async function findClusterDrift() {
  const selector = config.nodeInstance
    ? `job=~"${config.nodeJob}",instance="${config.nodeInstance}"`
    : `job=~"${config.nodeJob}"`;

  // What Prometheus says today: node -> cluster.
  // Just after a relabel the same node resolves twice (old and new labels) for ~5 minutes, so the
  // freshest series wins. `timestamp()` returns each sample's own scrape time — an instant query's
  // result timestamp is the evaluation time and is identical for both, so it cannot be used here.
  const live = await queryPrometheus(`timestamp(up{${selector}})`);
  const liveCluster = new Map();
  const scrapedAt = new Map();
  for (const s of live) {
    if (!s.node || s.value == null) continue;
    if ((scrapedAt.get(s.node) ?? -1) >= s.value) continue;
    scrapedAt.set(s.node, s.value);
    liveCluster.set(s.node, s.cluster);
  }

  // What the stored records say: one entry per (node, cluster) pair, with how many records it has
  const stored = await Heartbeat.aggregate([
    { $match: { 'meta.node': { $ne: CLUSTER_NODE } } },
    { $group: { _id: { node: '$meta.node', cluster: '$meta.cluster' }, records: { $sum: 1 } } },
  ]);

  const changes = [];
  for (const { _id, records } of stored) {
    const current = liveCluster.get(_id.node);
    if (current && current !== _id.cluster) {
      changes.push({ node: _id.node, from: _id.cluster, to: current, records });
    }
  }
  return {
    changes: changes.sort((a, b) => b.records - a.records),
    liveNodes: liveCluster.size,
  };
}

/** GET /api/maintenance/cluster-drift — what a sync would change, without changing anything. */
router.get('/cluster-drift', async (_req, res, next) => {
  try {
    res.json(await findClusterDrift());
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/maintenance/sync-clusters — rewrite the cluster on old records to match Prometheus.
 * The drift is recomputed here rather than trusted from the request, so the update can only ever
 * set a cluster that Prometheus is reporting right now.
 */
router.post('/sync-clusters', async (_req, res, next) => {
  try {
    const { changes } = await findClusterDrift();
    const applied = [];
    for (const change of changes) {
      const result = await Heartbeat.updateMany(
        { 'meta.node': change.node, 'meta.cluster': change.from },
        { $set: { 'meta.cluster': change.to } },
      );
      applied.push({ ...change, modified: result.modifiedCount });
      console.log(`[sync] ${change.node}: ${change.from} -> ${change.to} (${result.modifiedCount} records)`);
    }
    res.json({ applied, totalModified: applied.reduce((sum, a) => sum + a.modified, 0) });
  } catch (err) {
    next(err);
  }
});
