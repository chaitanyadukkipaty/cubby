// Starts one real Cubby server (+ PocketBase) for the whole e2e run; workers read its URL from env.
import { startServer } from '../helpers/server.js';

export default async function globalSetup() {
  const server = await startServer();
  process.env.CUBBY_E2E_URL = server.url;
  process.env.CUBBY_E2E_PORT = String(server.port);
  return async () => {
    await server.stop();
  };
}
