// REST v3: repositories, contents, issues, labels, comments, pull
// requests, branches and git refs. JSON bodies are Buffers; the hot
// single-issue read serves a cached Buffer with zero serialisation.

import type { IncomingMessage, ServerResponse } from 'node:http';
import { VIEWER } from './viewer.ts';
import {
  allViewerRepos, blobAt, branchTip, commitList, createIssue, createRepo, deleteRepo,
  getRepo, gid, invalidateIssue, invalidateRepo, issueJson, lineCount, makeCommit,
  nextSeq, prFiles, prMergeable, pullJson, repoJson, setTreePath, squashMerge,
  stamp, treeAt, type Issue, type Pull, type Repo,
} from './store.ts';
import { hashObj, isOid, parseCommit, parseTree, storeObj } from './gitpack.ts';

export function errJson(res: ServerResponse, status: number, message: string, reqId: string): void {
  const body = Buffer.from(JSON.stringify({ message }), 'utf8');
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': body.length,
    'X-GitHub-Request-Id': reqId,
  });
  res.end(body);
}

export function sendJson(res: ServerResponse, status: number, body: Buffer, reqId: string, extra: Record<string, string> = {}): void {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': body.length,
    'X-GitHub-Request-Id': reqId,
    ...extra,
  });
  res.end(body);
}

function bufJson(obj: unknown): Buffer {
  return Buffer.from(JSON.stringify(obj), 'utf8');
}

function joinJson(bufs: readonly Buffer[]): Buffer {
  if (bufs.length === 0) return Buffer.from('[]', 'utf8');
  const parts: Buffer[] = [Buffer.from('[', 'utf8')];
  for (let i = 0; i < bufs.length; i += 1) {
    if (i > 0) parts.push(Buffer.from(',', 'utf8'));
    parts.push(bufs[i] as Buffer);
  }
  parts.push(Buffer.from(']', 'utf8'));
  return Buffer.concat(parts);
}

export function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

export function parseJsonBody(raw: Buffer): { ok: true; value: Record<string, unknown> } | { ok: false } {
  if (raw.length === 0) return { ok: true, value: {} };
  try {
    const v = JSON.parse(raw.toString('utf8')) as unknown;
    if (v !== null && typeof v === 'object' && !Array.isArray(v)) return { ok: true, value: v as Record<string, unknown> };
    return { ok: true, value: {} };
  } catch {
    return { ok: false };
  }
}

function queryParams(url: string): URLSearchParams {
  const q = url.indexOf('?');
  return q < 0 ? new URLSearchParams() : new URLSearchParams(url.slice(q + 1));
}

function pageOf(q: URLSearchParams): { page: number; perPage: number } {
  const page = Math.max(1, parseInt(q.get('page') ?? '1', 10) || 1);
  const perPage = Math.min(100, Math.max(1, parseInt(q.get('per_page') ?? '30', 10) || 30));
  return { page, perPage };
}

function paginate<T>(items: readonly T[], page: number, perPage: number): T[] {
  return items.slice((page - 1) * perPage, page * perPage);
}

