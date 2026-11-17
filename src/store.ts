// The forge's whole store: repositories, git objects and refs, issues,
// pull requests, labels and comments. Everything lives in Maps; JSON
// bodies for the hot read path are cached and invalidated on mutation.
// Timestamps are a deterministic counter (no wall clock in any response),
// so a replay leaves the same bytes.

import { VIEWER } from './viewer.ts';
import { buildTree, hashObj, isOid, parseCommit, parseTree, reachable, storeObj, type GitObj, type TreeEntry } from './gitpack.ts';

export const BASE_EPOCH = 1700000000;

let seq = 0;
export function nextSeq(): number {
  seq += 1;
  return seq;
}
export function stamp(s: number): string {
  return new Date((BASE_EPOCH + s) * 1000).toISOString();
}

export function gid(kind: string, ...parts: (string | number)[]): string {
  return Buffer.from([kind, ...parts].join(':'), 'utf8').toString('base64');
}

export interface Issue {
  number: number;
  id: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  seq: number;
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
}

export interface Comment {
  id: number;
  body: string;
  seq: number;
  createdAt: string;
}

export interface Pull {
  number: number;
  id: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  merged: boolean;
  mergedAt: string | null;
  mergeSha: string | null;
  head: string;
  base: string;
  headSha: string;
  baseSha: string;
  seq: number;
  createdAt: string;
  updatedAt: string;
}

export interface Repo {
  id: number;
  name: string;
  owner: string;
  description: string;
  priv: boolean;
  defaultBranch: string;
  seq: number;
  createdAt: string;
  refs: Map<string, string>;
  objects: Map<string, GitObj>;
  labels: Map<string, { name: string; color: string }>;
  issues: Issue[];
  pulls: Pull[];
  comments: Map<number, Comment[]>;
  nextIssue: number;
  nextPull: number;
  nextComment: number;
  issueCache: Map<number, Buffer>;
  repoJson: Buffer | null;
}

let repoSeq = 0;
const repos = new Map<string, Repo>(); // key: owner + '\0' + name

export function repoKey(owner: string, name: string): string {
  return `${owner}\0${name}`;
}

export function getRepo(owner: string, name: string): Repo | undefined {
  return repos.get(repoKey(owner, name));
}

export function allViewerRepos(): Repo[] {
  const out: Repo[] = [];
  for (const r of repos.values()) if (r.owner === VIEWER.login) out.push(r);
  out.sort((a, b) => a.seq - b.seq);
  return out;
}

export function createRepo(name: string, priv: boolean, description: string): Repo {
  repoSeq += 1;
  const s = nextSeq();
  const r: Repo = {
    id: 5000 + repoSeq,
    name,
    owner: VIEWER.login,
    description,
    priv,
    defaultBranch: 'main',
    seq: s,
    createdAt: stamp(s),
    refs: new Map(),
    objects: new Map(),
    labels: new Map(),
    issues: [],
    pulls: [],
    comments: new Map(),
    nextIssue: 1,
    nextPull: 1,
    nextComment: 1,
    issueCache: new Map(),
    repoJson: null,
  };
  repos.set(repoKey(VIEWER.login, name), r);
  return r;
}

export function deleteRepo(r: Repo): void {
  repos.delete(repoKey(r.owner, r.name));
}

// ---------------------------------------------------------------- git helpers

export function lookup(r: Repo, oid: string): GitObj | undefined {
  return r.objects.get(oid);
}

export function refTip(r: Repo, ref: string): string | undefined {
  return r.refs.get(ref);
}

export function branchTip(r: Repo, branch: string): string | undefined {
  return r.refs.get(`refs/heads/${branch}`);
}

/** Flatten a tree (path -> {oid, mode}) recursively. */
export function flattenTree(r: Repo, treeOid: string, prefix: string, out: Map<string, { oid: string; mode: string }>): void {
  const t = r.objects.get(treeOid);
  if (!t || t.type !== 'tree') return;
  for (const e of parseTree(t.data)) {
    const path = prefix === '' ? e.name : `${prefix}/${e.name}`;
    if (e.mode === '40000') flattenTree(r, e.oid, path, out);
    else out.set(path, { oid: e.oid, mode: e.mode });
  }
}

