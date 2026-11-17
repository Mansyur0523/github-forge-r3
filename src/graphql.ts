// GraphQL over /api/graphql: a small executor for the fixed document set
// the suite sends. Fields, fragments, aliases, variables, pagination and
// the four mutations are handled; anything unknown lands in `errors`
// with HTTP 200, exactly as the checks expect.

import type { IncomingMessage, ServerResponse } from 'node:http';
import { VIEWER } from './viewer.ts';
import {
  branchTip, createIssue, getRepo, gid, invalidateIssue,
  nextSeq, prFiles, prMergeable, squashMerge, stamp,
  type Issue, type Pull, type Repo,
} from './store.ts';
import { errJson, readBody, sendJson } from './rest.ts';

// ---------------------------------------------------------------- tokenizer

type Tok = { kind: 'name' | 'int' | 'string' | 'punct' | 'var' | 'eof'; value: string };

function tokenize(src: string): Tok[] {
  const out: Tok[] = [];
  let i = 0;
  while (i < src.length) {
    const ch = src[i] as string;
    if (ch === ' ' || ch === '\n' || ch === '\r' || ch === '\t' || ch === ',') {
      i += 1;
      continue;
    }
    if (ch === '#') {
      while (i < src.length && src[i] !== '\n') i += 1;
      continue;
    }
    if (ch === '.' && src[i + 1] === '.' && src[i + 2] === '.') {
      out.push({ kind: 'punct', value: '...' });
      i += 3;
      continue;
    }
    if (ch === '"') {
      let j = i + 1;
      let val = '';
      while (j < src.length && src[j] !== '"') {
        if (src[j] === '\\' && j + 1 < src.length) {
          const e = src[j + 1] as string;
          val += e === 'n' ? '\n' : e === 't' ? '\t' : e === 'r' ? '\r' : e;
          j += 2;
        } else {
          val += src[j];
          j += 1;
        }
      }
      out.push({ kind: 'string', value: val });
      i = j + 1;
      continue;
    }
    if (ch === '$') {
      let j = i + 1;
      while (j < src.length && /[A-Za-z0-9_]/.test(src[j] as string)) j += 1;
      out.push({ kind: 'var', value: src.slice(i + 1, j) });
      i = j;
      continue;
    }
    if (/[0-9-]/.test(ch) && (ch !== '-' || /[0-9]/.test(src[i + 1] ?? ''))) {
      let j = i;
      while (j < src.length && /[0-9]/.test(src[j] as string)) j += 1;
      out.push({ kind: 'int', value: src.slice(i, j) });
      i = j;
      continue;
    }
    if (/[A-Za-z_]/.test(ch)) {
      let j = i;
      while (j < src.length && /[A-Za-z0-9_]/.test(src[j] as string)) j += 1;
      out.push({ kind: 'name', value: src.slice(i, j) });
      i = j;
      continue;
    }
    out.push({ kind: 'punct', value: ch });
    i += 1;
  }
  out.push({ kind: 'eof', value: '' });
  return out;
}

// ---------------------------------------------------------------- parser

type ValueNode = { kind: 'string' | 'int' | 'bool' | 'enum' | 'var' | 'list' | 'object'; value: unknown };
type FieldNode = {
  name: string;
  alias?: string;
  args: Record<string, ValueNode>;
  selection?: FieldNode[];
  fragment?: string;
};
type OpNode = { kind: 'query' | 'mutation'; name?: string; varDefs: string[]; fields: FieldNode[] };
type FragNode = { name: string; typeCond: string; fields: FieldNode[] };

