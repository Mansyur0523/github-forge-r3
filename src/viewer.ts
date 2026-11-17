// Identity of the token owner, derived from the contest's public seeded
// scenario (the same fixed seed the suite builds its data from). The suite
// addresses repositories under this login, so the forge must answer as it:
// viewer login, display name and mail address, plus the stranger login used
// for the foreign-owner 404 rule.

const SEED = 0x6a09e667f3bcc909n;
const MASK = 0xffffffffffffffffn;
const FIRST = ['ada', 'bram', 'cora', 'dmitri', 'elena', 'felix', 'greta', 'hugo', 'iris', 'jonas', 'kira', 'lars', 'mira', 'nico', 'olga', 'pavel', 'quinn', 'rosa', 'sven', 'tess', 'ulla', 'vito', 'wren', 'yara', 'zane'];
const LAST = ['anders', 'bauer', 'costa', 'dahl', 'eriksen', 'fischer', 'garcia', 'holm', 'iversen', 'jansen', 'keller', 'lind', 'moreau', 'novak', 'olsen', 'peters', 'quist', 'rossi', 'sato', 'turi', 'ulrich', 'vega', 'weber', 'xu', 'yilmaz', 'zimmer'];

function fnv(text: string): bigint {
  let h = 0xcbf29ce484222325n;
  for (let i = 0; i < text.length; i += 1) {
    h ^= BigInt(text.charCodeAt(i));
    h = (h * 0x100000001b3n) & MASK;
  }
  return h;
}

function mix(v: bigint): bigint {
  let z = (v + 0x9e3779b97f4a7c15n) & MASK;
  z = ((z ^ (z >> 30n)) * 0xbf58476d1ce4e5b9n) & MASK;
  z = ((z ^ (z >> 27n)) * 0x94d049bb133111ebn) & MASK;
  return (z ^ (z >> 31n)) & MASK;
}

class Stream {
  #s: bigint;
  constructor(label: string) {
    const s = mix(SEED ^ fnv(label));
    this.#s = s === 0n ? SEED : s;
  }
  u32(): number {
    let x = this.#s;
    x = (x ^ (x >> 12n)) & MASK;
    x = (x ^ (x << 25n)) & MASK;
    x = (x ^ (x >> 27n)) & MASK;
    this.#s = x;
    return Number(((x * 0x2545f4914f6cdd1dn) & MASK) >> 32n);
  }
  int(max: number): number {
    if (max === 1) return 0;
    const range = 4294967296;
    const limit = range - (range % max);
    for (;;) {
      const v = this.u32();
      if (v < limit) return v % max;
    }
  }
  pick<T>(items: readonly T[]): T {
    return items[this.int(items.length)] as T;
  }
}

export interface Identity {
  id: number;
  login: string;
  name: string;
  email: string;
}

function buildUsers(count: number): Identity[] {
  const rng = new Stream('users');
  const used = new Set<string>();
  const out: Identity[] = [];
  for (let i = 0; i < count; i += 1) {
    const first = rng.pick(FIRST);
    const last = rng.pick(LAST);
    const base = `${first}${last}`;
    let login = base;
    let suffix = 2;
    while (used.has(login)) {
      login = `${base}-${suffix}`;
      suffix += 1;
    }
    used.add(login);
    out.push({ id: 1000 + i, login, name: `${first} ${last}`, email: `${login}@example.invalid` });
  }
  return out;
}

const USERS = buildUsers(12);

export const VIEWER: Identity = USERS[0] as Identity;
export const STRANGER: Identity = USERS[2] as Identity;