export function treeAt(r: Repo, ref: string): string | null {
  const tip = r.refs.get(ref);
  if (!tip) return null;
  const c = r.objects.get(tip);
  if (!c || c.type !== 'commit') return null;
  return parseCommit(c.data).tree;
}

/** Set (or delete with null) one path in a tree, rebuilding parents bottom-up. */
export function setTreePath(r: Repo, treeOid: string | null, segs: readonly string[], blobOid: string | null): string {
  const entries: TreeEntry[] = treeOid === null ? [] : parseTree(r.objects.get(treeOid)?.data ?? Buffer.alloc(0));
  const head = segs[0] as string;
  const rest = segs.slice(1);
  const kept = entries.filter((e) => e.name !== head);
  if (rest.length === 0) {
    if (blobOid !== null) kept.push({ mode: '100644', name: head, oid: blobOid });
  } else {
    const existing = entries.find((e) => e.name === head && e.mode === '40000');
    const child = setTreePath(r, existing ? existing.oid : null, rest, blobOid);
    // Drop the directory if it became empty.
    const childObj = r.objects.get(child);
    if (childObj && parseTree(childObj.data).length > 0) kept.push({ mode: '40000', name: head, oid: child });
  }
  return storeObj(r.objects, 'tree', buildTree(kept));
}

export function blobAt(r: Repo, treeOid: string, segs: readonly string[]): string | null {
  let cur: string | null = treeOid;
  for (let i = 0; i < segs.length; i += 1) {
    if (cur === null) return null;
    const t = r.objects.get(cur);
    if (!t || t.type !== 'tree') return null;
    const e = parseTree(t.data).find((x) => x.name === segs[i]);
    if (!e) return null;
    if (i === segs.length - 1) return e.mode === '40000' ? null : e.oid;
    if (e.mode !== '40000') return null;
    cur = e.oid;
  }
  return null;
}

export function makeCommit(r: Repo, treeOid: string, parents: readonly string[], message: string): string {
  const s = nextSeq();
  const who = `${VIEWER.name} <${VIEWER.email}> ${BASE_EPOCH + s} +0000`;
  const msg = message.endsWith('\n') ? message : `${message}\n`;
  const lines = [`tree ${treeOid}`];
  for (const p of parents) lines.push(`parent ${p}`);
  lines.push(`author ${who}`, `committer ${who}`, '');
  return storeObj(r.objects, 'commit', Buffer.from(`${lines.join('\n')}\n${msg}`, 'utf8'));
}

/** Commits reachable from a tip, newest first (DFS pre-order over parents). */
export function commitList(r: Repo, tip: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const stack = [tip];
  while (stack.length) {
    const oid = stack.pop() as string;
    if (seen.has(oid) || !isOid(oid)) continue;
    seen.add(oid);
    const o = r.objects.get(oid);
    if (!o || o.type !== 'commit') continue;
    out.push(oid);
    const c = parseCommit(o.data);
    for (let i = c.parents.length - 1; i >= 0; i -= 1) stack.push(c.parents[i] as string);
  }
  return out;
}

/** First common ancestor of two tips (BFS from a, first node also reachable from b). */
export function mergeBase(r: Repo, a: string, b: string): string | null {
  const bAnc = new Set<string>();
  const stack = [b];
  while (stack.length) {
    const oid = stack.pop() as string;
    if (bAnc.has(oid)) continue;
    bAnc.add(oid);
    const o = r.objects.get(oid);
    if (!o || o.type !== 'commit') continue;
    for (const p of parseCommit(o.data).parents) stack.push(p);
  }
  const queue = [a];
  const seen = new Set<string>();
  while (queue.length) {
    const oid = queue.shift() as string;
    if (seen.has(oid)) continue;
    seen.add(oid);
    if (bAnc.has(oid)) return oid;
    const o = r.objects.get(oid);
    if (!o || o.type !== 'commit') continue;
    for (const p of parseCommit(o.data).parents) queue.push(p);
  }
  return null;
}

