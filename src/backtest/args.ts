/** Tiny `--key value` / `--flag` argv parser (no deps). */
export function parseArgs(argv: string[]): Map<string, string> {
  const out = new Map<string, string>();
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] as string;
    if (!a.startsWith("--")) continue;
    const eq = a.indexOf("=");
    if (eq > 0) {
      out.set(a.slice(2, eq), a.slice(eq + 1));
      continue;
    }
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith("--")) {
      out.set(a.slice(2), next);
      i += 1;
    } else {
      out.set(a.slice(2), "true");
    }
  }
  return out;
}

export function num(args: Map<string, string>, key: string, dflt: number): number {
  const v = args.get(key);
  if (v === undefined) return dflt;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error(`--${key} must be a number, got ${v}`);
  return n;
}

export function dateMs(v: string | undefined): number | undefined {
  if (!v) return undefined;
  const t = Date.parse(v.length === 10 ? `${v}T00:00:00Z` : v);
  if (!Number.isFinite(t)) throw new Error(`bad date ${v}`);
  return t;
}

export function resolveSymbols(
  args: Map<string, string>,
  pool: Record<string, number>,
): Record<string, number> {
  const list = args.get("symbols");
  const rrOverride = args.get("rr");
  const base: Record<string, number> = {};
  const names = list ? list.split(",").map((s) => s.trim().toUpperCase()).filter(Boolean) : Object.keys(pool);
  for (const s of names) {
    const rr = rrOverride ? Number(rrOverride) : pool[s];
    if (rr === undefined || !Number.isFinite(rr)) {
      throw new Error(`${s} is not in the pool; pass --rr <n> to set RR for custom symbols`);
    }
    base[s] = rr;
  }
  return base;
}
