/**
 * Fills the collection with historical data (one record per node per interval, plus a cluster record)
 * so the date picker has something to show.
 *
 * The nodes are the REAL node_exporter targets, read from Prometheus, so seeded history and live
 * records share the same node names.
 *
 *   npm run seed            -> last 24 hours
 *   npm run seed -- 72      -> last 72 hours
 */
import { config } from '../src/config.js';
import { connectDb, disconnectDb } from '../src/db.js';
import { Heartbeat, CLUSTER_NODE } from '../src/models/Heartbeat.js';
import { queryPrometheus } from '../src/services/prometheus.js';
import { poisson, trafficFactor } from '../src/sources/simulatedDatabases.js';

const hours = Number(process.argv[2] ?? 24);

// Ask Prometheus which nodes exist right now.
const selector = config.nodeInstance
  ? `job="${config.nodeJob}",instance="${config.nodeInstance}"`
  : `job="${config.nodeJob}"`;
let discovered = [];
try {
  discovered = await queryPrometheus(`up{${selector}}`);
} catch (err) {
  console.error(`[seed] could not reach Prometheus at ${config.prometheusUrl}: ${err.message}`);
  process.exit(1);
}
const nodeNames = discovered.map((d) => `${d.cluster}/${d.node}`).filter(Boolean).sort();
if (nodeNames.length === 0) {
  console.error(
    `[seed] Prometheus knows no targets for job="${config.nodeJob}". ` +
      'Add your nodes to prometheus.yml and check http://<prometheus>:9090/targets first.',
  );
  process.exit(1);
}

// Each node gets its own baseline, so the seeded history isn't one machine repeated.
const nodes = discovered
  .filter((d) => d.node)
  .sort((a, b) => `${a.cluster}/${a.node}`.localeCompare(`${b.cluster}/${b.node}`))
  .map((d, i) => ({ cluster: d.cluster, node: d.node, cpuBias: 0.7 + i * 0.3, memory: 32 + i * 9 }));
console.log(`[seed] using ${nodes.length} node(s) from Prometheus: ${nodeNames.join(', ')}`);

const BATCH = 10_000;

await connectDb();

const step = config.intervalMs;
const end = Math.floor(Date.now() / step) * step - 60_000; // stop a minute ago so it won't overlap the live collector
const start = end - hours * 3_600_000;
// Seeding twice over the same range would store two records per timestamp, and the API
// sums them — so refuse instead of silently doubling the counts.
const existing = await Heartbeat.countDocuments({ datetime: { $gte: new Date(start), $lt: new Date(end) } });
if (existing) {
  console.error(
    `[seed] ${existing.toLocaleString()} records already cover this range. Drop the collection first:\n` +
      '  mongosh heartbeat --eval "db.heartbeats.drop()"',
  );
  await disconnectDb();
  process.exit(1);
}

let batch = [];
let inserted = 0;

for (let t = start; t < end; t += step) {
  const datetime = new Date(t);
  const load = trafficFactor(datetime);

  for (const node of nodes) {
    node.memory = Math.min(95, Math.max(25, node.memory + (Math.random() - 0.5) * 0.3 + (load - 0.5) * 0.02));
    batch.push({
      datetime,
      meta: { cluster: node.cluster, node: node.node },
      cpuUsage: Math.round(Math.min(100, Math.max(0, (8 + load * 55) * node.cpuBias + (Math.random() - 0.5) * 12))),
      memoryUsage: Math.round(node.memory),
      orders: null,
      chats: null,
    });
  }

  // Orders and chats belong to the cluster, so they are stored once per interval.
  batch.push({
    datetime,
    meta: { cluster: CLUSTER_NODE, node: CLUSTER_NODE },
    cpuUsage: null,
    memoryUsage: null,
    orders: poisson(6 * (step / 1000) * load), // counts cover the whole interval
    chats: poisson(25 * (step / 1000) * load),
  });
  if (batch.length === BATCH) {
    await Heartbeat.collection.insertMany(batch, { ordered: false });
    inserted += batch.length;
    batch = [];
    process.stdout.write(`\r[seed] ${inserted.toLocaleString()} records`);
  }
}
if (batch.length) {
  await Heartbeat.collection.insertMany(batch, { ordered: false });
  inserted += batch.length;
}
console.log(
  `\r[seed] inserted ${inserted.toLocaleString()} records covering ${hours}h ` +
    `for ${nodes.length} node${nodes.length === 1 ? '' : 's'}`,
);
await disconnectDb();
