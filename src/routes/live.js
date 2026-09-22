import { Router } from 'express';
import { config } from '../config.js';
import { getLiveByNode } from '../services/prometheus.js';

export const router = Router();

const round2 = (v) => (v == null ? null : Math.round(v * 100) / 100);

/**
 * GET /api/live?cluster=backend&node=backend-1,backend-2
 * CPU, memory and disk of the selected nodes right now, straight from Prometheus.
 * Nothing here comes from the database and the From/To range does not apply.
 *
 * Totals across several nodes are weighted by size, the same way for all three:
 *   CPU    = busy cores / all cores      (a 32-core node counts more than a 4-core one)
 *   memory = used bytes / total bytes
 *   disk   = free bytes / total bytes
 */
router.get('/', async (req, res) => {
  const cluster = String(req.query.cluster || 'all');
  const node = String(req.query.node || 'all');
  const selected = node === 'all' ? null : new Set(node.split(',').map((n) => n.trim()).filter(Boolean));

  try {
    const { nodes: all, errors } = await getLiveByNode();
    const nodes = all
      .filter((n) => cluster === 'all' || n.cluster === cluster)
      .filter((n) => !selected || selected.has(n.node))
      .sort((a, b) => a.cluster.localeCompare(b.cluster) || a.node.localeCompare(b.node, undefined, { numeric: true }));

    const sum = (list, pick) => list.reduce((t, n) => t + pick(n), 0);
    const withCpu = nodes.filter((n) => n.cpu.usage != null && n.cpu.cores);
    const withMem = nodes.filter((n) => n.memory.totalBytes);
    const withDisk = nodes.filter((n) => n.disk.sizeBytes);
    const cores = sum(withCpu, (n) => n.cpu.cores);
    const memTotal = sum(withMem, (n) => n.memory.totalBytes);
    const memUsed = sum(withMem, (n) => n.memory.usedBytes);

    res.json({
      at: new Date().toISOString(),
      cpuWindow: config.rateWindow,
      mountpoint: config.diskMountpoint,
      nodes,
      totals: {
        cpu: { usage: cores ? round2(sum(withCpu, (n) => (n.cpu.usage * n.cpu.cores) / 100) / cores * 100) : null, cores },
        memory: { usage: memTotal ? round2((memUsed / memTotal) * 100) : null, usedBytes: memUsed, totalBytes: memTotal },
        disk: { availBytes: sum(withDisk, (n) => n.disk.availBytes), sizeBytes: sum(withDisk, (n) => n.disk.sizeBytes) },
      },
      errors,
    });
  } catch (err) {
    res.status(502).json({ error: `Prometheus unavailable: ${err.message}` });
  }
});