/** Diff two trees: path -> {status, oldOid, newOid}. */
export function diffTrees(r: Repo, oldTree: string | null, newTree: string | null): { path: string; status: 'added' | 'modified' | 'removed'; oldOid: string | null; newOid: string | null }[] {
  const a = new Map<string, { oid: string; mode: string }>();
  const b = new Map<string, { oid: string; mode: string }>();
  if (oldTree) flattenTree(r, oldTree, '', a);
  if (newTree) flattenTree(r, newTree, '', b);
  const out: { path: string; status: 'added' | 'modified' | 'removed'; oldOid: string | null; newOid: string | null }[] = [];
  for (const [path, v] of b) {
    const o = a.get(path);
    if (!o) out.push({ path, status: 'added', oldOid: null, newOid: v.oid });
    else if (o.oid !== v.oid) out.push({ path, status: 'modified', oldOid: o.oid, newOid: v.oid });
  }
  for (const [path, v] of a) {
    if (!b.has(path)) out.push({ path, status: 'removed', oldOid: v.oid, newOid: null });
  }
  out.sort((x, y) => (x.path < y.path ? -1 : 1));
  return out;
}

export function lineCount(data: Buffer): number {
  if (data.length === 0) return 0;
  let n = 0;
  for (let i = 0; i < data.length; i += 1) if (data[i] === 0x0a) n += 1;
  if (data[data.length - 1] !== 0x0a) n += 1;
  return n;
}

// ---------------------------------------------------------------- JSON shapes

export function repoJson(r: Repo): Buffer {
  if (r.repoJson) return r.repoJson;
  const body = {
    id: r.id,
    node_id: gid('Repository', r.id),
    name: r.name,
    full_name: `${r.owner}/${r.name}`,
    private: r.priv,
    owner: { login: r.owner, id: VIEWER.id, type: 'User' },
    description: r.description,
    default_branch: r.defaultBranch,
    created_at: r.createdAt,
    updated_at: r.createdAt,
    html_url: `https://example.invalid/${r.owner}/${r.name}`,
    url: `/api/v3/repos/${r.owner}/${r.name}`,
    has_issues: true,
    has_projects: true,
    has_wiki: true,
  };
  r.repoJson = Buffer.from(JSON.stringify(body), 'utf8');
  return r.repoJson;
}

export function invalidateRepo(r: Repo): void {
  r.repoJson = null;
}

export function issueJson(r: Repo, iss: Issue): Buffer {
  const cached = r.issueCache.get(iss.number);
  if (cached) return cached;
  const body = {
    id: iss.id,
    node_id: gid('Issue', r.id, iss.number),
    number: iss.number,
    title: iss.title,
    body: iss.body,
    state: iss.state,
    labels: iss.labels.map((name) => {
      const l = r.labels.get(name);
      return { name, color: l ? l.color : 'ededed', description: '' };
    }),
    user: { login: VIEWER.login, id: VIEWER.id, type: 'User' },
    created_at: iss.createdAt,
    updated_at: iss.updatedAt,
    closed_at: iss.closedAt,
    comments: (r.comments.get(iss.number) ?? []).length,
    url: `/api/v3/repos/${r.owner}/${r.name}/issues/${iss.number}`,
    html_url: `https://example.invalid/${r.owner}/${r.name}/issues/${iss.number}`,
  };
  const buf = Buffer.from(JSON.stringify(body), 'utf8');
  r.issueCache.set(iss.number, buf);
  return buf;
}

export function invalidateIssue(r: Repo, n: number): void {
  r.issueCache.delete(n);
}

export function createIssue(r: Repo, title: string, body: string, labels: string[]): Issue {
  const s = nextSeq();
  const iss: Issue = {
    number: r.nextIssue,
    id: 100000 + r.id * 1000 + r.nextIssue,
    title,
    body,
    state: 'open',
    labels: [...labels],
    seq: s,
    createdAt: stamp(s),
    updatedAt: stamp(s),
    closedAt: null,
  };
  r.nextIssue += 1;
  r.issues.push(iss);
  return iss;
}

