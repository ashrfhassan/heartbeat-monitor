/**
 * Simulated external databases.
 *
 * In a real system these would be two different connections, e.g.
 *   ordersDb: PostgreSQL  -> SELECT COUNT(*) FROM order_requests WHERE created_at >= $1 AND created_at < $2
 *   chatsDb:  MongoDB     -> db.messages.countDocuments({ createdAt: { $gte: from, $lt: to } })
 *
 * Here they add realistic latency, a daily traffic curve, random noise and the occasional failure,
 * so the heartbeat code handles the same situations it would in production.
 */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Traffic multiplier for the time of day (Cairo time): quiet at night, peak in the evening.
export function trafficFactor(date) {
  const hour = (date.getUTCHours() + 3 + date.getUTCMinutes() / 60) % 24;
  return 0.25 + 0.75 * Math.max(0, Math.sin(((hour - 6) / 24) * 2 * Math.PI)) ** 1.5;
}

// Poisson-distributed random count with mean `lambda`.
export function poisson(lambda) {
  if (lambda <= 0) return 0;
  if (lambda > 30) return Math.max(0, Math.round(lambda + Math.sqrt(lambda) * gaussian()));
  const limit = Math.exp(-lambda);
  let k = 0;
  let p = 1;
  do {
    k += 1;
    p *= Math.random();
  } while (p > limit);
  return k - 1;
}

function gaussian() {
  const u = 1 - Math.random();
  const v = Math.random();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

class SimulatedDatabase {
  constructor({ name, baseRatePerSecond, latencyMs: [minLatency, maxLatency], failureRate }) {
    Object.assign(this, { name, baseRatePerSecond, minLatency, maxLatency, failureRate });
  }

  /** Count rows created in [from, to). */
  async countBetween(from, to) {
    await sleep(this.minLatency + Math.random() * (this.maxLatency - this.minLatency));
    if (Math.random() < this.failureRate) {
      throw new Error(`${this.name}: simulated query timeout`);
    }
    const seconds = (to - from) / 1000;
    // Random bursts: 2% of seconds get 3x traffic (flash sale, group chat spike…)
    const burst = Math.random() < 0.02 ? 3 : 1;
    return poisson(this.baseRatePerSecond * seconds * trafficFactor(from) * burst);
  }
}

export const ordersDb = new SimulatedDatabase({
  name: 'orders-db',
  baseRatePerSecond: 6,
  latencyMs: [8, 40],
  failureRate: 0.002,
});

export const chatsDb = new SimulatedDatabase({
  name: 'chats-db',
  baseRatePerSecond: 25,
  latencyMs: [5, 25],
  failureRate: 0.002,
});
