import mongoose from 'mongoose';
import { config } from './config.js';
import { Heartbeat } from './models/Heartbeat.js';

export async function connectDb() {
  await mongoose.connect(config.mongoUri, { serverSelectionTimeoutMS: 5000 });

  // Time-series collections must be created with their options up front.
  // If a normal collection with the same name already exists, Mongo will NOT convert it.
  const name = Heartbeat.collection.collectionName;
  const [existing] = await mongoose.connection.db.listCollections({ name }).toArray();
  if (!existing) {
    // Created through the driver, not Heartbeat.createCollection(), so the timeseries
    // options are sent exactly as written here whatever Mongoose does with them.
    await mongoose.connection.db.createCollection(name, {
      timeseries: { timeField: 'datetime', metaField: 'meta', granularity: 'seconds' },
      expireAfterSeconds: config.retentionDays * 24 * 60 * 60,
    });
    console.log(`[db] created time-series collection "${name}"`);
  } else if (existing.type !== 'timeseries') {
    throw new Error(
      `Collection "${name}" exists but is a normal collection. Drop or rename it so it can be recreated as time-series.`,
    );
  } else if (existing.options?.timeseries?.metaField !== 'meta') {
    // The metaField is fixed when the collection is created and cannot be changed later.
    throw new Error(
      `Collection "${name}" uses the old metaField "${existing.options?.timeseries?.metaField}" ` +
        '(before cluster support). Drop it and re-seed:  mongosh heartbeat --eval "db.heartbeats.drop()"',
    );
  }
  // Time-series collections accept only a few index shapes; never let that stop startup.
  try {
    await Heartbeat.syncIndexes();
  } catch (err) {
    console.warn(`[db] index sync skipped: ${err.message}`);
  }
  console.log(`[db] connected to ${mongoose.connection.name}`);
}

export const disconnectDb = () => mongoose.disconnect();