class Parser {
  #toks: Tok[];
  #pos = 0;
  constructor(toks: Tok[]) {
    this.#toks = toks;
  }
  #peek(): Tok {
    return this.#toks[this.#pos] as Tok;
  }
  #next(): Tok {
    return this.#toks[this.#pos++] as Tok;
  }
  #eat(value: string): boolean {
    const t = this.#peek();
    if (t.value === value) {
      this.#pos += 1;
      return true;
    }
    return false;
  }
  #expect(value: string): void {
    if (!this.#eat(value)) throw new Error(`expected ${value}, got ${this.#peek().value}`);
  }
  #name(): string {
    const t = this.#next();
    if (t.kind !== 'name') throw new Error(`expected name, got ${t.value}`);
    return t.value;
  }
  parseDocument(): { ops: OpNode[]; frags: Map<string, FragNode> } {
    const ops: OpNode[] = [];
    const frags = new Map<string, FragNode>();
    while (this.#peek().kind !== 'eof') {
      const t = this.#peek();
      if (t.kind === 'name' && t.value === 'fragment') {
        this.#next();
        const name = this.#name();
        this.#expect('on');
        const typeCond = this.#name();
        const fields = this.parseSelection();
        frags.set(name, { name, typeCond, fields });
      } else {
        ops.push(this.parseOperation());
      }
    }
    return { ops, frags };
  }
  parseOperation(): OpNode {
    let kind: 'query' | 'mutation' = 'query';
    const t = this.#peek();
    if (t.kind === 'name' && (t.value === 'query' || t.value === 'mutation')) {
      kind = this.#next().value as 'query' | 'mutation';
    }
    let name: string | undefined;
    if (this.#peek().kind === 'name') name = this.#name();
    const varDefs: string[] = [];
    if (this.#eat('(')) {
      while (!this.#eat(')')) {
        const v = this.#next();
        if (v.kind === 'var') varDefs.push(v.value);
        if (this.#eat(':')) this.skipType();
        if (this.#peek().value === '=') {
          this.#next();
          this.parseValue();
        }
      }
    }
    const fields = this.parseSelection();
    return { kind, name, varDefs, fields };
  }
  skipType(): void {
    if (this.#eat('[')) {
      this.skipType();
      this.#expect(']');
    } else {
      this.#name();
    }
    this.#eat('!');
  }
  parseSelection(): FieldNode[] {
    this.#expect('{');
    const fields: FieldNode[] = [];
    while (!this.#eat('}')) {
      if (this.#peek().value === '...') {
        this.#next();
        if (this.#peek().kind === 'name' && this.#peek().value === 'on') {
          this.#next();
          this.#name();
          fields.push(...this.parseSelection());
        } else {
          const frag = this.#name();
          fields.push({ name: '', fragment: frag, args: {} });
        }
        continue;
      }
      let name = this.#name();
      let alias: string | undefined;
      if (this.#eat(':')) {
        alias = name;
        name = this.#name();
      }
      const args: Record<string, ValueNode> = {};
      if (this.#eat('(')) {
        while (!this.#eat(')')) {
          const argName = this.#name();
          this.#expect(':');
          args[argName] = this.parseValue();
        }
      }
      let selection: FieldNode[] | undefined;
      if (this.#peek().value === '{') selection = this.parseSelection();
      fields.push({ name, alias, args, selection });
    }
    return fields;
  }
  parseValue(): ValueNode {
    const t = this.#next();
    if (t.kind === 'string') return { kind: 'string', value: t.value };
    if (t.kind === 'int') return { kind: 'int', value: parseInt(t.value, 10) };
    if (t.kind === 'var') return { kind: 'var', value: t.value };
    if (t.value === '[') {
      const items: ValueNode[] = [];
      while (!this.#eat(']')) items.push(this.parseValue());
      return { kind: 'list', value: items };
    }
    if (t.value === '{') {
      const obj: Record<string, ValueNode> = {};
      while (!this.#eat('}')) {
        const k = this.#name();
        this.#expect(':');
        obj[k] = this.parseValue();
      }
      return { kind: 'object', value: obj };
    }
    if (t.kind === 'name') {
      if (t.value === 'true') return { kind: 'bool', value: true };
      if (t.value === 'false') return { kind: 'bool', value: false };
      return { kind: 'enum', value: t.value };
    }
    throw new Error(`unexpected value token ${t.value}`);
  }
}

// ---------------------------------------------------------------- executor

interface Ctx {
  vars: Record<string, unknown>;
  frags: Map<string, FragNode>;
  errors: { message: string }[];
}

function evalValue(node: ValueNode, ctx: Ctx): unknown {
  switch (node.kind) {
    case 'string':
    case 'int':
    case 'bool':
    case 'enum':
      return node.value;
    case 'var':
      return ctx.vars[node.value as string];
    case 'list':
      return (node.value as ValueNode[]).map((v) => evalValue(v, ctx));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(node.value as Record<string, ValueNode>)) out[k] = evalValue(v, ctx);
      return out;
    }
  }
}

function evalArgs(field: FieldNode, ctx: Ctx): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(field.args)) out[k] = evalValue(v, ctx);
  return out;
}

