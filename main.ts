// Entry point. Binds an ephemeral port, registers it with the harness
// environment, then polls /done until the suite finishes and exits.
//
//   MAKEFUN_SHOP_TOKEN   bearer token the suite presents on every call
//   MAKEFUN_ENV_URL      harness base URL (register + /done live here)
//   PORT                 optional fixed port; default is an ephemeral one
//
// Run:  node --experimental-strip-types main.ts

import { createApp } from './app.ts';

const token = process.env.MAKEFUN_SHOP_TOKEN ?? '';
const envUrl = (process.env.MAKEFUN_ENV_URL ?? '').replace(/\/$/, '');
const fixedPort = process.env.PORT ? Number(process.env.PORT) : 0;

const server = createApp(token);

function postJson(url: string, payload: unknown): Promise<{ status: number; text: string }> {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const data = Buffer.from(JSON.stringify(payload), 'utf8');
    const opts = {
      hostname: u.hostname,
      port: u.port ? Number(u.port) : u.protocol === 'https:' ? 443 : 80,
      path: `${u.pathname}${u.search}`,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': data.length, Authorization: `Bearer ${token}` },
    };
    const start = (request: typeof httpRequest): void => {
      const req = request(opts);
      req.on('error', reject);
      req.on('response', (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, text: Buffer.concat(chunks).toString('utf8') }));
      });
      req.end(data);
    };
    if (u.protocol === 'https:') void awaitImportHttps().then((m) => start(m.request), reject);
    else start(httpRequest);
  });
}

import { request as httpRequest } from 'node:http';

let httpsMod: typeof import('node:https') | null = null;
async function awaitImportHttps(): Promise<typeof import('node:https')> {
  if (!httpsMod) httpsMod = await import('node:https');
  return httpsMod;
}

function getJson(url: string): Promise<{ status: number; text: string }> {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const useHttps = u.protocol === 'https:';
    const doReq = (mod: { request: typeof httpRequest }): void => {
      const req = mod.request({
        hostname: u.hostname,
        port: u.port ? Number(u.port) : useHttps ? 443 : 80,
        path: `${u.pathname}${u.search}`,
        method: 'GET',
        headers: { Authorization: `Bearer ${token}` },
      });
      req.on('error', reject);
      req.on('response', (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, text: Buffer.concat(chunks).toString('utf8') }));
      });
      req.end();
    };
    if (useHttps) {
      void awaitImportHttps().then(doReq, reject);
    } else {
      doReq({ request: httpRequest });
    }
  });
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function waitDone(): Promise<void> {
  if (!envUrl) return;
  for (;;) {
    try {
      const { text } = await getJson(`${envUrl}/done`);
      const parsed = JSON.parse(text) as { done?: boolean };
      if (parsed.done) return;
    } catch {
      // Harness not up yet; keep polling.
    }
    await sleep(500);
  }
}

async function main(): Promise<void> {
  await new Promise<void>((resolve) => {
    server.listen(fixedPort, '127.0.0.1', () => resolve());
  });
  const addr = server.address();
  const port = typeof addr === 'object' && addr !== null ? addr.port : fixedPort;
  if (envUrl) {
    try {
      await postJson(`${envUrl}/register`, { port });
    } catch (err) {
      console.error('register failed', err);
      process.exit(1);
    }
    await waitDone();
  } else {
    console.log(`forge listening on 127.0.0.1:${port}`);
    await new Promise<void>(() => {
      // No harness: stay up until killed.
    });
  }
  server.close();
  process.exit(0);
}

void main();
