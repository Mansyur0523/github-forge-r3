// Smoke test: boots the forge on a scratch port and exercises health,
// REST repos/issues, GraphQL viewer and MCP discover/tools.
// Run: npm test

import { request } from 'node:http';
import { createApp } from '../app.ts';

const TOKEN = 'smoke-token';

interface Resp {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

function call(port: number, method: string, path: string, body?: unknown, auth = true): Promise<Resp> {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? null : Buffer.from(JSON.stringify(body), 'utf8');
    const req = request({
      hostname: '127.0.0.1',
      port,
      path,
      method,
      headers: {
        ...(auth ? { Authorization: `Bearer ${TOKEN}` } : {}),
        ...(data ? { 'Content-Type': 'application/json', 'Content-Length': data.length } : {}),
      },
    });
    req.on('error', reject);
    req.on('response', (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
    });
    if (data) req.end(data);
    else req.end();
  });
}

function check(name: string, cond: boolean): void {
  if (!cond) throw new Error(`FAIL: ${name}`);
  console.log(`ok: ${name}`);
}

const server = createApp(TOKEN);
await new Promise<void>((resolve) => {
  server.listen(0, '127.0.0.1', () => resolve());
});
const addr = server.address();
const port = typeof addr === 'object' && addr !== null ? addr.port : 0;

try {
  const health = await call(port, 'GET', '/healthz', undefined, false);
  check('healthz 200', health.status === 200 && JSON.parse(health.body).ok === true);

  const noAuth = await call(port, 'GET', '/api/v3/user', undefined, false);
  check('unauthenticated 401', noAuth.status === 401);

  const root = await call(port, 'GET', '/api/v3/');
  check('root 200 + scopes', root.status === 200 && String(root.headers['x-oauth-scopes'] ?? '').includes('repo'));

  const created = await call(port, 'POST', '/api/v3/user/repos', { name: 'smoke-repo', description: 'smoke' });
  check('create repo 201', created.status === 201 && JSON.parse(created.body).name === 'smoke-repo');

  const me = await call(port, 'GET', '/api/v3/user');
  const login = JSON.parse(me.body).login as string;
  check('viewer login', typeof login === 'string' && login.length > 0);

  const issue = await call(port, 'POST', `/api/v3/repos/${login}/smoke-repo/issues`, { title: 'smoke issue', body: 'hello' });
  check('create issue 201', issue.status === 201 && JSON.parse(issue.body).number === 1);

  const got = await call(port, 'GET', `/api/v3/repos/${login}/smoke-repo/issues/1`);
  check('get issue 200', got.status === 200 && JSON.parse(got.body).title === 'smoke issue');

  const gql = await call(port, 'POST', '/api/graphql', { query: 'query { viewer { login } }' });
  check('graphql viewer', gql.status === 200 && JSON.parse(gql.body).data.viewer.login === login);

  const discover = await call(port, 'POST', '/mcp', { jsonrpc: '2.0', id: 1, method: 'server/discover', params: {} });
  const discBody = JSON.parse(discover.body) as { result?: { supportedVersions?: string[] } };
  check('mcp discover', discover.status === 200 && (discBody.result?.supportedVersions?.length ?? 0) > 0);

  const tools = await call(port, 'POST', '/mcp', { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
  const toolNames = (JSON.parse(tools.body).result.tools as { name: string }[]).map((t) => t.name);
  check('mcp tools list', toolNames.includes('create_repo') && toolNames.includes('merge_pull_request'));

  const toolCall = await call(port, 'POST', '/mcp', {
    jsonrpc: '2.0',
    id: 3,
    method: 'tools/call',
    params: { name: 'create_repo', arguments: { name: 'mcp-repo' } },
  });
  check('mcp create_repo', toolCall.status === 200 && JSON.parse(toolCall.body).result.content[0].text.includes('mcp-repo'));

  console.log('smoke: all passed');
} finally {
  server.close();
}
