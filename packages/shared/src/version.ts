/**
 * Compare dotted versions; a prerelease suffix (e.g. 1.0.0-beta) sorts below the
 * same release. Returns -1/0/1.
 */
export function compareVersions(a: string, b: string): number {
  const pa = tokenize(a);
  const pb = tokenize(b);
  const n = Math.max(pa.core.length, pb.core.length);
  for (let i = 0; i < n; i++) {
    const x = pa.core[i] ?? 0;
    const y = pb.core[i] ?? 0;
    if (x !== y) return x < y ? -1 : 1;
  }
  // Equal cores: a prerelease sorts lower; two prereleases compare lexically.
  if (pa.pre && pb.pre) return pa.pre < pb.pre ? -1 : pa.pre > pb.pre ? 1 : 0;
  if (pa.pre) return -1;
  if (pb.pre) return 1;
  return 0;
}

function tokenize(v: string): { core: number[]; pre: string } {
  const s = String(v ?? "").trim().replace(/^[vV]/, "");
  const dash = s.indexOf("-");
  const corePart = (dash >= 0 ? s.slice(0, dash) : s).split("+")[0];
  const pre = dash >= 0 ? s.slice(dash + 1).split("+")[0] : "";
  const core = corePart.split(".").map((x) => (/^\d+$/.test(x) ? parseInt(x, 10) : hashNonNumeric(x)));
  return { core, pre: pre.toLowerCase() };
}

function hashNonNumeric(x: string): number {
  // Non-numeric segments (e.g. "1a") degrade to numeric prefix + length offset for stable ordering.
  const m = /^(\d*)/.exec(x)?.[1] ?? "";
  return (m ? parseInt(m, 10) : 0) + x.length * 0.001;
}