function linkHeader(base: string, q: URLSearchParams, page: number, perPage: number, hasNext: boolean, origin: string): string | null {
  if (!hasNext) return null;
  const next = new URLSearchParams(q);
  next.set('page', String(page + 1));
  next.set('per_page', String(perPage));
  return `<${origin}${base}?${next.toString()}>; rel="next"`;
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

function num(v: unknown): number {
  return typeof v === 'number' ? v : 0;
}

function mustRepo(res: ServerResponse, owner: string, name: string, reqId: string): Repo | null {
  const r = getRepo(owner, name);
  if (!r || r.owner !== VIEWER.login) {
    errJson(res, 404, 'Not Found', reqId);
    return null;
  }
  return r;
}

export async function handleRest(req: IncomingMessage, res: ServerResponse, reqId: string, origin = ''): Promise<boolean> {
  const method = req.method ?? 'GET';
  const rawUrl = req.url ?? '/';
  const path = rawUrl.split('?')[0] as string;
  if (path === '/api/v3' || path === '/api/v3/') {
    if (method !== 'GET') return false;
    sendJson(res, 200, bufJson({}), reqId, { 'X-OAuth-Scopes': 'repo, user, gist' });
    return true;
  }
  if (path === '/api/v3/meta') {
    if (method !== 'GET') return false;
    sendJson(res, 200, bufJson({ installed_version: '1.0.0', verifiable_password_authentication: true }), reqId);
    return true;
  }
  if (path === '/api/v3/user' && method === 'GET') {
    sendJson(res, 200, bufJson({
      login: VIEWER.login, id: VIEWER.id, name: VIEWER.name, email: VIEWER.email, type: 'User',
      html_url: `https://example.invalid/${VIEWER.login}`,
      url: '/api/v3/user',
    }), reqId);
    return true;
  }
  if (path === '/api/v3/user/repos') {
    if (method === 'GET') {
      const q = queryParams(rawUrl);
      const { page, perPage } = pageOf(q);
      const all = allViewerRepos();
      const slice = paginate(all, page, perPage);
      const link = linkHeader('/api/v3/user/repos', q, page, perPage, page * perPage < all.length, origin);
      sendJson(res, 200, joinJson(slice.map((r) => repoJson(r))), reqId, link ? { Link: link } : {});
      return true;
    }
    if (method === 'POST') {
      const raw = await readBody(req);
      const parsed = parseJsonBody(raw);
      if (!parsed.ok) {
        errJson(res, 400, 'Problems parsing JSON', reqId);
        return true;
      }
      const name = str(parsed.value.name);
      if (!name || name.includes('/') || name.includes(' ') || name.length > 100) {
        errJson(res, 422, 'Invalid repository name', reqId);
        return true;
      }
      if (getRepo(VIEWER.login, name)) {
        errJson(res, 422, 'Repository already exists', reqId);
        return true;
      }
      const r = createRepo(name, parsed.value.private === true, str(parsed.value.description));
      sendJson(res, 201, repoJson(r), reqId);
      return true;
    }
    return false;
  }

  // Fast path: GET a single issue — the read benchmark's hot route.
  // Skips the generic segment split and section dispatch entirely.
  if (method === 'GET') {
    const m = /^\/api\/v3\/repos\/([^/]+)\/([^/]+)\/issues\/(\d+)$/.exec(path);
    if (m) {
      const r = getRepo(decodeURIComponent(m[1] as string), decodeURIComponent(m[2] as string));
      if (!r || r.owner !== VIEWER.login) {
        errJson(res, 404, 'Not Found', reqId);
        return true;
      }
      const iss = r.issues.find((i) => i.number === Number(m[3]));
      if (!iss) {
        errJson(res, 404, 'Not Found', reqId);
        return true;
      }
      sendJson(res, 200, issueJson(r, iss), reqId);
      return true;
    }
  }

  const segs = path.split('/').filter((s) => s !== '');
  // /api/v3/repos/:owner/:name[/...]
  if (segs[0] === 'api' && segs[1] === 'v3' && segs[2] === 'repos' && segs.length >= 5) {
    const owner = decodeURIComponent(segs[3] as string);
    const name = decodeURIComponent(segs[4] as string);
    const tail = segs.slice(5);

    if (tail.length === 0) {
      const r = mustRepo(res, owner, name, reqId);
      if (!r) return true;
      if (method === 'GET') {
        sendJson(res, 200, repoJson(r), reqId);
        return true;
      }
      if (method === 'PATCH') {
        const raw = await readBody(req);
        const parsed = parseJsonBody(raw);
        if (!parsed.ok) {
          errJson(res, 400, 'Problems parsing JSON', reqId);
          return true;
        }
        if (typeof parsed.value.description === 'string') r.description = parsed.value.description;
        if (typeof parsed.value.private === 'boolean') r.priv = parsed.value.private;
        invalidateRepo(r);
        sendJson(res, 200, repoJson(r), reqId);
        return true;
      }
      if (method === 'DELETE') {
        deleteRepo(r);
        res.writeHead(204, { 'X-GitHub-Request-Id': reqId });
        res.end();
        return true;
      }
      return false;
    }

    const section = tail[0] as string;
    const r = mustRepo(res, owner, name, reqId);
    if (!r) return true;

    // ------------------------------------------------------------ contents
    if (section === 'contents') {
      const filePath = tail.slice(1).map((s) => decodeURIComponent(s)).join('/');
      const q = queryParams(rawUrl);
      const ref = q.get('ref') ?? r.defaultBranch;
      if (method === 'GET') {
        const treeOid = treeAt(r, `refs/heads/${ref}`);
        if (treeOid === null) {
          errJson(res, 404, 'Not Found', reqId);
          return true;
        }
        if (filePath === '') {
          const entries = parseTree(r.objects.get(treeOid)?.data ?? Buffer.alloc(0));
          sendJson(res, 200, bufJson(entries.map((e) => ({
            type: e.mode === '40000' ? 'dir' : 'file',
            name: e.name,
            path: e.name,
            sha: e.oid,
            size: e.mode === '40000' ? 0 : (r.objects.get(e.oid)?.data.length ?? 0),
          }))), reqId);
          return true;
        }
        const segsPath = filePath.split('/');
        const blobOid = blobAt(r, treeOid, segsPath);
        if (blobOid === null) {
          // Maybe a directory.
          let cur: string | null = treeOid;
          for (const s of segsPath) {
            if (cur === null) break;
            const e = parseTree(r.objects.get(cur)?.data ?? Buffer.alloc(0)).find((x) => x.name === s);
            if (!e || e.mode !== '40000') {
              cur = null;
              break;
            }
            cur = e.oid;
          }
          if (cur === null) {
            errJson(res, 404, 'Not Found', reqId);
            return true;
          }
          const entries = parseTree(r.objects.get(cur)?.data ?? Buffer.alloc(0));
          sendJson(res, 200, bufJson(entries.map((e) => ({
            type: e.mode === '40000' ? 'dir' : 'file',
            name: e.name,
            path: `${filePath}/${e.name}`,
            sha: e.oid,
            size: e.mode === '40000' ? 0 : (r.objects.get(e.oid)?.data.length ?? 0),
          }))), reqId);
          return true;
        }
        const data = r.objects.get(blobOid)?.data ?? Buffer.alloc(0);
        sendJson(res, 200, bufJson({
          type: 'file',
          encoding: 'base64',
          size: data.length,
          name: segsPath[segsPath.length - 1],
          path: filePath,
          content: data.toString('base64'),
          sha: blobOid,
        }), reqId);
        return true;
      }
      if (method === 'PUT' || method === 'DELETE') {
        const raw = await readBody(req);
        const parsed = parseJsonBody(raw);
        if (!parsed.ok) {
          errJson(res, 400, 'Problems parsing JSON', reqId);
          return true;
        }
        const branch = str(parsed.value.branch) || r.defaultBranch;
        const branchRef = `refs/heads/${branch}`;
        let tip = r.refs.get(branchRef);
        const baseTip = r.refs.get(`refs/heads/${r.defaultBranch}`);
        if (method === 'PUT') {
          const contentB64 = str(parsed.value.content);
          if (!contentB64) {
            errJson(res, 422, 'content is required', reqId);
            return true;
          }
          const data = Buffer.from(contentB64, 'base64');
          const blobOid = hashObj('blob', data);
          const treeOid = tip ? treeAt(r, branchRef) : null;
          const segsPath = filePath.split('/');
          const existing = treeOid ? blobAt(r, treeOid, segsPath) : null;
          const givenSha = str(parsed.value.sha);
          if (givenSha && existing !== givenSha) {
            errJson(res, 409, 'sha does not match', reqId);
            return true;
          }
          if (!givenSha && existing !== null) {
            errJson(res, 409, 'file already exists', reqId);
            return true;
          }
          storeObj(r.objects, 'blob', data);
          const newTree = setTreePath(r, treeOid, segsPath, blobOid);
          const parents = tip ? [tip] : baseTip ? [baseTip] : [];
          const commitSha = makeCommit(r, newTree, parents, str(parsed.value.message) || (existing ? `Update ${filePath}` : `Create ${filePath}`));
          r.refs.set(branchRef, commitSha);
          const status = existing ? 200 : 201;
          sendJson(res, status, bufJson({
            content: { name: segsPath[segsPath.length - 1], path: filePath, sha: blobOid, size: data.length, encoding: 'base64', content: contentB64 },
            commit: { sha: commitSha, message: str(parsed.value.message) || '' },
          }), reqId);
          return true;
        }
        // DELETE
        if (!tip) {
          errJson(res, 404, 'Not Found', reqId);
          return true;
        }
        const treeOid = treeAt(r, branchRef);
        const segsPath = filePath.split('/');
        const existing = treeOid ? blobAt(r, treeOid, segsPath) : null;
        if (existing === null) {
          errJson(res, 404, 'Not Found', reqId);
          return true;
        }
        const givenSha = str(parsed.value.sha);
        if (givenSha && givenSha !== existing) {
          errJson(res, 409, 'sha does not match', reqId);
          return true;
        }
        const newTree = setTreePath(r, treeOid, segsPath, null);
        const commitSha = makeCommit(r, newTree, [tip], str(parsed.value.message) || `Delete ${filePath}`);
        r.refs.set(branchRef, commitSha);
        sendJson(res, 200, bufJson({ commit: { sha: commitSha, message: str(parsed.value.message) || '' } }), reqId);
        return true;
      }
      return false;
    }

    // ------------------------------------------------------------ labels
    if (section === 'labels') {
      if (method === 'GET') {
        sendJson(res, 200, bufJson([...r.labels.values()].map((l) => ({ name: l.name, color: l.color, description: '' }))), reqId);
        return true;
      }
      if (method === 'POST') {
        const raw = await readBody(req);
        const parsed = parseJsonBody(raw);
        if (!parsed.ok) {
          errJson(res, 400, 'Problems parsing JSON', reqId);
          return true;
        }
        const labelName = str(parsed.value.name);
        if (!labelName) {
          errJson(res, 422, 'name is required', reqId);
          return true;
        }
        if (r.labels.has(labelName)) {
          errJson(res, 422, 'Label already exists', reqId);
          return true;
        }
        const label = { name: labelName, color: str(parsed.value.color) || 'ededed' };
        r.labels.set(labelName, label);
        sendJson(res, 201, bufJson({ name: label.name, color: label.color, description: '' }), reqId);
        return true;
      }
      return false;
    }

    // ------------------------------------------------------------ issues
    if (section === 'issues') {
      const numSeg = tail[1];
      if (numSeg === undefined) {
        if (method === 'GET') {
          const q = queryParams(rawUrl);
          const { page, perPage } = pageOf(q);
          const state = q.get('state') ?? 'open';
          const sort = q.get('sort') ?? 'created';
          const direction = q.get('direction') ?? 'desc';
          let list = [...r.issues];
          if (state !== 'all') list = list.filter((i) => i.state === state);
          list.sort((a, b) => {
            const cmp = sort === 'created' ? a.seq - b.seq : a.number - b.number;
            return direction === 'asc' ? cmp : -cmp;
          });
          const slice = paginate(list, page, perPage);
          const link = linkHeader(`/api/v3/repos/${owner}/${name}/issues`, q, page, perPage, page * perPage < list.length, origin);
          sendJson(res, 200, joinJson(slice.map((i) => issueJson(r, i))), reqId, link ? { Link: link } : {});
          return true;
        }
        if (method === 'POST') {
          const raw = await readBody(req);
          const parsed = parseJsonBody(raw);
          if (!parsed.ok) {
            errJson(res, 400, 'Problems parsing JSON', reqId);
            return true;
          }
          const labels = Array.isArray(parsed.value.labels) ? (parsed.value.labels as unknown[]).filter((x) => typeof x === 'string') as string[] : [];
          for (const l of labels) {
            if (!r.labels.has(l)) {
              errJson(res, 422, `Label '${l}' does not exist`, reqId);
              return true;
            }
          }
          const iss = createIssue(r, str(parsed.value.title), str(parsed.value.body), labels);
          sendJson(res, 201, issueJson(r, iss), reqId);
          return true;
        }
        return false;
      }
      const n = parseInt(numSeg, 10);
      const iss = r.issues.find((i) => i.number === n);
      if (tail[2] === 'comments') {
        if (!iss) {
          errJson(res, 404, 'Not Found', reqId);
          return true;
        }
        if (method === 'GET') {
          const list = r.comments.get(n) ?? [];
          sendJson(res, 200, bufJson(list.map((c) => ({
            id: c.id, body: c.body, created_at: c.createdAt,
            user: { login: VIEWER.login, id: VIEWER.id, type: 'User' },
          }))), reqId);
          return true;
        }
        if (method === 'POST') {
          const raw = await readBody(req);
          const parsed = parseJsonBody(raw);
          if (!parsed.ok) {
            errJson(res, 400, 'Problems parsing JSON', reqId);
            return true;
          }
          const s = nextSeq();
          const c = { id: 200000 + r.id * 1000 + r.nextComment, body: str(parsed.value.body), seq: s, createdAt: stamp(s) };
          r.nextComment += 1;
          const list = r.comments.get(n) ?? [];
          list.push(c);
          r.comments.set(n, list);
          invalidateIssue(r, n);
          sendJson(res, 201, bufJson({
            id: c.id, body: c.body, created_at: c.createdAt,
            user: { login: VIEWER.login, id: VIEWER.id, type: 'User' },
          }), reqId);
          return true;
        }
        return false;
      }
      if (tail.length === 2) {
        if (!iss) {
          errJson(res, 404, 'Not Found', reqId);
          return true;
        }
        if (method === 'GET') {
          sendJson(res, 200, issueJson(r, iss), reqId);
          return true;
        }
        if (method === 'PATCH') {
          const raw = await readBody(req);
          const parsed = parseJsonBody(raw);
          if (!parsed.ok) {
            errJson(res, 400, 'Problems parsing JSON', reqId);
            return true;
          }
          if (typeof parsed.value.title === 'string') iss.title = parsed.value.title;
          if (typeof parsed.value.body === 'string') iss.body = parsed.value.body;
          if (parsed.value.state === 'closed' || parsed.value.state === 'open') {
            iss.state = parsed.value.state;
            iss.closedAt = iss.state === 'closed' ? stamp(nextSeq()) : null;
          }
          iss.updatedAt = stamp(nextSeq());
          invalidateIssue(r, n);
          sendJson(res, 200, issueJson(r, iss), reqId);
          return true;
        }
        return false;
      }
      return false;
    }

    // ------------------------------------------------------------ pulls
    if (section === 'pulls') {
      const numSeg = tail[1];
      if (numSeg === undefined) {
        if (method === 'GET') {
          const q = queryParams(rawUrl);
          const state = q.get('state') ?? 'open';
          let list = [...r.pulls];
          if (state !== 'all') list = list.filter((p) => p.state === state);
          list.sort((a, b) => b.seq - a.seq);
          sendJson(res, 200, bufJson(list.map((p) => pullJson(r, p))), reqId);
          return true;
        }
        if (method === 'POST') {
          const raw = await readBody(req);
          const parsed = parseJsonBody(raw);
          if (!parsed.ok) {
            errJson(res, 400, 'Problems parsing JSON', reqId);
            return true;
          }
          const head = str(parsed.value.head);
          const base = str(parsed.value.base);
          const headSha = branchTip(r, head);
          const baseSha = branchTip(r, base);
          if (!headSha || !baseSha) {
            errJson(res, 422, 'head or base branch not found', reqId);
            return true;
          }
          const s = nextSeq();
          const p: Pull = {
            number: r.nextPull,
            id: 300000 + r.id * 1000 + r.nextPull,
            title: str(parsed.value.title),
            body: str(parsed.value.body),
            state: 'open',
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
          sendJson(res, 201, bufJson(pullJson(r, p)), reqId);
          return true;
        }
        return false;
      }
      const n = parseInt(numSeg, 10);
      const p = r.pulls.find((x) => x.number === n);
      if (tail[2] === 'files') {
        if (!p) {
          errJson(res, 404, 'Not Found', reqId);
          return true;
        }
        if (method === 'GET') {
          sendJson(res, 200, bufJson(prFiles(r, p)), reqId);
          return true;
        }
        return false;
      }
      if (tail[2] === 'merge') {
        if (!p) {
          errJson(res, 404, 'Not Found', reqId);
          return true;
        }
        if (method === 'PUT') {
          await readBody(req);
          if (p.state !== 'open') {
            errJson(res, 405, 'Pull request already closed', reqId);
            return true;
          }
          if (prMergeable(r, p) === 'CONFLICTING') {
            errJson(res, 405, 'Merge conflict', reqId);
            return true;
          }
          const sha = squashMerge(r, p);
          sendJson(res, 200, bufJson({ sha, merged: true, message: 'Pull Request successfully merged' }), reqId);
          return true;
        }
        return false;
      }
      if (tail.length === 2) {
        if (!p) {
          errJson(res, 404, 'Not Found', reqId);
          return true;
        }
        if (method === 'GET') {
          sendJson(res, 200, bufJson(pullJson(r, p)), reqId);
          return true;
        }
        return false;
      }
      return false;
    }

    // ------------------------------------------------------------ branches
    if (section === 'branches') {
      if (tail.length === 1) {
        if (method === 'GET') {
          const list = [...r.refs.keys()]
            .filter((k) => k.startsWith('refs/heads/'))
            .map((k) => k.slice('refs/heads/'.length))
            .sort()
            .map((b) => ({ name: b, commit: { sha: r.refs.get(`refs/heads/${b}`) }, protected: false }));
          sendJson(res, 200, bufJson(list), reqId);
          return true;
        }
        return false;
      }
      if (tail.length === 2 && method === 'GET') {
        const branch = decodeURIComponent(tail[1] as string);
        const tip = r.refs.get(`refs/heads/${branch}`);
        if (!tip) {
          errJson(res, 404, 'Not Found', reqId);
          return true;
        }
        sendJson(res, 200, bufJson({ name: branch, commit: { sha: tip }, protected: false }), reqId);
        return true;
      }
      return false;
    }

    // ------------------------------------------------------------ commits
    if (section === 'commits') {
      if (method === 'GET') {
        const q = queryParams(rawUrl);
        const ref = q.get('sha') ?? r.defaultBranch;
        const tip = r.refs.get(`refs/heads/${ref}`);
        if (!tip) {
          errJson(res, 404, 'Not Found', reqId);
          return true;
        }
        const list = commitList(r, tip).map((oid) => {
          const c = parseCommit(r.objects.get(oid)?.data ?? Buffer.alloc(0));
          const who = (s: string): { name: string; email: string; date: string } => {
            const m = s.match(/^(.*?) <(.*?)> (\d+) \+0000$/);
            return m ? { name: m[1] as string, email: m[2] as string, date: new Date(Number(m[3]) * 1000).toISOString() } : { name: VIEWER.name, email: VIEWER.email, date: r.createdAt };
          };
          return {
            sha: oid,
            commit: { message: c.message.replace(/\n+$/, ''), author: who(c.author), committer: who(c.committer) },
            parents: c.parents.map((p) => ({ sha: p })),
          };
        });
        sendJson(res, 200, bufJson(list), reqId);
        return true;
      }
      return false;
    }

    // ------------------------------------------------------------ git/refs
    if (section === 'git' && tail[1] === 'refs') {
      if (method === 'GET' && tail.length >= 4 && tail[2] === 'heads') {
        const branch = decodeURIComponent(tail[3] as string);
        const tip = r.refs.get(`refs/heads/${branch}`);
        if (!tip) {
          errJson(res, 404, 'Not Found', reqId);
          return true;
        }
        sendJson(res, 200, bufJson({ ref: `refs/heads/${branch}`, object: { sha: tip, type: 'commit' } }), reqId);
        return true;
      }
      if (method === 'POST' && tail.length === 2) {
        const raw = await readBody(req);
        const parsed = parseJsonBody(raw);
        if (!parsed.ok) {
          errJson(res, 400, 'Problems parsing JSON', reqId);
          return true;
        }
        const ref = str(parsed.value.ref);
        const sha = str(parsed.value.sha);
        if (!ref.startsWith('refs/') || !isOid(sha) || !r.objects.has(sha)) {
          errJson(res, 422, 'invalid ref or sha', reqId);
          return true;
        }
        if (r.refs.has(ref)) {
          errJson(res, 422, 'ref already exists', reqId);
          return true;
        }
        r.refs.set(ref, sha);
        sendJson(res, 201, bufJson({ ref, object: { sha, type: 'commit' } }), reqId);
        return true;
      }
      return false;
    }

    return false;
  }

  return false;
}