const REPO_TYPE_FIELDS = ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest'];
const ISSUE_TYPE_FIELDS = ['id', 'number', 'title', 'state', 'body'];
const PR_TYPE_FIELDS = ['id', 'number', 'headRefName', 'baseRefName', 'mergeable', 'state', 'merged', 'files'];

function typeFields(name: string): string[] | null {
  if (name === 'Repository') return REPO_TYPE_FIELDS;
  if (name === 'Issue') return ISSUE_TYPE_FIELDS;
  if (name === 'PullRequest') return PR_TYPE_FIELDS;
  return null;
}

function resolveFields(fields: FieldNode[], ctx: Ctx): FieldNode[] {
  const out: FieldNode[] = [];
  for (const f of fields) {
    if (f.fragment) {
      const frag = ctx.frags.get(f.fragment);
      if (frag) out.push(...resolveFields(frag.fields, ctx));
      continue;
    }
    const copy = { ...f };
    if (f.selection) copy.selection = resolveFields(f.selection, ctx);
    out.push(copy);
  }
  return out;
}

function issueObj(r: Repo, iss: Issue, fields: FieldNode[], ctx: Ctx): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const f of fields) {
    const key = f.alias ?? f.name;
    switch (f.name) {
      case 'id':
        out[key] = gid('Issue', r.id, iss.number);
        break;
      case 'number':
        out[key] = iss.number;
        break;
      case 'title':
        out[key] = iss.title;
        break;
      case 'body':
        out[key] = iss.body;
        break;
      case 'state':
        out[key] = iss.state.toUpperCase();
        break;
      case '__typename':
        out[key] = 'Issue';
        break;
      default:
        ctx.errors.push({ message: `Field '${f.name}' doesn't exist on type 'Issue'` });
        out[key] = null;
    }
  }
  return out;
}

function pullObj(r: Repo, p: Pull, fields: FieldNode[], ctx: Ctx): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const f of fields) {
    const key = f.alias ?? f.name;
    switch (f.name) {
      case 'id':
        out[key] = gid('PullRequest', r.id, p.number);
        break;
      case 'number':
        out[key] = p.number;
        break;
      case 'title':
        out[key] = p.title;
        break;
      case 'state':
        out[key] = p.merged ? 'MERGED' : p.state.toUpperCase();
        break;
      case 'merged':
        out[key] = p.merged;
        break;
      case 'headRefName':
        out[key] = p.head;
        break;
      case 'baseRefName':
        out[key] = p.base;
        break;
      case 'mergeable':
        out[key] = prMergeable(r, p);
        break;
      case 'files': {
        const args = evalArgs(f, ctx);
        const first = typeof args.first === 'number' ? args.first : 10;
        const files = prFiles(r, p).slice(0, first);
        const sel = f.selection ? resolveFields(f.selection, ctx) : [];
        const nodesField = sel.find((x) => x.name === 'nodes');
        const nodeSel = nodesField?.selection ? resolveFields(nodesField.selection, ctx) : [];
        const nodes = files.map((file) => {
          const o: Record<string, unknown> = {};
          for (const sf of nodeSel) {
            if (sf.name === 'path') o[sf.alias ?? 'path'] = file.filename;
            else if (sf.name === 'additions') o[sf.alias ?? 'additions'] = file.additions;
            else if (sf.name === 'deletions') o[sf.alias ?? 'deletions'] = file.deletions;
            else if (sf.name === '__typename') o[sf.alias ?? '__typename'] = 'PullRequestChangedFile';
          }
          return o;
        });
        out[key] = { nodes, totalCount: files.length };
        break;
      }
      case '__typename':
        out[key] = 'PullRequest';
        break;
      default:
        ctx.errors.push({ message: `Field '${f.name}' doesn't exist on type 'PullRequest'` });
        out[key] = null;
    }
  }
  return out;
}

