// Shared PARITY dial + STABLE per-book sampling for the engine-vs-cache runners
// (test/parity.ts for console, test/reports.ts for reports). Both read the same
// PARITY env var so one dial governs how many books each everyday run checks.
//
//   PARITY unset   -> default 50 (a small, fast sample)
//   PARITY=<n>     -> ~n books
//   PARITY=full    -> every book in the corpus (globbed, no hardcoded count)
//
// STABLE SAMPLING (owner-approved hard requirement): a book's membership in the
// sample depends ONLY on its own stable relative path plus the dial N -- never
// on its position, on the corpus size, or on which other books exist. So adding,
// removing, or regenerating books leaves the existing selection untouched;
// failures reproduce because the same books are picked every run.
//
// Mechanism: map each book's path to a fixed fraction f in [0,1) via a hash and
// select it iff f < N / SAMPLE_GRID. Both the hash resolution and SAMPLE_GRID are
// FIXED constants (NOT the live corpus size), so a book's fraction never moves
// when the corpus grows or shrinks -- membership is a pure function of its own
// filename and the dial N. On a corpus near SAMPLE_GRID this selects ~N books;
// N >= SAMPLE_GRID (or PARITY=full) selects everything.

export const DEFAULT_SAMPLE = 50;

// Fixed sampling reference: the committed corpus size when stable sampling was
// introduced. Its VALUE is not load-bearing (any fixed number works); what
// matters is that it is a CONSTANT, so a book's fraction never moves when the
// corpus grows or shrinks. Chosen ~= corpus size so the default dial (50) maps
// to ~50 books.
export const SAMPLE_GRID = 446;

// Fixed hash resolution: the number of distinct fraction buckets. Larger than
// any plausible corpus so the selected count lands close to the requested N.
const HASH_RESOLUTION = 1_000_000;

export interface Dial {
  full: boolean;
  n: number;
  label: string;
}

export function parseDial(raw: string | undefined = process.env.PARITY): Dial {
  const v = (raw ?? '').trim().toLowerCase();
  if (v === '') return { full: false, n: DEFAULT_SAMPLE, label: String(DEFAULT_SAMPLE) };
  if (v === 'full' || v === 'all') return { full: true, n: Infinity, label: 'full' };
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0 || !Number.isInteger(n)) {
    throw new Error(`invalid PARITY=${raw} -- use a non-negative integer or "full"`);
  }
  return { full: false, n, label: String(n) };
}

// 32-bit FNV-1a over the UTF-16 code units of the relative path. Deterministic
// and dependency-free; identical input -> identical bucket forever.
export function fnv1a(str: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    // h *= 16777619, kept in 32-bit unsigned range.
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  return h >>> 0;
}

// relPath MUST be the corpus-relative, forward-slash path (e.g.
// "epubcheck-expanded/foo.epub") so it is globally unique and stable across
// machines. Same key is used by both runners so the sampled SET is identical.
export function inSample(relPath: string, dial: Dial): boolean {
  if (dial.full || dial.n >= SAMPLE_GRID) return true;
  if (dial.n <= 0) return false;
  const fraction = (fnv1a(relPath) % HASH_RESOLUTION) / HASH_RESOLUTION;
  return fraction < dial.n / SAMPLE_GRID;
}
