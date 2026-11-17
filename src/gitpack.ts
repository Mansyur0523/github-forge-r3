// Git object model, pkt-line codec and packfile read/write. Plain objects
// only on the wire out (no deltas): a delta-free pack is valid, checksums
// cleanly and is far cheaper to build than a delta search. Incoming packs
// may carry OFS/REF deltas, so those resolve here too.

import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';

export type ObjType = 'commit' | 'tree' | 'blob' | 'tag';
export interface GitObj {
  type: ObjType;
  data: Buffer;
}

export const ZERO_OID = '0'.repeat(40);
const TYPE_CODE: Record<ObjType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const CODE_TYPE: Record<number, ObjType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };
const HEX40 = /^[0-9a-f]{40}$/;

export function isOid(v: string): boolean {
  return HEX40.test(v);
}

export function hashObj(type: ObjType, data: Buffer): string {
  const h = createHash('sha1');
  h.update(`${type} ${data.length}\0`, 'utf8');
  h.update(data);
  return h.digest('hex');
}

export function storeObj(map: Map<string, GitObj>, type: ObjType, data: Buffer): string {
  const oid = hashObj(type, data);
  if (!map.has(oid)) map.set(oid, { type, data });
  return oid;
}

// ---------------------------------------------------------------- pkt-line

export function pkt(payload: string | Buffer): Buffer {
  const b = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const head = Buffer.allocUnsafe(4);
  head.write((b.length + 4).toString(16).padStart(4, '0'), 0, 4, 'ascii');
  return Buffer.concat([head, b]);
}

export const PKT_FLUSH = Buffer.from('0000', 'ascii');
export const PKT_DELIM = Buffer.from('0001', 'ascii');

export function pktSeq(items: readonly (string | Buffer | 'flush' | 'delim')[]): Buffer {
  const parts: Buffer[] = [];
  for (const it of items) {
    if (it === 'flush') parts.push(PKT_FLUSH);
    else if (it === 'delim') parts.push(PKT_DELIM);
    else parts.push(pkt(it));
  }
  return Buffer.concat(parts);
}

export type Packet = { kind: 'data'; payload: Buffer } | { kind: 'flush' } | { kind: 'delim' } | { kind: 'end' };

/** Decode a whole buffer of pkt-lines; trailing raw bytes are returned separately. */
export function decodePackets(buf: Buffer): { packets: Packet[]; trailing: Buffer } {
  const packets: Packet[] = [];
  let off = 0;
  while (off + 4 <= buf.length) {
    const head = buf.subarray(off, off + 4).toString('ascii');
    if (!/^[0-9a-fA-F]{4}$/.test(head)) break;
    const len = parseInt(head, 16);
    if (len === 0) {
      packets.push({ kind: 'flush' });
      off += 4;
      continue;
    }
    if (len === 1) {
      packets.push({ kind: 'delim' });
      off += 4;
      continue;
    }
    if (len === 2) {
      packets.push({ kind: 'end' });
      off += 4;
      continue;
    }
    if (len < 4 || off + len > buf.length) break;
    packets.push({ kind: 'data', payload: buf.subarray(off + 4, off + len) });
    off += len;
  }
  return { packets, trailing: buf.subarray(off) };
}

export function packetLines(packets: readonly Packet[]): string[] {
  const out: string[] = [];
  for (const p of packets) if (p.kind === 'data') out.push(p.payload.toString('utf8'));
  return out;
}

// ---------------------------------------------------------------- tree / commit

export interface TreeEntry {
  mode: string;
  name: string;
  oid: string;
}

export function parseTree(data: Buffer): TreeEntry[] {
  const out: TreeEntry[] = [];
  let off = 0;
  while (off < data.length) {
    const sp = data.indexOf(0x20, off);
    const nul = data.indexOf(0x00, sp + 1);
    out.push({
      mode: data.subarray(off, sp).toString('ascii'),
      name: data.subarray(sp + 1, nul).toString('utf8'),
      oid: data.subarray(nul + 1, nul + 21).toString('hex'),
    });
    off = nul + 21;
  }
  return out;
}

