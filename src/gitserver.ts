// Git smart HTTP: v2 upload-pack (ls-refs, fetch), v0 upload-pack and
// v0 receive-pack. Packs are delta-free; fetch honours haves, depth and
// shallow boundaries exactly as the client's checks read them.

import {
  type Repo,
} from './store.ts';
import {
  PKT_DELIM, PKT_FLUSH, ZERO_OID, decodePackets, hashObj, isAncestor, isOid,
  packTrailerOk, parseCommit, parseTag, parseTree, pkt, pktSeq, readPack, reachable,
  storeObj, writePack, type GitObj,
} from './gitpack.ts';

const AGENT = 'forge/1.0';
const UPLOAD_CAPS_V2 = ['fetch=shallow filter', 'ls-refs=unborn', 'object-format=sha1', `agent=${AGENT}`];
const UPLOAD_CAPS_V0 = `symref=HEAD:refs/heads/main side-band-64k thin-pack ofs-delta multi_ack multi_ack_detailed shallow filter agent=${AGENT}`;
const RECEIVE_CAPS_V0 = `symref=HEAD:refs/heads/main report-status report-status-v2 side-band-64k delete-refs ofs-delta agent=${AGENT}`;

export interface GitReply {
  status: number;
  contentType: string;
  body: Buffer;
}

function peelTarget(r: Repo, oid: string): string | null {
  let cur = oid;
  for (let i = 0; i < 8; i += 1) {
    const o = r.objects.get(cur);
    if (!o) return null;
    if (o.type === 'tag') cur = parseTag(o.data).object;
    else return cur;
  }
  return null;
}

interface RefLine {
  oid: string;
  name: string;
  peeled?: string;
}

function refLines(r: Repo): RefLine[] {
  const out: RefLine[] = [];
  const names = [...r.refs.keys()].sort();
  for (const name of names) {
    const oid = r.refs.get(name) as string;
    const line: RefLine = { oid, name };
    const o = r.objects.get(oid);
    if (o && o.type === 'tag') {
      const peeled = peelTarget(r, oid);
      if (peeled) line.peeled = peeled;
    }
    out.push(line);
  }
  return out;
}

function headOid(r: Repo): string {
  return r.refs.get(`refs/heads/${r.defaultBranch}`) ?? ZERO_OID;
}

function treeComplete(r: Repo, treeOid: string): boolean {
  const stack = [treeOid];
  const seen = new Set<string>();
  while (stack.length) {
    const t = stack.pop() as string;
    if (seen.has(t)) continue;
    seen.add(t);
    const tob = r.objects.get(t);
    if (!tob || tob.type !== 'tree') return false;
    for (const e of parseTree(tob.data)) {
      if (e.mode === '40000') stack.push(e.oid);
      else if (!r.objects.has(e.oid)) return false;
    }
  }
  return true;
}

// ---------------------------------------------------------------- advertisements

function v2Advertisement(): Buffer {
  const lines: (string | 'flush')[] = ['version 2\n', ...UPLOAD_CAPS_V2.map((c) => `${c}\n`), 'flush'];
  return pktSeq(lines);
}

