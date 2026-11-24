import { createApp } from './app.js';
import { readConfig } from './config.js';
import { createDatabase, migrate } from './db.js';
import { createStorage } from './storage.js';
import { seedDemo } from './seed.js';
import { cleanupResources } from './services/cleanup.js';

const config = readConfig();
const db = await createDatabase(config);
const storage = createStorage(config);
await storage.validate?.();
await migrate(db);
if (config.mode === 'demo') await seedDemo(db, storage);
const app = createApp({ db, storage, config });
const server = app.listen(config.port, config.host, () => {
    console.log(`Rental Record API: http://${config.host}:${config.port}`);
    if (config.mode === 'demo') console.log('Local demo: jordan@example.com / demo-pass-123');
});
let cleaning = false;
async function cleanup() {
    if (cleaning) return;
    cleaning = true;
    try {
        const result = await cleanupResources({ db, storage });
        if (result.failures) console.warn('Some photo cleanup operations will be retried. ');
    } catch {
        console.warn('Photo cleanup could not run. It will be retired.');
    } finally {
        cleaning = false;
    }
}
const cleanupTimer = setInterval(
    () => {
        void cleanup();
    },
    24 * 60 * 60 * 1000,
);
cleanupTimer.unref();
void cleanup();

let closing = false;
async function shutdown() {
    if(closing) return;
    closing = true;
    clearInterval(cleanupTimer);
    server.close(async () => {
        await db.close();
        process.exit(0);
    });
    setTimeout(() => {
        process.exit(1);
    }, 10_000).unref();
}
process.once('SIGINT', () => {
    void shutdown();
});
process.once('SIGTERM', () => {
    void shutdown();
});