// HTTP front door: health check, bearer auth, then dispatch to REST,
// GraphQL, MCP or the git smart-HTTP handlers. Routing is plain string
// work on the request line — no URL object per request.

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { getRepo } from './src/store.ts';
import { handleRest, errJson, readBody } from './src/rest.ts';
import { handleGraphql } from './src/graphql.ts';
import { handleMcp } from './src/mcp.ts';
import { infoRefs, receivePack, uploadPack } from './src/gitserver.ts';

let reqCounter = 0;

function bearer(req: IncomingMessage): string | null {
  const h = req.headers.authorization;
  if (!h || !h.startsWith('Bearer ')) return null;
  return h.slice(7);
}

export function createApp(token: string) {
  const server = createServer((req, res) => {
    void handle(req, res).catch((err) => {
      // Never let one request kill the process: answer 500 JSON.
      try {
        const body = Buffer.from(JSON.stringify({ message: err instanceof Error ? err.message : 'internal error' }), 'utf8');
        res.writeHead(500, {
          'Content-Type': 'application/json; charset=utf-8',
          'Content-Length': body.length,
          'X-GitHub-Request-Id': 'forge-error',
        });
        res.end(body);
      } catch {
        try {
          res.destroy();
        } catch {
          // ignore
        }
      }
    });
  });

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    reqCounter += 1;
    const reqId = `req-${reqCounter}`;
    const method = req.method ?? 'GET';
    const rawUrl = req.url ?? '/';
    const path = rawUrl.split('?')[0] as string;

    if (path === '/healthz') {
      const body = Buffer.from('{"ok":true}', 'utf8');
      res.writeHead(200, {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Length': body.length,
        'X-GitHub-Request-Id': reqId,
      });
      res.end(body);
      return;
    }

    // Every other surface needs the bearer token.
    if (bearer(req) !== token) {
      errJson(res, 401, 'Requires authentication', reqId);
      return;
    }

    if (path === '/api/graphql') {
      if (await handleGraphql(req, res, reqId)) return;
      errJson(res, 404, 'Not Found', reqId);
      return;
    }
    if (path === '/mcp') {
      if (await handleMcp(req, res, reqId)) return;
      errJson(res, 404, 'Not Found', reqId);
      return;
    }
    if (path.startsWith('/api/v3')) {
      const origin = `http://${req.headers.host ?? '127.0.0.1'}`;
      if (await handleRest(req, res, reqId, origin)) return;
      errJson(res, 404, 'Not Found', reqId);
      return;
    }

    // Git smart HTTP: /{owner}/{repo}.git/info/refs and /{owner}/{repo}.git/git-{upload,receive}-pack
    const gitMatch = /^\/([^/]+)\/([^/]+)\.git\/(.*)$/.exec(path);
    if (gitMatch) {
      const owner = decodeURIComponent(gitMatch[1] as string);
      const repoName = decodeURIComponent(gitMatch[2] as string);
      const tail = gitMatch[3] as string;
      const repo = getRepo(owner, repoName);
      const wantV2 = (req.headers['git-protocol'] ?? '') === 'version=2';
      if (tail === 'info/refs') {
        if (method !== 'GET') {
          errJson(res, 404, 'Not Found', reqId);
          return;
        }
        const q = rawUrl.indexOf('?');
        const service = q >= 0 ? new URLSearchParams(rawUrl.slice(q + 1)).get('service') ?? '' : '';
        const reply = infoRefs(repo, service, wantV2);
        res.writeHead(reply.status, {
          'Content-Type': reply.contentType,
          'Content-Length': reply.body.length,
          'X-GitHub-Request-Id': reqId,
        });
        res.end(reply.body);
        return;
      }
      if (tail === 'git-upload-pack' || tail === 'git-receive-pack') {
        if (method !== 'POST') {
          errJson(res, 404, 'Not Found', reqId);
          return;
        }
        if (!repo) {
          errJson(res, 404, 'Not Found', reqId);
          return;
        }
        const body = await readBody(req);
        const reply = tail === 'git-upload-pack' ? uploadPack(repo, body, wantV2) : receivePack(repo, body);
        res.writeHead(reply.status, {
          'Content-Type': reply.contentType,
          'Content-Length': reply.body.length,
          'X-GitHub-Request-Id': reqId,
        });
        res.end(reply.body);
        return;
      }
      errJson(res, 404, 'Not Found', reqId);
      return;
    }

    errJson(res, 404, 'Not Found', reqId);
  }

  return server;
}
