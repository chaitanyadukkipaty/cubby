// Starts one real Cubby server (+ PocketBase) for the whole e2e run; workers read its URL from env.
// GitHub's "latest release" API is replaced by a local stub whose answer specs can change via POST /set?tag=vX.Y.Z.
import http from 'node:http';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { startServer, ROOT } from '../helpers/server.js';

export default async function globalSetup() {
  const [maj, min, pat] = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version.split('.').map(Number);
  let tag = `v${maj}.${min}.${pat + 1}`;
  const releases = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    if (req.method === 'POST' && url.pathname === '/set') tag = url.searchParams.get('tag');
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ tag_name: tag, html_url: `https://github.com/chaitanyadukkipaty/cubby/releases/tag/${tag}` }));
  });
  await new Promise((r) => releases.listen(0, '127.0.0.1', r));
  const releasesUrl = `http://127.0.0.1:${releases.address().port}`;

  const server = await startServer({ CUBBY_UPDATE_CHECK: '1', CUBBY_UPDATE_URL: `${releasesUrl}/releases/latest` });
  process.env.CUBBY_E2E_URL = server.url;
  process.env.CUBBY_E2E_PORT = String(server.port);
  process.env.CUBBY_E2E_RELEASES_URL = releasesUrl;
  return async () => {
    await server.stop();
    releases.close();
  };
}