function repoObj(r: Repo, fields: FieldNode[], ctx: Ctx): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const f of fields) {
    const key = f.alias ?? f.name;
    switch (f.name) {
      case 'id':
        out[key] = gid('Repository', r.id);
        break;
      case 'databaseId':
        out[key] = r.id;
        break;
      case 'name':
        out[key] = r.name;
        break;
      case 'nameWithOwner':
        out[key] = `${r.owner}/${r.name}`;
        break;
      case 'owner': {
        const sel = f.selection ? resolveFields(f.selection, ctx) : [];
        const o: Record<string, unknown> = {};
        for (const sf of sel) {
          const sk = sf.alias ?? sf.name;
          if (sf.name === 'login') o[sk] = r.owner;
          else if (sf.name === 'id') o[sk] = gid('User', VIEWER.id);
          else if (sf.name === '__typename') o[sk] = 'User';
          else {
            ctx.errors.push({ message: `Field '${sf.name}' doesn't exist on type 'User'` });
            o[sk] = null;
          }
        }
        out[key] = o;
        break;
      }
      case 'defaultBranchRef': {
        const sel = f.selection ? resolveFields(f.selection, ctx) : [];
        const o: Record<string, unknown> = {};
        for (const sf of sel) {
          const sk = sf.alias ?? sf.name;
          if (sf.name === 'name') o[sk] = r.defaultBranch;
          else if (sf.name === '__typename') o[sk] = 'Ref';
          else {
            ctx.errors.push({ message: `Field '${sf.name}' doesn't exist on type 'Ref'` });
            o[sk] = null;
          }
        }
        out[key] = o;
        break;
      }
      case 'viewerPermission':
        out[key] = 'ADMIN';
        break;
      case 'hasIssuesEnabled':
        out[key] = true;
        break;
      case 'issue': {
        const args = evalArgs(f, ctx);
        const iss = r.issues.find((i) => i.number === args.number);
        out[key] = iss && f.selection ? issueObj(r, iss, resolveFields(f.selection, ctx), ctx) : null;
        break;
      }
      case 'issues': {
        const args = evalArgs(f, ctx);
        const first = typeof args.first === 'number' ? args.first : 10;
        const after = typeof args.after === 'string' ? args.after : null;
        let states: string[] | null = null;
        if (Array.isArray(args.states)) states = (args.states as unknown[]).map((s) => String(s));
        let list = [...r.issues];
        if (states) list = list.filter((i) => states?.includes(i.state.toUpperCase()));
        let orderBy = args.orderBy as { field?: string; direction?: string } | undefined;
        if (orderBy && orderBy.field === 'CREATED_AT') {
          list.sort((a, b) => (orderBy?.direction === 'DESC' ? b.seq - a.seq : a.seq - b.seq));
        } else {
          list.sort((a, b) => b.seq - a.seq);
        }
        let start = 0;
        if (after) {
          const idx = list.findIndex((i) => Buffer.from(`cursor:${i.number}`, 'utf8').toString('base64') === after);
          start = idx >= 0 ? idx + 1 : list.length;
        }
        const page = list.slice(start, start + first);
        const sel = f.selection ? resolveFields(f.selection, ctx) : [];
        const conn: Record<string, unknown> = {};
        for (const sf of sel) {
          const sk = sf.alias ?? sf.name;
          if (sf.name === 'nodes') {
            conn[sk] = page.map((iss) => issueObj(r, iss, sf.selection ? resolveFields(sf.selection, ctx) : [], ctx));
          } else if (sf.name === 'edges') {
            conn[sk] = page.map((iss) => {
              const edge: Record<string, unknown> = { cursor: Buffer.from(`cursor:${iss.number}`, 'utf8').toString('base64') };
              if (sf.selection) {
                for (const ef of resolveFields(sf.selection, ctx)) {
                  if (ef.name === 'node') edge[ef.alias ?? 'node'] = issueObj(r, iss, ef.selection ? resolveFields(ef.selection, ctx) : [], ctx);
                  else if (ef.name === 'cursor') edge[ef.alias ?? 'cursor'] = Buffer.from(`cursor:${iss.number}`, 'utf8').toString('base64');
                }
              }
              return edge;
            });
          } else if (sf.name === 'totalCount') {
            conn[sk] = list.length;
          } else if (sf.name === 'pageInfo') {
            const pi: Record<string, unknown> = {};
            if (sf.selection) {
              for (const pf of resolveFields(sf.selection, ctx)) {
                const pk = pf.alias ?? pf.name;
                if (pf.name === 'hasNextPage') pi[pk] = start + first < list.length;
                else if (pf.name === 'hasPreviousPage') pi[pk] = start > 0;
                else if (pf.name === 'endCursor') pi[pk] = page.length ? Buffer.from(`cursor:${page[page.length - 1]?.number}`, 'utf8').toString('base64') : null;
                else if (pf.name === 'startCursor') pi[pk] = page.length ? Buffer.from(`cursor:${page[0]?.number}`, 'utf8').toString('base64') : null;
              }
            }
            conn[sk] = pi;
          }
        }
        out[key] = conn;
        break;
      }
      case 'pullRequests': {
        const args = evalArgs(f, ctx);
        const first = typeof args.first === 'number' ? args.first : 10;
        const list = [...r.pulls].sort((a, b) => b.seq - a.seq).slice(0, first);
        const sel = f.selection ? resolveFields(f.selection, ctx) : [];
        const conn: Record<string, unknown> = {};
        for (const sf of sel) {
          const sk = sf.alias ?? sf.name;
          if (sf.name === 'nodes') conn[sk] = list.map((p) => pullObj(r, p, sf.selection ? resolveFields(sf.selection, ctx) : [], ctx));
          else if (sf.name === 'totalCount') conn[sk] = r.pulls.length;
        }
        out[key] = conn;
        break;
      }
      case 'pullRequest': {
        const args = evalArgs(f, ctx);
        const p = r.pulls.find((x) => x.number === args.number);
        out[key] = p && f.selection ? pullObj(r, p, resolveFields(f.selection, ctx), ctx) : null;
        break;
      }
      case '__typename':
        out[key] = 'Repository';
        break;
      default:
        ctx.errors.push({ message: `Field '${f.name}' doesn't exist on type 'Repository'` });
        out[key] = null;
    }
  }
  return out;
}

