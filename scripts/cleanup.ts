import { readConfig } from "../apps/api/src/config.js";
import { createDatabase, migrate } from "../apps/api/src/db.js";
import { createStorage } from "../apps/api/src/storage.js";
import { cleanupResources } from "../apps/api/src/services/cleanup.js";

const config = readConfig();
const db = await createDatabase(config);
try {
    const storage = createStorage(config);
    await storage.validate?.();
    await migrate(db);
    const result = await cleanupResources({ db, storage });
    console.log(result);
    if (result.failures) process.exitCode = 1;
} finally {
    await db.close();
}