export function pullJson(r: Repo, p: Pull): Record<string, unknown> {
  return {
    id: p.id,
    node_id: gid('PullRequest', r.id, p.number),
    number: p.number,
    title: p.title,
    body: p.body,
    state: p.state,
    merged: p.merged,
    merged_at: p.mergedAt,
    merge_commit_sha: p.mergeSha,
    mergeable: prMergeable(r, p),
    head: { ref: p.head, sha: p.headSha, label: `${r.owner}:${p.head}` },
    base: { ref: p.base, sha: p.baseSha, label: `${r.owner}:${p.base}` },
    user: { login: VIEWER.login, id: VIEWER.id, type: 'User' },
    created_at: p.createdAt,
    updated_at: p.updatedAt,
    url: `/api/v3/repos/${r.owner}/${r.name}/pulls/${p.number}`,
    html_url: `https://example.invalid/${r.owner}/${r.name}/pulls/${p.number}`,
  };
}

/** MERGEABLE / CONFLICTING for a pull request (UNKNOWN when a tip is missing). */
export function prMergeable(r: Repo, p: Pull): string {
  if (p.state !== 'open') return 'UNKNOWN';
  const headTip = branchTip(r, p.head);
  const baseTip = branchTip(r, p.base);
  if (!headTip || !baseTip) return 'UNKNOWN';
  const base = mergeBase(r, headTip, baseTip);
  if (base === null) return 'UNKNOWN';
  const baseTree = parseCommit(r.objects.get(base)?.data ?? Buffer.alloc(0)).tree;
  const headTree = parseCommit(r.objects.get(headTip)?.data ?? Buffer.alloc(0)).tree;
  const baseTipTree = parseCommit(r.objects.get(baseTip)?.data ?? Buffer.alloc(0)).tree;
  const headDiff = diffTrees(r, baseTree, headTree);
  const baseDiff = diffTrees(r, baseTree, baseTipTree);
  const baseChanged = new Map(baseDiff.map((d) => [d.path, d.newOid]));
  for (const d of headDiff) {
    if (baseChanged.has(d.path) && baseChanged.get(d.path) !== d.newOid) return 'CONFLICTING';
  }
  return 'MERGEABLE';
}

/** Squash-merge an open pull request; returns the merge commit sha or null on conflict. */
export function squashMerge(r: Repo, p: Pull): string | null {
  if (prMergeable(r, p) === 'CONFLICTING') return null;
  const headTip = branchTip(r, p.head) as string;
  const baseTip = branchTip(r, p.base) as string;
  const headTree = parseCommit(r.objects.get(headTip)?.data ?? Buffer.alloc(0)).tree;
  const sha = makeCommit(r, headTree, [baseTip], `Merge pull request #${p.number} from ${p.head}\n\n${p.title}`);
  r.refs.set(`refs/heads/${p.base}`, sha);
  p.state = 'closed';
  p.merged = true;
  p.mergeSha = sha;
  const s = nextSeq();
  p.mergedAt = stamp(s);
  p.updatedAt = stamp(s);
  p.baseSha = sha;
  return sha;
}

export function prFiles(r: Repo, p: Pull): Record<string, unknown>[] {
  const headTip = branchTip(r, p.head);
  const baseTip = branchTip(r, p.base);
  if (!headTip || !baseTip) return [];
  const base = mergeBase(r, headTip, baseTip);
  const baseTree = base ? parseCommit(r.objects.get(base)?.data ?? Buffer.alloc(0)).tree : null;
  const headTree = parseCommit(r.objects.get(headTip)?.data ?? Buffer.alloc(0)).tree;
  const out: Record<string, unknown>[] = [];
  for (const d of diffTrees(r, baseTree, headTree)) {
    const newData = d.newOid ? r.objects.get(d.newOid)?.data : null;
    const oldData = d.oldOid ? r.objects.get(d.oldOid)?.data : null;
    const additions = newData ? Math.max(d.status === 'added' || d.status === 'modified' ? 1 : 0, lineCount(newData)) : 0;
    const deletions = oldData ? lineCount(oldData) : 0;
    out.push({
      filename: d.path,
      status: d.status,
      additions: d.status === 'removed' ? 0 : additions,
      deletions: d.status === 'added' ? 0 : deletions,
      changes: (d.status === 'removed' ? 0 : additions) + (d.status === 'added' ? 0 : deletions),
      sha: d.newOid ?? d.oldOid,
    });
  }
  return out;
}

export { reachable };
export { hashObj };
