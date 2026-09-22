import { Router } from 'express';
import { Heartbeat, CLUSTER_NODE } from '../models/Heartbeat.js';
import { config } from '../config.js';

export const router = Router();

const MAX_POINTS = 1500; // enough for a smooth line chart, small enough for the browser
const MAX_RANGE_MS = 3 * 366 * 24 * 60 * 60 * 1000; // 3 years

// Allowed bucket sizes, smallest first. unit/binSize map directly to $dateTrunc.
export const BUCKETS = [
  { key: '1s', ms: 1_000, unit: 'second', binSize: 1 },
  { key: '5s', ms: 5_000, unit: 'second', binSize: 5 },
  { key: '15s', ms: 15_000, unit: 'second', binSize: 15 },
  { key: '1m', ms: 60_000, unit: 'minute', binSize: 1 },
  { key: '5m', ms: 300_000, unit: 'minute', binSize: 5 },
  { key: '15m', ms: 900_000, unit: 'minute', binSize: 15 },
  { key: '1h', ms: 3_600_000, unit: 'hour', binSize: 1 },
  { key: '6h', ms: 21_600_000, unit: 'hour', binSize: 6 },
  { key: '1d', ms: 86_400_000, unit: 'day', binSize: 1 },
  { key: '1w', ms: 604_800_000, unit: 'week', binSize: 1 },
  { key: '1mo', ms: 2_629_800_000, unit: 'month', binSize: 1 }, // ms is the average month, used only to rank buckets
];

// Friendly names for the UI and for error messages.
export const BUCKET_LABELS = { '1s': 'second', '5s': '5 seconds', '15s': '15 seconds', '1m': 'minute',
  '5m': '5 minutes', '15m': '15 minutes', '1h': 'hour', '6h': '6 hours', '1d': 'day', '1w': 'week', '1mo': 'month' };

// A bucket smaller than the heartbeat interval would just return the raw records with gaps.
export const availableBuckets = () => BUCKETS.filter((b) => b.ms >= config.intervalMs && b.ms % config.intervalMs === 0);

/** Smallest bucket (not finer than the heartbeat) that keeps the chart under MAX_POINTS. */
export function pickBucket(rangeMs, requested = 'auto') {
  const buckets = availableBuckets();
  const auto = buckets.find((b) => rangeMs / b.ms <= MAX_POINTS) ?? buckets.at(-1);
  if (requested === 'auto') return auto;
  const chosen = BUCKETS.find((b) => b.key === requested);
  if (chosen && chosen.ms < buckets[0].ms) return auto.ms > buckets[0].ms ? auto : buckets[0];
  if (!chosen) return null;
  return chosen.ms < auto.ms ? auto : chosen; // too fine for this range -> upgrade
}

export function parseRange(query) {
  const to = query.to ? new Date(query.to) : new Date();
  const from = query.from ? new Date(query.from) : new Date(to.getTime() - 60 * 60 * 1000);
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) {
    return { error: '"from" and "to" must be valid ISO-8601 dates, e.g. 2026-09-17T10:00:00Z' };
  }
  if (from >= to) return { error: '"from" must be before "to"' };
  if (to - from > MAX_RANGE_MS) return { error: 'Range cannot be longer than 3 years' };
  return { from, to };
}

/**
 * GET /api/heartbeats?from=ISO&to=ISO&bucket=auto|1m|5m|15m|1h|6h|1d|1w|1mo&cluster=all|<name>&node=all|<instance>[,…]&perNode=1
 * Returns aggregated points for a line chart plus totals for the whole range.
 */
