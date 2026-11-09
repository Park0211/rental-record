import { readConfig } from '../apps/api/src/config.js';
import { createDatabase, migrate } from '../apps/api/src/db.js';

const db = await createDatabase(readConfig());
try {
  await migrate(db);
  console.log('Database migrations applied.');
} finally {
  await db.close();
}