function v0Advertisement(r: Repo, service: 'git-upload-pack' | 'git-receive-pack'): Buffer {
  const caps = service === 'git-upload-pack' ? UPLOAD_CAPS_V0 : RECEIVE_CAPS_V0;
  const refs = refLines(r);
  const parts: Buffer[] = [pkt(`# service=${service}\n`), PKT_FLUSH];
  if (refs.length === 0) {
    parts.push(pkt(`${ZERO_OID} capabilities^{}\0${caps}\n`));
  } else {
    const head = headOid(r);
    const first = head !== ZERO_OID ? { oid: head, name: 'HEAD' } : refs[0] as RefLine;
    parts.push(pkt(`${first.oid} ${first.name}\0${caps}\n`));
    for (const ref of refs) {
      parts.push(pkt(`${ref.oid} ${ref.name}\n`));
      if (ref.peeled) parts.push(pkt(`${ref.peeled} ${ref.name}^{}\n`));
    }
  }
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

export function infoRefs(r: Repo | undefined, service: string, wantV2: boolean): GitReply {
  if (!r) return { status: 404, contentType: 'application/json; charset=utf-8', body: Buffer.from(JSON.stringify({ message: 'Not Found' }), 'utf8') };
  if (service === 'git-upload-pack') {
    if (wantV2) return { status: 200, contentType: 'application/x-git-upload-pack-advertisement', body: v2Advertisement() };
    return { status: 200, contentType: 'application/x-git-upload-pack-advertisement', body: v0Advertisement(r, service) };
  }
  if (service === 'git-receive-pack') {
    return { status: 200, contentType: 'application/x-git-receive-pack-advertisement', body: v0Advertisement(r, service) };
  }
  return { status: 400, contentType: 'application/json; charset=utf-8', body: Buffer.from(JSON.stringify({ message: 'unknown service' }), 'utf8') };
}

// ---------------------------------------------------------------- ls-refs (v2)

function lsRefs(r: Repo, prefixes: string[], peel: boolean, symrefs: boolean): Buffer {
  const keep = (name: string): boolean => prefixes.length === 0 || prefixes.some((p) => name.startsWith(p));
  const lines: string[] = [];
  const tip = headOid(r);
  if (prefixes.length === 0 && symrefs && tip !== ZERO_OID) {
    lines.push(`${tip} HEAD symref-target:refs/heads/${r.defaultBranch}\n`);
  }
  for (const ref of refLines(r)) {
    if (!keep(ref.name)) continue;
    let line = `${ref.oid} ${ref.name}`;
    if (peel && ref.peeled) line += ` peeled:${ref.peeled}`;
    lines.push(`${line}\n`);
  }
  return pktSeq([...lines, 'flush']);
}

// ---------------------------------------------------------------- fetch

interface FetchArgs {
  wants: string[];
  haves: string[];
  shallow: string[];
  depth: number | null;
}

interface FetchPlan {
  objects: GitObj[];
  shallow: string[];
  unshallow: string[];
}

/** Objects reachable from `roots`, but never descending past a commit in
 * `stop` (a shallow boundary): the commit and its tree are held, its
 * parents are not. This is what makes a deepen fetch actually deliver
 * the parent of a shallow tip. */
function heldClosure(roots: Iterable<string>, stop: ReadonlySet<string>, lookupFn: (oid: string) => GitObj | undefined): Set<string> {
  const seen = new Set<string>();
  const stack: string[] = [];
  for (const r of roots) if (isOid(r)) stack.push(r);
  while (stack.length) {
    const oid = stack.pop() as string;
    if (seen.has(oid)) continue;
    const o = lookupFn(oid);
    if (!o) continue;
    seen.add(oid);
    if (o.type === 'commit') {
      const c = parseCommit(o.data);
      stack.push(c.tree);
      if (!stop.has(oid)) for (const p of c.parents) stack.push(p);
    } else if (o.type === 'tag') {
      stack.push(parseTag(o.data).object);
    } else if (o.type === 'tree') {
      for (const e of parseTree(o.data)) if (e.mode !== '160000') stack.push(e.oid);
    }
  }
  return seen;
}

function planFetch(r: Repo, args: FetchArgs, haveObjects: Map<string, GitObj> | null): FetchPlan {
  const lookupFn = (oid: string): GitObj | undefined => r.objects.get(oid);
  const held = heldClosure(args.haves, new Set(args.shallow), lookupFn);
  if (haveObjects) for (const k of haveObjects.keys()) held.add(k);

  const included = new Set<string>();
  let shallow: string[] = [];
  let unshallow: string[] = [];
  if (args.depth === null) {
    for (const w of args.wants) {
      for (const oid of reachable([w], lookupFn)) included.add(oid);
    }
  } else {
    // Generations of commits from the wants, cut at `depth`.
    const gens: string[][] = [];
    let frontier = args.wants.filter(isOid);
    const seenCommits = new Set<string>();
    for (let g = 0; g < args.depth && frontier.length; g += 1) {
      const gen: string[] = [];
      for (const oid of frontier) {
        if (seenCommits.has(oid)) continue;
        seenCommits.add(oid);
        const o = r.objects.get(oid);
        if (!o || o.type !== 'commit') continue;
        gen.push(oid);
      }
      gens.push(gen);
      const next: string[] = [];
      for (const oid of gen) {
        for (const p of parseCommit(r.objects.get(oid)?.data ?? Buffer.alloc(0)).parents) next.push(p);
      }
      frontier = next;
    }
    const boundary = gens.length ? (gens[gens.length - 1] as string[]) : [];
    shallow = boundary.filter((oid) => {
      const o = r.objects.get(oid);
      return !!o && o.type === 'commit' && parseCommit(o.data).parents.length > 0;
    });
    const boundarySet = new Set(boundary);
    unshallow = args.shallow.filter((oid) => seenCommits.has(oid) && !boundarySet.has(oid));
    // Tree closure of the included commits only — never walk parents, so
    // a shallow clone costs O(tree), not O(history).
    const kept = new Set<string>();
    for (const oid of seenCommits) {
      const o = r.objects.get(oid);
      if (!o || o.type !== 'commit') continue;
      kept.add(oid);
      const stack = [parseCommit(o.data).tree];
      while (stack.length) {
        const t = stack.pop() as string;
        if (kept.has(t)) continue;
        const tob = r.objects.get(t);
        if (!tob || tob.type !== 'tree') continue;
        kept.add(t);
        for (const e of parseTree(tob.data)) {
          if (e.mode === '40000') stack.push(e.oid);
          else kept.add(e.oid);
        }
      }
    }
    for (const oid of kept) included.add(oid);
  }
  const objects: GitObj[] = [];
  for (const oid of included) {
    if (held.has(oid)) continue;
    const o = r.objects.get(oid);
    if (o) objects.push(o);
  }
  return { objects, shallow, unshallow };
}

function sidebandPack(pack: Buffer): Buffer {
  const parts: Buffer[] = [];
  const CHUNK = 32768;
  for (let off = 0; off < pack.length; off += CHUNK) {
    const slice = pack.subarray(off, Math.min(pack.length, off + CHUNK));
    const payload = Buffer.concat([Buffer.from([1]), slice]);
    parts.push(pkt(payload));
  }
  return Buffer.concat(parts);
}

function emptyPack(): Buffer {
  return writePack([]);
}

function v2FetchResponse(r: Repo, args: FetchArgs): Buffer {
  const plan = planFetch(r, args, null);
  const pack = writePack(plan.objects);
  const parts: Buffer[] = [];
  parts.push(pkt('acknowledgments\n'));
  if (args.haves.length === 0) {
    parts.push(pkt('NAK\n'));
  } else {
    // Acknowledge the first have that is an ancestor of a want, else NAK.
    let ack: string | null = null;
    for (const h of args.haves) {
      if (args.wants.some((w) => isAncestor(h, w, (oid) => r.objects.get(oid)))) {
        ack = h;
        break;
      }
    }
    if (ack) {
      parts.push(pkt(`ACK ${ack}\n`));
      parts.push(pkt('ready\n'));
    } else {
      parts.push(pkt('NAK\n'));
    }
  }
  parts.push(PKT_DELIM);
  if (plan.shallow.length || plan.unshallow.length) {
    parts.push(pkt('shallow-info\n'));
    for (const s of plan.shallow) parts.push(pkt(`shallow ${s}\n`));
    for (const s of plan.unshallow) parts.push(pkt(`unshallow ${s}\n`));
    parts.push(PKT_DELIM);
  }
  parts.push(pkt('packfile\n'));
  parts.push(sidebandPack(pack));
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

function v0FetchResponse(r: Repo, args: FetchArgs): Buffer {
  const plan = planFetch(r, args, null);
  const pack = writePack(plan.objects);
  const parts: Buffer[] = [];
  if (args.haves.length === 0) {
    parts.push(pkt('NAK\n'));
  } else {
    let ack: string | null = null;
    for (const h of args.haves) {
      if (args.wants.some((w) => isAncestor(h, w, (oid) => r.objects.get(oid)))) {
        ack = h;
        break;
      }
    }
    parts.push(pkt(ack ? `ACK ${ack}\n` : 'NAK\n'));
  }
  for (const s of plan.shallow) parts.push(pkt(`shallow ${s}\n`));
  for (const s of plan.unshallow) parts.push(pkt(`unshallow ${s}\n`));
  parts.push(sidebandPack(pack));
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------- upload-pack POST

function parseV2Args(lines: string[]): { command: string; args: FetchArgs; prefixes: string[]; peel: boolean; symrefs: boolean } {
  const args: FetchArgs = { wants: [], haves: [], shallow: [], depth: null };
  const prefixes: string[] = [];
  let command = '';
  let peel = false;
  let symrefs = false;
  for (const raw of lines) {
    const line = raw.replace(/\n$/, '');
    if (line.startsWith('command=')) command = line.slice(8);
    else if (line.startsWith('want ')) args.wants.push(line.slice(5).trim());
    else if (line.startsWith('have ')) args.haves.push(line.slice(5).trim());
    else if (line.startsWith('shallow ')) args.shallow.push(line.slice(8).trim());
    else if (line.startsWith('deepen ')) args.depth = parseInt(line.slice(7), 10);
    else if (line.startsWith('ref-prefix ')) prefixes.push(line.slice(11));
    else if (line === 'peel') peel = true;
    else if (line === 'symrefs') symrefs = true;
  }
  return { command, args, prefixes, peel, symrefs };
}

export function uploadPack(r: Repo, body: Buffer, wantV2: boolean): GitReply {
  const { packets, trailing } = decodePackets(body);
  if (trailing.length > 0 || packets.length === 0) {
    return { status: 400, contentType: 'application/json; charset=utf-8', body: Buffer.from(JSON.stringify({ message: 'bad pkt-line' }), 'utf8') };
  }
  const CT = 'application/x-git-upload-pack-result';
  if (wantV2) {
    const lines = packets.filter((p) => p.kind === 'data').map((p) => (p as { payload: Buffer }).payload.toString('utf8'));
    const parsed = parseV2Args(lines);
    if (parsed.command === 'ls-refs') {
      return { status: 200, contentType: CT, body: lsRefs(r, parsed.prefixes, parsed.peel, parsed.symrefs) };
    }
    if (parsed.command === 'fetch') {
      return { status: 200, contentType: CT, body: v2FetchResponse(r, parsed.args) };
    }
    return { status: 400, contentType: 'application/json; charset=utf-8', body: Buffer.from(JSON.stringify({ message: 'unknown command' }), 'utf8') };
  }
  // v0: wants (+shallow/deepen) | flush | haves + done | flush
  const args: FetchArgs = { wants: [], haves: [], shallow: [], depth: null };
  for (const p of packets) {
    if (p.kind !== 'data') continue;
    const line = p.payload.toString('utf8').replace(/\n$/, '');
    if (line.startsWith('want ')) args.wants.push(line.slice(5).split(' ')[0] as string);
    else if (line.startsWith('have ')) args.haves.push(line.slice(5).trim());
    else if (line.startsWith('shallow ')) args.shallow.push(line.slice(8).trim());
    else if (line.startsWith('deepen ')) args.depth = parseInt(line.slice(7), 10);
  }
  if (args.wants.length === 0) {
    return { status: 400, contentType: 'application/json; charset=utf-8', body: Buffer.from(JSON.stringify({ message: 'no want' }), 'utf8') };
  }
  return { status: 200, contentType: CT, body: v0FetchResponse(r, args) };
}

// ---------------------------------------------------------------- receive-pack POST

interface PushCmd {
  oldOid: string;
  newOid: string;
  ref: string;
}

export function receivePack(r: Repo, body: Buffer): GitReply {
  const CT = 'application/x-git-receive-pack-result';
  const { packets, trailing } = decodePackets(body);
  const cmds: PushCmd[] = [];
  for (const p of packets) {
    if (p.kind !== 'data') continue;
    let line = p.payload.toString('utf8').replace(/\n$/, '');
    const nul = line.indexOf('\0');
    if (nul >= 0) line = line.slice(0, nul);
    const parts = line.split(' ');
    if (parts.length >= 3 && isOid(parts[0] as string) && isOid(parts[1] as string)) {
      cmds.push({ oldOid: parts[0] as string, newOid: parts[1] as string, ref: parts.slice(2).join(' ') });
    }
  }
  if (cmds.length === 0) {
    return { status: 400, contentType: 'application/json; charset=utf-8', body: Buffer.from(JSON.stringify({ message: 'no commands' }), 'utf8') };
  }
  let unpackOk = true;
  let unpackDetail = 'ok';
  const hasPack = trailing.length > 0;
  if (hasPack) {
    try {
      if (!packTrailerOk(trailing)) throw new Error('pack checksum mismatch');
      const objs = readPack(trailing);
      for (const [oid, o] of objs) {
        const computed = hashObj(o.type, o.data);
        if (computed !== oid) throw new Error(`pack object ${oid} does not hash`);
        if (!r.objects.has(oid)) r.objects.set(oid, o);
      }
    } catch (err) {
      unpackOk = false;
      unpackDetail = err instanceof Error ? err.message : 'unpack error';
    }
  }
  // Validate the new tips' closures when the pack unpacked: the tip must
  // be a commit/tag and its tree must be complete. (A full reachable()
  // walk here would make every push cost O(history).)
  if (unpackOk) {
    for (const c of cmds) {
      if (c.newOid === ZERO_OID) continue;
      const tip = r.objects.get(c.newOid);
      if (!tip || (tip.type !== 'commit' && tip.type !== 'tag')) {
        unpackOk = false;
        unpackDetail = `new tip ${c.newOid} is not a commit or tag`;
        break;
      }
      if (tip.type === 'commit') {
        const tree = parseCommit(tip.data).tree;
        if (!treeComplete(r, tree)) {
          unpackOk = false;
          unpackDetail = `missing tree ${tree}`;
          break;
        }
      } else {
        const target = parseTag(tip.data).object;
        if (!r.objects.has(target)) {
          unpackOk = false;
          unpackDetail = `missing tag target ${target}`;
          break;
        }
      }
    }
  }
  const results: { ref: string; ok: boolean; reason: string }[] = [];
  if (!unpackOk) {
    for (const c of cmds) results.push({ ref: c.ref, ok: false, reason: 'unpack error' });
  } else {
    const verdicts: { cmd: PushCmd; ok: boolean; reason: string }[] = [];
    for (const c of cmds) {
      const cur = r.refs.get(c.ref);
      if (c.newOid === ZERO_OID) {
        if (cur === undefined) verdicts.push({ cmd: c, ok: false, reason: 'no such ref' });
        else if (c.oldOid !== ZERO_OID && c.oldOid !== cur) verdicts.push({ cmd: c, ok: false, reason: 'old value does not match' });
        else verdicts.push({ cmd: c, ok: true, reason: '' });
      } else if (c.oldOid === ZERO_OID) {
        if (cur !== undefined) verdicts.push({ cmd: c, ok: false, reason: 'already exists' });
        else verdicts.push({ cmd: c, ok: true, reason: '' });
      } else {
        if (cur === undefined) verdicts.push({ cmd: c, ok: false, reason: 'no such ref' });
        else if (c.oldOid !== cur) verdicts.push({ cmd: c, ok: false, reason: 'old value does not match' });
        else if (!isAncestor(cur, c.newOid, (oid) => r.objects.get(oid))) verdicts.push({ cmd: c, ok: false, reason: 'non-fast-forward' });
        else verdicts.push({ cmd: c, ok: true, reason: '' });
      }
    }
    for (const v of verdicts) {
      if (!v.ok) {
        results.push({ ref: v.cmd.ref, ok: false, reason: v.reason });
        continue;
      }
      if (v.cmd.newOid === ZERO_OID) r.refs.delete(v.cmd.ref);
      else r.refs.set(v.cmd.ref, v.cmd.newOid);
      results.push({ ref: v.cmd.ref, ok: true, reason: '' });
    }
  }
  const inner: (string | 'flush')[] = [`unpack ${unpackDetail}\n`];
  for (const res of results) inner.push(res.ok ? `ok ${res.ref}\n` : `ng ${res.ref} ${res.reason}\n`);
  inner.push('flush');
  const report = pktSeq(inner);
  // Wrap the report in sideband band 1.
  const parts: Buffer[] = [];
  const CHUNK = 32768;
  for (let off = 0; off < report.length; off += CHUNK) {
    parts.push(pkt(Buffer.concat([Buffer.from([1]), report.subarray(off, Math.min(report.length, off + CHUNK))])));
  }
  parts.push(PKT_FLUSH);
  return { status: 200, contentType: CT, body: Buffer.concat(parts) };
}