router.get('/', async (req, res, next) => {
  try {
    const range = parseRange(req.query);
    if (range.error) return res.status(400).json({ error: range.error });
    const { from, to } = range;

    const bucket = pickBucket(to - from, req.query.bucket || 'auto');
    if (!bucket) {
      return res.status(400).json({ error: `bucket must be auto or one of ${availableBuckets().map((b) => b.key).join(', ')}` });
    }

    // Day/week/month grouping depends on the timezone: a "day" in Cairo starts 3 hours before a UTC day.
    const timezone = String(req.query.tz || config.timezone);
    const dateTrunc = { date: '$datetime', unit: bucket.unit, binSize: bucket.binSize, timezone };
    if (bucket.unit === 'week') dateTrunc.startOfWeek = config.weekStart;

    const match = { datetime: { $gte: from, $lt: to } };
    // cluster=backend narrows to one cluster; node=a:9100,b:9100 narrows to some of its nodes.
    // The counts record is always kept, because orders and chats belong to the whole system
    // rather than to the selected machines.
    const cluster = String(req.query.cluster || 'all');
    const node = String(req.query.node || 'all');
    const selected = node === 'all' ? null : node.split(',').map((n) => n.trim()).filter(Boolean);

    const scope = []; // matches the node records the caller asked for
    if (cluster !== 'all') scope.push({ 'meta.cluster': cluster });
    if (selected?.length) scope.push({ 'meta.node': { $in: selected } });
    if (scope.length) {
      match.$or = [{ $and: scope }, { 'meta.node': CLUSTER_NODE }];
    }

    const points = await Heartbeat.aggregate([
      { $match: match },
      {
        $group: {
          _id: { $dateTrunc: dateTrunc },
          cpuUsage: { $avg: '$cpuUsage' },
          cpuUsageMax: { $max: '$cpuUsage' },
          memoryUsage: { $avg: '$memoryUsage' },
          memoryUsageMax: { $max: '$memoryUsage' },
          orders: { $sum: '$orders' },
          chats: { $sum: '$chats' },
          nodes: { $addToSet: '$meta.node' },
          // One "sample" is one heartbeat, so count the counts records, not the per-node ones.
          samples: { $sum: { $cond: [{ $eq: ['$meta.node', CLUSTER_NODE] }, 1, 0] } },
        },
      },
      { $sort: { _id: 1 } },
      {
        $project: {
          _id: 0,
          datetime: '$_id',
          cpuUsage: { $round: ['$cpuUsage', 2] }, // average over the bucket
          cpuUsageMax: 1,
          memoryUsage: { $round: ['$memoryUsage', 2] },
          memoryUsageMax: 1,
          orders: 1,
          chats: 1,
          samples: 1,
          nodeCount: { $size: { $setDifference: ['$nodes', [CLUSTER_NODE]] } },
        },
      },
    ]);

    // One series per node, for the per-node charts. Cluster records are excluded: they hold no CPU.
    const series = req.query.perNode === '1' || req.query.perNode === 'true'
      ? await Heartbeat.aggregate([
          // Same range and scope as above, minus the counts records (they hold no CPU/memory).
          {
            $match: {
              datetime: match.datetime,
              $and: [...scope, { 'meta.node': { $ne: CLUSTER_NODE } }],
            },
          },
          {
            $group: {
              _id: { bucket: { $dateTrunc: dateTrunc }, node: '$meta.node', cluster: '$meta.cluster' },
              cpuUsage: { $avg: '$cpuUsage' },
              memoryUsage: { $avg: '$memoryUsage' },
            },
          },
          { $sort: { '_id.bucket': 1 } },
          {
            $group: {
              _id: { node: '$_id.node', cluster: '$_id.cluster' },
              avgCpuUsage: { $avg: '$cpuUsage' },
              avgMemoryUsage: { $avg: '$memoryUsage' },
              points: {
                $push: {
                  datetime: '$_id.bucket',
                  cpuUsage: { $round: ['$cpuUsage', 2] },
                  memoryUsage: { $round: ['$memoryUsage', 2] },
                },
              },
            },
          },
          { $sort: { avgCpuUsage: -1 } }, // busiest node first
          {
            $project: {
              _id: 0,
              node: '$_id.node',
              cluster: '$_id.cluster',
              avgCpuUsage: { $round: ['$avgCpuUsage', 2] },
              avgMemoryUsage: { $round: ['$avgMemoryUsage', 2] },
              points: 1,
            },
          },
        ])
      : undefined;

    res.json({
      from: from.toISOString(),
      to: to.toISOString(),
      cluster,
      node,
      selectedNodes: selected ?? 'all',
      bucket: bucket.key,
      bucketLabel: BUCKET_LABELS[bucket.key],
      bucketMs: bucket.ms,
      timezone,
      count: points.length,
      totals: summarize(points),
      points,
      ...(series ? { series } : {}),
    });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/heartbeats/nodes — the nodes that reported recently, for the dashboard's picker.
 * Reads the last 7 days so a node that has gone offline still shows up.
 */
router.get('/nodes', async (req, res, next) => {
  try {
    const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    const match = { datetime: { $gte: since }, 'meta.node': { $ne: CLUSTER_NODE } };
    if (req.query.cluster && req.query.cluster !== 'all') match['meta.cluster'] = String(req.query.cluster);

    // The pairs, so the picker can group the nodes under their cluster.
    const pairs = await Heartbeat.aggregate([
      { $match: match },
      { $group: { _id: { cluster: '$meta.cluster', node: '$meta.node' } } },
      { $sort: { '_id.cluster': 1, '_id.node': 1 } },
    ]);

    const byCluster = new Map();
    for (const { _id } of pairs) {
      if (!byCluster.has(_id.cluster)) byCluster.set(_id.cluster, []);
      byCluster.get(_id.cluster).push(_id.node);
    }
    const groups = [...byCluster].map(([cluster, nodes]) => ({ cluster, nodes }));
    res.json({
      groups,
      nodes: groups.flatMap((g) => g.nodes).sort(), // flat list, for callers that don't group
    });
  } catch (err) {
    next(err);
  }
});

/** GET /api/heartbeats/clusters — the clusters that reported in the last 7 days. */
router.get('/clusters', async (_req, res, next) => {
  try {
    const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    const clusters = await Heartbeat.distinct('meta.cluster', { datetime: { $gte: since } });
    res.json({ clusters: clusters.filter((c) => c !== CLUSTER_NODE).sort() });
  } catch (err) {
    next(err);
  }
});

/** GET /api/heartbeats/latest?limit=60 — raw records, oldest first. */
router.get('/latest', async (req, res, next) => {
  try {
    const limit = Math.min(Math.max(Number.parseInt(req.query.limit, 10) || 60, 1), 3600);
    const docs = await Heartbeat.find({}, { _id: 0 }).sort({ datetime: -1 }).limit(limit).lean();
    res.json({ count: docs.length, points: docs.reverse() });
  } catch (err) {
    next(err);
  }
});

export function summarize(points) {
  const totals = { orders: 0, chats: 0, avgCpuUsage: null, maxCpuUsage: null, avgMemoryUsage: null,
    maxMemoryUsage: null, samples: 0, nodeCount: 0 };
  const weighted = { cpu: [0, 0], memory: [0, 0] }; // [sum of value*samples, samples]
  for (const p of points) {
    totals.orders += p.orders;
    totals.chats += p.chats;
    totals.samples += p.samples;
    totals.nodeCount = Math.max(totals.nodeCount, p.nodeCount ?? 0);
    if (p.cpuUsage != null) { weighted.cpu[0] += p.cpuUsage * p.samples; weighted.cpu[1] += p.samples; }
    if (p.memoryUsage != null) { weighted.memory[0] += p.memoryUsage * p.samples; weighted.memory[1] += p.samples; }
    if (p.cpuUsageMax != null) totals.maxCpuUsage = Math.max(totals.maxCpuUsage ?? 0, p.cpuUsageMax);
    if (p.memoryUsageMax != null) totals.maxMemoryUsage = Math.max(totals.maxMemoryUsage ?? 0, p.memoryUsageMax);
  }
  const avg = ([sum, n]) => (n ? Math.round((sum / n) * 100) / 100 : null);
  totals.avgCpuUsage = avg(weighted.cpu);
  totals.avgMemoryUsage = avg(weighted.memory);
  return totals;
}