export function buildTree(entries: readonly TreeEntry[]): Buffer {
  const sorted = [...entries].sort((a, b) => {
    const x = Buffer.from(a.mode === '40000' ? `${a.name}/` : a.name, 'utf8');
    const y = Buffer.from(b.mode === '40000' ? `${b.name}/` : b.name, 'utf8');
    return Buffer.compare(x, y);
  });
  const parts: Buffer[] = [];
  for (const e of sorted) {
    parts.push(Buffer.from(`${e.mode} ${e.name}\0`, 'utf8'));
    parts.push(Buffer.from(e.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

export interface CommitView {
  tree: string;
  parents: string[];
  author: string;
  committer: string;
  message: string;
}

export function parseCommit(data: Buffer): CommitView {
  const blank = data.indexOf('\n\n');
  const head = blank < 0 ? data.toString('utf8') : data.subarray(0, blank).toString('utf8');
  const message = blank < 0 ? '' : data.subarray(blank + 2).toString('utf8');
  let tree = '';
  const parents: string[] = [];
  let author = '';
  let committer = '';
  for (const line of head.split('\n')) {
    const sp = line.indexOf(' ');
    const k = sp < 0 ? line : line.slice(0, sp);
    const v = sp < 0 ? '' : line.slice(sp + 1);
    if (k === 'tree') tree = v;
    else if (k === 'parent') parents.push(v);
    else if (k === 'author') author = v;
    else if (k === 'committer') committer = v;
  }
  return { tree, parents, author, committer, message };
}

export function parseTag(data: Buffer): { object: string; type: string; tag: string; tagger: string; message: string } {
  const blank = data.indexOf('\n\n');
  const head = blank < 0 ? data.toString('utf8') : data.subarray(0, blank).toString('utf8');
  const headers = new Map<string, string>();
  for (const line of head.split('\n')) {
    const sp = line.indexOf(' ');
    if (sp > 0) headers.set(line.slice(0, sp), line.slice(sp + 1));
  }
  return {
    object: headers.get('object') ?? '',
    type: headers.get('type') ?? '',
    tag: headers.get('tag') ?? '',
    tagger: headers.get('tagger') ?? '',
    message: blank < 0 ? '' : data.subarray(blank + 2).toString('utf8'),
  };
}

/** Reachable object ids from roots (commit -> tree+parents, tag -> target, tree -> entries). */
export function reachable(roots: Iterable<string>, lookup: (oid: string) => GitObj | undefined): Set<string> {
  const seen = new Set<string>();
  const stack: string[] = [];
  for (const r of roots) if (isOid(r)) stack.push(r);
  while (stack.length) {
    const oid = stack.pop() as string;
    if (seen.has(oid)) continue;
    const o = lookup(oid);
    if (!o) continue;
    seen.add(oid);
    if (o.type === 'commit') {
      const c = parseCommit(o.data);
      stack.push(c.tree);
      for (const p of c.parents) stack.push(p);
    } else if (o.type === 'tag') {
      stack.push(parseTag(o.data).object);
    } else if (o.type === 'tree') {
      for (const e of parseTree(o.data)) if (e.mode !== '160000') stack.push(e.oid);
    }
  }
  return seen;
}

/** True when `anc` is reachable from `tip` following commit parents. */
export function isAncestor(anc: string, tip: string, lookup: (oid: string) => GitObj | undefined): boolean {
  if (anc === tip) return true;
  const seen = new Set<string>();
  const stack = [tip];
  while (stack.length) {
    const oid = stack.pop() as string;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const o = lookup(oid);
    if (!o || o.type !== 'commit') continue;
    for (const p of parseCommit(o.data).parents) {
      if (p === anc) return true;
      stack.push(p);
    }
  }
  return false;
}

// ---------------------------------------------------------------- pack read

function readSizeVarint(buf: Buffer, start: number): { size: number; next: number; first: number } {
  let b = buf[start] as number;
  const first = b;
  let size = b & 0x0f;
  let shift = 4;
  let off = start + 1;
  while (b & 0x80) {
    b = buf[off++] as number;
    size += (b & 0x7f) * 2 ** shift;
    shift += 7;
  }
  return { size, next: off, first };
}

export function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let off = 0;
  const readSize = (): number => {
    let v = 0;
    let shift = 0;
    for (;;) {
      const b = delta[off++] as number;
      v += (b & 0x7f) * 2 ** shift;
      shift += 7;
      if (!(b & 0x80)) break;
    }
    return v;
  };
  const srcSize = readSize();
  const tgtSize = readSize();
  if (srcSize !== base.length) throw new Error('delta base size mismatch');
  const out = Buffer.allocUnsafe(tgtSize);
  let written = 0;
  while (off < delta.length) {
    const op = delta[off++] as number;
    if (op & 0x80) {
      let cpOff = 0;
      let cpSize = 0;
      let shift = 0;
      for (let bit = 0; bit < 4; bit += 1) {
        if (op & (1 << bit)) cpOff += (delta[off++] as number) * 2 ** shift;
        shift += 8;
      }
      shift = 0;
      for (let bit = 4; bit < 7; bit += 1) {
        if (op & (1 << bit)) cpSize += (delta[off++] as number) * 2 ** shift;
        shift += 8;
      }
      if (cpSize === 0) cpSize = 0x10000;
      base.copy(out, written, cpOff, cpOff + cpSize);
      written += cpSize;
    } else if (op !== 0) {
      const n = op & 0x7f;
      delta.copy(out, written, off, off + n);
      off += n;
      written += n;
    } else {
      throw new Error('delta opcode 0');
    }
  }
  if (written !== tgtSize) throw new Error('delta size mismatch');
  return out;
}

/** Parse a packfile into objects (plain + OFS/REF deltas resolved). Throws on corruption. */
export function readPack(pack: Buffer): Map<string, GitObj> {
  if (pack.length < 32 || pack.subarray(0, 4).toString('ascii') !== 'PACK') throw new Error('bad pack header');
  const version = pack.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error(`unsupported pack version ${version}`);
  const count = pack.readUInt32BE(8);
  const trailerAt = pack.length - 20;
  interface Raw {
    off: number;
    code: number;
    size: number;
    data: Buffer;
    baseOff?: number;
    baseOid?: string;
  }
  const raw: Raw[] = [];
  const byOff = new Map<number, Raw>();
  let off = 12;
  for (let i = 0; i < count; i += 1) {
    const entryOff = off;
    const h = readSizeVarint(pack, off);
    off = h.next;
    const code = (h.first >> 4) & 0x07;
    const e: Raw = { off: entryOff, code, size: h.size, data: Buffer.alloc(0) };
    if (code === 6) {
      let b = pack[off] as number;
      off += 1;
      let v = b & 0x7f;
      while (b & 0x80) {
        b = pack[off++] as number;
        v = ((v + 1) * 128) + (b & 0x7f);
      }
      e.baseOff = entryOff - v;
    } else if (code === 7) {
      e.baseOid = pack.subarray(off, off + 20).toString('hex');
      off += 20;
    } else if (!CODE_TYPE[code]) {
      throw new Error(`unknown pack type ${code}`);
    }
    const inflated = inflateSync(pack.subarray(off, trailerAt), { info: true }) as unknown as { buffer: Buffer; engine: { bytesWritten: number } };
    if (inflated.buffer.length !== h.size) throw new Error('pack entry size mismatch');
    e.data = inflated.buffer;
    off += inflated.engine.bytesWritten;
    raw.push(e);
    byOff.set(entryOff, e);
  }
  if (off !== trailerAt) throw new Error('pack trailing bytes');
  const objects = new Map<string, GitObj>();
  const byOid = new Map<string, Raw>();
  const resolving = new Set<number>();
  const resolve = (e: Raw): { type: ObjType; data: Buffer; oid: string } => {
    const cached = (e as Raw & { _r?: { type: ObjType; data: Buffer; oid: string } })._r;
    if (cached) return cached;
    if (resolving.has(e.off)) throw new Error('delta cycle');
    resolving.add(e.off);
    let type: ObjType;
    let data: Buffer;
    if (e.code === 6) {
      const base = byOff.get(e.baseOff as number);
      if (!base) throw new Error('ofs-delta base missing');
      const b = resolve(base);
      type = b.type;
      data = applyDelta(b.data, e.data);
    } else if (e.code === 7) {
      const base = byOid.get(e.baseOid as string);
      if (!base) throw new Error('ref-delta base missing');
      const b = resolve(base);
      type = b.type;
      data = applyDelta(b.data, e.data);
    } else {
      type = CODE_TYPE[e.code] as ObjType;
      data = e.data;
    }
    const oid = hashObj(type, data);
    const r = { type, data, oid };
    (e as Raw & { _r?: unknown })._r = r;
    byOid.set(oid, e);
    resolving.delete(e.off);
    return r;
  };
  for (const e of raw) {
    const r = resolve(e);
    if (!objects.has(r.oid)) objects.set(r.oid, { type: r.type, data: r.data });
  }
  return objects;
}

// ---------------------------------------------------------------- pack write

function packHeader(type: ObjType, size: number): Buffer {
  const code = TYPE_CODE[type];
  const bytes: number[] = [];
  let rem = size;
  let first = (code << 4) | (rem & 0x0f);
  rem = Math.floor(rem / 16);
  while (rem > 0) {
    bytes.push(first | 0x80);
    first = rem & 0x7f;
    rem = Math.floor(rem / 128);
  }
  bytes.push(first);
  return Buffer.from(bytes);
}

/** Build a delta-free pack (deflate level 1: fastest valid zlib for the hot path). */
export function writePack(objects: Iterable<GitObj>): Buffer {
  const list = [...objects];
  const parts: Buffer[] = [];
  const head = Buffer.allocUnsafe(12);
  head.write('PACK', 0, 4, 'ascii');
  head.writeUInt32BE(2, 4);
  head.writeUInt32BE(list.length, 8);
  parts.push(head);
  for (const o of list) {
    parts.push(packHeader(o.type, o.data.length));
    parts.push(deflateSync(o.data, { level: 1 }));
  }
  const body = Buffer.concat(parts);
  return Buffer.concat([body, createHash('sha1').update(body).digest()]);
}

export function packTrailerOk(pack: Buffer): boolean {
  if (pack.length < 20) return false;
  const actual = pack.subarray(pack.length - 20).toString('hex');
  const expected = createHash('sha1').update(pack.subarray(0, pack.length - 20)).digest('hex');
  return actual === expected;
}
