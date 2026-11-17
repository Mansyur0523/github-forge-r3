// MCP over /mcp: JSON-RPC 2.0 Streamable HTTP. `server/discover` for the
// modern era plus the legacy initialize handshake, a fixed tool list, and
// six tools that act on the same store as REST.

import type { IncomingMessage, ServerResponse } from 'node:http';
import { VIEWER } from './viewer.ts';
import { createIssue, createRepo, getRepo, nextSeq, prMergeable, squashMerge, stamp, type Repo } from './store.ts';
import { readBody, sendJson } from './rest.ts';

const SERVER_INFO = { name: 'forge-mcp', version: '1.0.0' };

interface ToolDef {
  name: string;
  description: string;
  inputSchema: { type: string; properties: Record<string, { type: string; description: string }>; required: string[] };
}

const TOOLS: ToolDef[] = [
  {
    name: 'create_repo',
    description: 'Create a new repository for the authenticated user.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Repository name' },
        description: { type: 'string', description: 'Repository description' },
        private: { type: 'boolean', description: 'Whether the repository is private' },
      },
      required: ['name'],
    },
  },
  {
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
        title: { type: 'string', description: 'Issue title' },
        body: { type: 'string', description: 'Issue body' },
      },
      required: ['owner', 'repo', 'title'],
    },
  },
  {
    name: 'list_issues',
    description: 'List issues in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
        state: { type: 'string', description: 'Issue state: open, closed, or all' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_pull_request',
    description: 'Create a pull request in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
        title: { type: 'string', description: 'Pull request title' },
        head: { type: 'string', description: 'Head branch name' },
        base: { type: 'string', description: 'Base branch name' },
        body: { type: 'string', description: 'Pull request body' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request with a squash commit.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
        pull_number: { type: 'number', description: 'Pull request number' },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
  },
];

const TOOLS_JSON = Buffer.from(JSON.stringify({ tools: TOOLS }), 'utf8');

function str(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

function toolText(content: Record<string, unknown>): { content: { type: string; text: string }[] } {
  return { content: [{ type: 'text', text: JSON.stringify(content) }] };
}

function toolError(message: string): { content: { type: string; text: string }[]; isError: true } {
  return { content: [{ type: 'text', text: message }], isError: true };
}

function missingRequired(args: Record<string, unknown>, required: string[]): string | null {
  for (const k of required) {
    if (args[k] === undefined || args[k] === null || args[k] === '') return `Missing required argument: ${k}`;
  }
  return null;
}

function needRepo(args: Record<string, unknown>): Repo | null {
  const r = getRepo(str(args.owner), str(args.repo));
  return r && r.owner === VIEWER.login ? r : null;
}

function callTool(name: string, args: Record<string, unknown>): { content: { type: string; text: string }[]; isError?: true } {
  const def = TOOLS.find((t) => t.name === name);
  if (!def) return toolError(`Unknown tool: ${name}`);
  const missing = missingRequired(args, def.inputSchema.required);
  if (missing) return toolError(missing);
  switch (name) {
    case 'create_repo': {
      const repoName = str(args.name);
      if (!repoName) return toolError('Missing required argument: name');
      if (getRepo(VIEWER.login, repoName)) return toolError('Repository already exists');
      const r = createRepo(repoName, args.private === true, str(args.description));
      return toolText({ id: r.id, name: r.name, full_name: `${r.owner}/${r.name}`, private: r.priv, description: r.description, default_branch: r.defaultBranch });
    }
    case 'get_repo': {
      const r = needRepo(args);
      if (!r) return toolError('Repository not found');
      return toolText({ id: r.id, name: r.name, full_name: `${r.owner}/${r.name}`, private: r.priv, description: r.description, default_branch: r.defaultBranch });
    }
    case 'create_issue': {
      const r = needRepo(args);
      if (!r) return toolError('Repository not found');
      const iss = createIssue(r, str(args.title), str(args.body), []);
      return toolText({ id: iss.id, number: iss.number, title: iss.title, body: iss.body, state: iss.state });
    }
    case 'list_issues': {
      const r = needRepo(args);
      if (!r) return toolError('Repository not found');
      const state = str(args.state) || 'open';
      const list = r.issues.filter((i) => state === 'all' || i.state === state);
      return toolText({ issues: list.map((i) => ({ id: i.id, number: i.number, title: i.title, body: i.body, state: i.state })) });
    }
    case 'create_pull_request': {
      const r = needRepo(args);
      if (!r) return toolError('Repository not found');
      const head = str(args.head);
      const base = str(args.base);
      const headSha = r.refs.get(`refs/heads/${head}`);
      const baseSha = r.refs.get(`refs/heads/${base}`);
      if (!headSha || !baseSha) return toolError('head or base branch not found');
      const s = nextSeq();
      const p = {
        number: r.nextPull,
        id: 300000 + r.id * 1000 + r.nextPull,
        title: str(args.title),
        body: str(args.body),
        state: 'open' as const,
        merged: false,
        mergedAt: null,
        mergeSha: null,
        head,
        base,
        headSha,
        baseSha,
        seq: s,
        createdAt: stamp(s),
        updatedAt: stamp(s),
      };
      r.nextPull += 1;
      r.pulls.push(p);
      return toolText({ id: p.id, number: p.number, title: p.title, body: p.body, state: 'OPEN', head: { ref: head, sha: headSha }, base: { ref: base, sha: baseSha } });
    }
    case 'merge_pull_request': {
      const r = needRepo(args);
      if (!r) return toolError('Repository not found');
      const p = r.pulls.find((x) => x.number === Number(args.pull_number));
      if (!p) return toolError('Pull request not found');
      if (p.state !== 'open') return toolError('Pull request already closed');
      if (prMergeable(r, p) === 'CONFLICTING') return toolError('Merge conflict');
      const sha = squashMerge(r, p);
      return toolText({ number: p.number, merged: true, sha, state: 'CLOSED' });
    }
    default:
      return toolError(`Unknown tool: ${name}`);
  }
}

export async function handleMcp(req: IncomingMessage, res: ServerResponse, reqId: string): Promise<boolean> {
  if (req.method !== 'POST') return false;
  const raw = await readBody(req);
  let body: unknown;
  try {
    body = JSON.parse(raw.toString('utf8')) as unknown;
  } catch {
    sendJson(res, 400, Buffer.from(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }), 'utf8'), reqId);
    return true;
  }
  const msg = body as { jsonrpc?: string; id?: string | number | null; method?: string; params?: Record<string, unknown> };
  const id = msg.id === undefined ? null : msg.id;
  const reply = (payload: Record<string, unknown>): void => {
    sendJson(res, 200, Buffer.from(JSON.stringify(payload), 'utf8'), reqId);
  };
  const result = (value: Record<string, unknown>): void => reply({ jsonrpc: '2.0', id, result: value });
  const rpcErr = (code: number, message: string): void => reply({ jsonrpc: '2.0', id, error: { code, message } });

  switch (msg.method) {
    case 'server/discover': {
      result({
        supportedVersions: ['2026-07-28', '2025-06-18', '2025-03-26'],
        capabilities: { tools: {} },
        serverInfo: SERVER_INFO,
        _meta: { 'io.modelcontextprotocol/serverInfo': SERVER_INFO },
      });
      return true;
    }
    case 'initialize': {
      const params = (msg.params ?? {}) as Record<string, unknown>;
      result({
        protocolVersion: typeof params.protocolVersion === 'string' ? params.protocolVersion : '2026-07-28',
        capabilities: { tools: {} },
        serverInfo: SERVER_INFO,
        _meta: { 'io.modelcontextprotocol/serverInfo': SERVER_INFO },
      });
      return true;
    }
    case 'notifications/initialized':
    case 'notifications/cancelled': {
      res.writeHead(202, { 'X-GitHub-Request-Id': reqId });
      res.end();
      return true;
    }
    case 'tools/list': {
      // Build the envelope around the prebuilt tools array without
      // re-serialising it, so two calls are byte-identical.
      const head = Buffer.from(`{"jsonrpc":"2.0","id":${JSON.stringify(id)},"result":`, 'utf8');
      const tail = Buffer.from('}', 'utf8');
      const body = Buffer.concat([head, TOOLS_JSON, tail]);
      res.writeHead(200, {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Length': body.length,
        'X-GitHub-Request-Id': reqId,
      });
      res.end(body);
      return true;
    }
    case 'tools/call': {
      const params = (msg.params ?? {}) as Record<string, unknown>;
      const toolName = str(params.name);
      const args = (params.arguments ?? {}) as Record<string, unknown>;
      if (!TOOLS.some((t) => t.name === toolName)) {
        rpcErr(-32601, `Unknown tool: ${toolName}`);
        return true;
      }
      result(callTool(toolName, args));
      return true;
    }
    case 'ping': {
      result({});
      return true;
    }
    default: {
      rpcErr(-32601, `Method not found: ${String(msg.method ?? '')}`);
      return true;
    }
  }
}