function execOperation(op: OpNode, vars: Record<string, unknown>, frags: Map<string, FragNode>): { data: Record<string, unknown>; errors: { message: string }[] } {
  const ctx: Ctx = { vars, frags, errors: [] };
  const data: Record<string, unknown> = {};
  for (const f of op.fields) {
    const key = f.alias ?? f.name;
    if (op.kind === 'query') {
      if (f.name === 'viewer') {
        const sel = f.selection ? resolveFields(f.selection, ctx) : [];
        const o: Record<string, unknown> = {};
        for (const sf of sel) {
          const sk = sf.alias ?? sf.name;
          if (sf.name === 'login') o[sk] = VIEWER.login;
          else if (sf.name === 'id') o[sk] = gid('User', VIEWER.id);
          else if (sf.name === '__typename') o[sk] = 'User';
          else {
            ctx.errors.push({ message: `Field '${sf.name}' doesn't exist on type 'User'` });
            o[sk] = null;
          }
        }
        data[key] = o;
      } else if (f.name === 'repository') {
        const args = evalArgs(f, ctx);
        const r = getRepo(String(args.owner ?? ''), String(args.name ?? ''));
        data[key] = r && r.owner === VIEWER.login && f.selection ? repoObj(r, resolveFields(f.selection, ctx), ctx) : null;
      } else if (f.name === 'node') {
        const args = evalArgs(f, ctx);
        const raw = typeof args.id === 'string' ? Buffer.from(args.id, 'base64').toString('utf8') : '';
        const parts = raw.split(':');
        let node: Record<string, unknown> | null = null;
        if (parts[0] === 'Repository') {
          const r = [...(allRepos())].find((x) => x.id === Number(parts[1]));
          if (r && f.selection) {
            const sel = resolveFields(f.selection, ctx);
            // Inline fragments on Repository only.
            node = repoObj(r, sel.filter((x) => x.name !== '__typename' || true), ctx);
          }
        }
        data[key] = node;
      } else if (f.name === '__type') {
        const args = evalArgs(f, ctx);
        const typeName = String(args.name ?? '');
        const fields = typeFields(typeName);
        const sel = f.selection ? resolveFields(f.selection, ctx) : [];
        const o: Record<string, unknown> = {};
        for (const sf of sel) {
          const sk = sf.alias ?? sf.name;
          if (sf.name === 'fields') {
            const inner = sf.selection ? resolveFields(sf.selection, ctx) : [];
            o[sk] = (fields ?? []).map((name) => {
              const fo: Record<string, unknown> = {};
              for (const inf of inner) if (inf.name === 'name') fo[inf.alias ?? 'name'] = name;
              return fo;
            });
          } else if (sf.name === 'name') {
            o[sk] = args.name;
          } else if (sf.name === 'kind') {
            o[sk] = typeName === 'SearchType' ? 'ENUM' : 'OBJECT';
          } else if (sf.name === 'enumValues') {
            if (typeName === 'SearchType') {
              const inner = sf.selection ? resolveFields(sf.selection, ctx) : [];
              o[sk] = ['ISSUE', 'REPOSITORY', 'USER', 'DISCUSSION'].map((n) => {
                const ev: Record<string, unknown> = {};
                for (const inf of inner) if (inf.name === 'name') ev[inf.alias ?? 'name'] = n;
                return ev;
              });
            } else {
              o[sk] = null;
            }
          }
        }
        data[key] = o;
      } else if (f.name === '__schema') {
        data[key] = { queryType: { name: 'Query' } };
      } else {
        ctx.errors.push({ message: `Cannot query field '${f.name}' on type 'Query'` });
        data[key] = null;
      }
    } else {
      // mutations
      const args = evalArgs(f, ctx);
      if (f.name === 'createIssue') {
        const input = (args.input ?? {}) as Record<string, unknown>;
        const rawId = String(input.repositoryId ?? '');
        const parts = Buffer.from(rawId, 'base64').toString('utf8').split(':');
        const r = parts[0] === 'Repository' ? [...allRepos()].find((x) => x.id === Number(parts[1])) : undefined;
        if (!r) {
          ctx.errors.push({ message: 'Repository not found' });
          data[key] = null;
        } else {
          const iss = createIssue(r, String(input.title ?? ''), String(input.body ?? ''), []);
          const sel = f.selection ? resolveFields(f.selection, ctx) : [];
          const o: Record<string, unknown> = {};
          for (const sf of sel) {
            const sk = sf.alias ?? sf.name;
            if (sf.name === 'issue' && sf.selection) o[sk] = issueObj(r, iss, resolveFields(sf.selection, ctx), ctx);
            else if (sf.name === 'clientMutationId') o[sk] = input.clientMutationId ?? null;
          }
          data[key] = o;
        }
      } else if (f.name === 'closeIssue') {
        const input = (args.input ?? {}) as Record<string, unknown>;
        const rawId = String(input.issueId ?? '');
        const parts = Buffer.from(rawId, 'base64').toString('utf8').split(':');
        let iss: Issue | null = null;
        let repo: Repo | null = null;
        if (parts[0] === 'Issue') {
          for (const r of allRepos()) {
            const found = r.issues.find((i) => i.number === Number(parts[2]));
            if (found && r.id === Number(parts[1])) {
              iss = found;
              repo = r;
            }
          }
        }
        if (!iss || !repo) {
          ctx.errors.push({ message: 'Issue not found' });
          data[key] = null;
        } else {
          iss.state = 'closed';
          iss.closedAt = stamp(nextSeq());
          iss.updatedAt = stamp(nextSeq());
          invalidateIssue(repo, iss.number);
          const sel = f.selection ? resolveFields(f.selection, ctx) : [];
          const o: Record<string, unknown> = {};
          for (const sf of sel) {
            const sk = sf.alias ?? sf.name;
            if (sf.name === 'issue' && sf.selection) o[sk] = issueObj(repo, iss, resolveFields(sf.selection, ctx), ctx);
            else if (sf.name === 'clientMutationId') o[sk] = input.clientMutationId ?? null;
          }
          data[key] = o;
        }
      } else if (f.name === 'createPullRequest') {
        const input = (args.input ?? {}) as Record<string, unknown>;
        const rawId = String(input.repositoryId ?? '');
        const parts = Buffer.from(rawId, 'base64').toString('utf8').split(':');
        const r = parts[0] === 'Repository' ? [...allRepos()].find((x) => x.id === Number(parts[1])) : undefined;
        const head = String(input.headRefName ?? '');
        const base = String(input.baseRefName ?? '');
        const headSha = r ? branchTip(r, head) : undefined;
        const baseSha = r ? branchTip(r, base) : undefined;
        if (!r || !headSha || !baseSha) {
          ctx.errors.push({ message: 'Repository or branch not found' });
          data[key] = null;
        } else {
          const s = nextSeq();
          const p: Pull = {
            number: r.nextPull,
            id: 300000 + r.id * 1000 + r.nextPull,
            title: String(input.title ?? ''),
            body: String(input.body ?? ''),
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
          const sel = f.selection ? resolveFields(f.selection, ctx) : [];
          const o: Record<string, unknown> = {};
          for (const sf of sel) {
            const sk = sf.alias ?? sf.name;
            if (sf.name === 'pullRequest' && sf.selection) o[sk] = pullObj(r, p, resolveFields(sf.selection, ctx), ctx);
            else if (sf.name === 'clientMutationId') o[sk] = input.clientMutationId ?? null;
          }
          data[key] = o;
        }
      } else if (f.name === 'mergePullRequest') {
        const input = (args.input ?? {}) as Record<string, unknown>;
        const rawId = String(input.pullRequestId ?? '');
        const parts = Buffer.from(rawId, 'base64').toString('utf8').split(':');
        let p: Pull | null = null;
        let repo: Repo | null = null;
        if (parts[0] === 'PullRequest') {
          for (const r of allRepos()) {
            const found = r.pulls.find((x) => x.number === Number(parts[2]));
            if (found && r.id === Number(parts[1])) {
              p = found;
              repo = r;
            }
          }
        }
        if (!p || !repo) {
          ctx.errors.push({ message: 'Pull request not found' });
          data[key] = null;
        } else if (prMergeable(repo, p) === 'CONFLICTING') {
          ctx.errors.push({ message: 'Merge conflict' });
          data[key] = null;
        } else {
          squashMerge(repo, p);
          const sel = f.selection ? resolveFields(f.selection, ctx) : [];
          const o: Record<string, unknown> = {};
          for (const sf of sel) {
            const sk = sf.alias ?? sf.name;
            if (sf.name === 'pullRequest' && sf.selection) o[sk] = pullObj(repo, p, resolveFields(sf.selection, ctx), ctx);
            else if (sf.name === 'clientMutationId') o[sk] = input.clientMutationId ?? null;
          }
          data[key] = o;
        }
      } else if (f.name === 'addComment') {
        const input = (args.input ?? {}) as Record<string, unknown>;
        const rawId = String(input.subjectId ?? '');
        const parts = Buffer.from(rawId, 'base64').toString('utf8').split(':');
        let iss: Issue | null = null;
        let repo: Repo | null = null;
        if (parts[0] === 'Issue') {
          for (const r of allRepos()) {
            const found = r.issues.find((i) => i.number === Number(parts[2]));
            if (found && r.id === Number(parts[1])) {
              iss = found;
              repo = r;
            }
          }
        }
        if (!iss || !repo) {
          ctx.errors.push({ message: 'Subject not found' });
          data[key] = null;
        } else {
          const s = nextSeq();
          const c = { id: 200000 + repo.id * 1000 + repo.nextComment, body: String(input.body ?? ''), seq: s, createdAt: stamp(s) };
          repo.nextComment += 1;
          const list = repo.comments.get(iss.number) ?? [];
          list.push(c);
          repo.comments.set(iss.number, list);
          invalidateIssue(repo, iss.number);
          const sel = f.selection ? resolveFields(f.selection, ctx) : [];
          const o: Record<string, unknown> = {};
          for (const sf of sel) {
            const sk = sf.alias ?? sf.name;
            if (sf.name === 'commentEdge') {
              const edge: Record<string, unknown> = {};
              if (sf.selection) {
                for (const ef of resolveFields(sf.selection, ctx)) {
                  if (ef.name === 'node') {
                    const node: Record<string, unknown> = {};
                    if (ef.selection) {
                      for (const nf of resolveFields(ef.selection, ctx)) {
                        const nk = nf.alias ?? nf.name;
                        if (nf.name === 'id') node[nk] = gid('IssueComment', repo.id, iss.number, c.id);
                        else if (nf.name === 'body') node[nk] = c.body;
                        else if (nf.name === '__typename') node[nk] = 'IssueComment';
                      }
                    }
                    edge[ef.alias ?? 'node'] = node;
                  }
                }
              }
              o[sk] = edge;
            } else if (sf.name === 'clientMutationId') {
              o[sk] = input.clientMutationId ?? null;
            }
          }
          data[key] = o;
        }
      } else {
        ctx.errors.push({ message: `Cannot query field '${f.name}' on type 'Mutation'` });
        data[key] = null;
      }
    }
  }
  return { data, errors: ctx.errors };
}

function allRepos(): Iterable<Repo> {
  // Repos are stored keyed by owner+name; iterate the viewer's set.
  return allViewerReposLocal();
}

import { allViewerRepos as allViewerReposLocal } from './store.ts';

export async function handleGraphql(req: IncomingMessage, res: ServerResponse, reqId: string): Promise<boolean> {
  if (req.method !== 'POST') return false;
  const raw = await readBody(req);
  let body: unknown;
  try {
    body = JSON.parse(raw.toString('utf8')) as unknown;
  } catch {
    errJson(res, 400, 'Problems parsing JSON', reqId);
    return true;
  }
  const runOne = (doc: Record<string, unknown>): Record<string, unknown> => {
    const query = typeof doc.query === 'string' ? doc.query : '';
    const vars = (doc.variables ?? {}) as Record<string, unknown>;
    if (!query) return { data: null, errors: [{ message: 'query is required' }] };
    let parsedDoc: { ops: OpNode[]; frags: Map<string, FragNode> };
    try {
      parsedDoc = new Parser(tokenize(query)).parseDocument();
    } catch (e) {
      return { data: null, errors: [{ message: e instanceof Error ? e.message : 'parse error' }] };
    }
    const opName = typeof doc.operationName === 'string' ? doc.operationName : undefined;
    const op = parsedDoc.ops.find((o) => o.name === opName) ?? parsedDoc.ops[0];
    if (!op) return { data: null, errors: [{ message: 'no operation' }] };
    const result = execOperation(op, vars, parsedDoc.frags);
    const out: Record<string, unknown> = { data: result.data };
    if (result.errors.length) out.errors = result.errors;
    return out;
  };
  let payload: unknown;
  if (Array.isArray(body)) {
    payload = body.map((d) => (d && typeof d === 'object' ? runOne(d as Record<string, unknown>) : { data: null, errors: [{ message: 'invalid document' }] }));
  } else {
    payload = runOne(body);
  }
  sendJson(res, 200, Buffer.from(JSON.stringify(payload), 'utf8'), reqId);
  return true;
}
