import { readConfig } from '../apps/api/src/config.js';
import { createDatabase, migrate } from '../apps/api/src/db.js';
import { createStorage } from '../apps/api/src/storage.js';
import { seedDemo } from '../apps/api/src/seed.js';

const config = readConfig();
if (config.mode !== 'demo' || config.isProduction)
  throw new Error('Seed data is only available in local demo mode.');
const db = await createDatabase(config);
try {
  await migrate(db);
  const created = await seedDemo(db, createStorage(config));
  console.log(created ? 'Sample records created.' : 'Existing records found. Nothing was changed.');
} finally {
  await db.close();
}
