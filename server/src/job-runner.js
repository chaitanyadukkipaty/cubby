// Entry point of a job's child process, spawned by jobs.js with the Node permission model on and an empty
// environment. Receives { file, sdk, prefix, env } over IPC, runs the job's default export, reports how it ended.
import { pathToFileURL } from 'node:url';
import { lockDown, ipcClient, createContext } from './job-sandbox.js';

const request = ipcClient();
const finish = (msg) => process.send(msg, () => process.exit(0));

process.once('message', async ({ file, sdk, prefix, env }) => {
  try {
    lockDown();
    const { default: PocketBase } = await import(pathToFileURL(sdk).href);
    const job = await import(pathToFileURL(file).href);
    if (typeof job.default !== 'function') throw new Error('A job must `export default async (ctx) => { ... }`');
    await job.default(createContext({ PocketBase, prefix, env, request }));
    finish({ type: 'done' });
  } catch (err) {
    finish({ type: 'error', error: err instanceof Error ? (err.stack ?? err.message) : String(err) });
  }
});
