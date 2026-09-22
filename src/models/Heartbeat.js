import mongoose from 'mongoose';
import { config } from '../config.js';

/** Marker used for the record that holds the cluster-wide counts (orders, chats). */
export const CLUSTER_NODE = '__cluster__';

/**
 * One record per node per minute, plus one counts record per minute:
 *   { datetime, meta: { cluster: "backend", node: "10.0.0.12:9100" }, cpuUsage: 71, memoryUsage: 60, … }
 *   { datetime, meta: { cluster: "__cluster__", node: "__cluster__" }, orders: 100, chats: 500, … }
 *
 * CPU and memory belong to one node in one cluster; orders and chats belong to the whole system,
 * so they are stored once instead of being repeated (and double-counted) on every node's record.
 * The unused fields are null, which makes the API aggregation work without any special cases:
 * $avg skips the nulls in the counts record, $sum skips the nulls in the node records.
 *
 * `meta` is the collection's metaField: MongoDB groups records with the same cluster+node together
 * on disk, and adding or removing a node or a whole cluster needs no change here.
 */
const HeartbeatSchema = new mongoose.Schema(
  {
    datetime: { type: Date, required: true }, // start of the minute this record covers
    meta: {
      cluster: { type: String, required: true }, // e.g. "backend", or CLUSTER_NODE on the counts record
      node: { type: String, required: true }, // node_exporter instance, or CLUSTER_NODE
    },
    cpuUsage: { type: Number, min: 0, max: 100, default: null }, // % of this node's CPU in use
    memoryUsage: { type: Number, min: 0, max: 100, default: null }, // % of this node's RAM in use
    netRxBps: { type: Number, min: 0, default: null }, // network received, bits per second (avg over the minute)
    netTxBps: { type: Number, min: 0, default: null }, // network sent, bits per second (avg over the minute)
    orders: { type: Number, min: 0, default: null }, // order requests in the minute, system-wide
    chats: { type: Number, min: 0, default: null }, // chats sent in the minute, system-wide
  },
  {
    collection: 'heartbeats',
    versionKey: false,
    timeseries: { timeField: 'datetime', metaField: 'meta', granularity: 'seconds' },
    expireAfterSeconds: config.retentionDays * 24 * 60 * 60,
    autoCreate: false, // created explicitly in db.js so we can verify the type
  },
);

export const Heartbeat = mongoose.model('Heartbeat', HeartbeatSchema);
