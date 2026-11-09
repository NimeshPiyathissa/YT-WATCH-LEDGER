// Release versions for the Update Manager. Pure: no I/O.
//
//   parseVersion("v0.8.0-beta.1") -> { major: 0, minor: 8, patch: 0, pre: ["beta", 1], text: "0.8.0-beta.1" } or null.
//   Strict Semantic Versioning 2.0: numbers without leading zeros, at most 3 numeric parts, pre-release identifiers of [0-9A-Za-z-],
//   build metadata (+...) accepted and ignored. Anything else is not a version (a release tag from the network is never trusted as-is).
//   compareVersions follows SemVer precedence: 0.8.0-beta.2 < 0.8.0-beta.10 < 0.8.0-rc.1 < 0.8.0 < 0.8.1 < 0.10.0.
//   The same order as version_ge in scripts/lib/common.sh, which update.sh uses (tested against the same cases).
const RE = /^v?(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})(?:-((?:0|[1-9]\d{0,8}|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d{0,8}|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

export function parseVersion(s) {
  if (typeof s !== "string" || s.length > 64) return null;
  const m = RE.exec(s); // no trimming: surrounding whitespace means it is not a clean version
  if (!m) return null;
  const pre = m[4] ? m[4].split(".").map(x => (/^\d+$/.test(x) ? Number(x) : x)) : [];
  const text = `${m[1]}.${m[2]}.${m[3]}${m[4] ? "-" + m[4] : ""}`;
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]), pre, text };
}

// <0, 0 or >0. Unparsable versions throw: callers parse first.
export function compareVersions(a, b) {
  const x = typeof a === "string" ? parseVersion(a) : a, y = typeof b === "string" ? parseVersion(b) : b;
  if (!x || !y) throw new Error("not a version");
  for (const k of ["major", "minor", "patch"]) if (x[k] !== y[k]) return x[k] - y[k];
  if (!x.pre.length || !y.pre.length) return (x.pre.length ? -1 : 0) - (y.pre.length ? -1 : 0); // a release outranks its pre-releases
  for (let i = 0; i < Math.max(x.pre.length, y.pre.length); i++) {
    const p = x.pre[i], q = y.pre[i];
    if (p === undefined) return -1; if (q === undefined) return 1;           // fewer identifiers rank lower
    if (p === q) continue;
    const pn = typeof p === "number", qn = typeof q === "number";
    if (pn && qn) return p - q;
    if (pn !== qn) return pn ? -1 : 1;                                      // numbers rank below words
    return p < q ? -1 : 1;                                                  // ASCII order
  }
  return 0;
}

// The release channel of a version: stable, rc, beta, alpha, or prerelease (any other pre-release label).
export function channelOf(v) {
  const p = typeof v === "string" ? parseVersion(v) : v;
  if (!p) return "unknown";
  if (!p.pre.length) return "stable";
  const tag = String(p.pre[0]).toLowerCase();
  return tag === "rc" ? "rc" : tag === "beta" ? "beta" : tag === "alpha" ? "alpha" : "prerelease";
}
export const CHANNEL_LABEL = { stable: "Stable", rc: "Release candidate", beta: "Beta", alpha: "Alpha", prerelease: "Pre-release", unknown: "Unknown" };

// The "release line" a pre-release belongs to: the major version, or for 0.x the minor too (0.x minor versions may break things).
const lineOf = p => (p.major === 0 ? `0.${p.minor}` : String(p.major));

// What to offer from a list of published releases ({ version, prerelease, ... }, already validated), given the installed version.
//   * Never a downgrade, never the installed version: only strictly newer releases.
//   * A stable installation is offered stable releases only.
//   * A pre-release installation is offered stable releases, and newer pre-releases of its own release line only when the owner has
//     switched "include pre-releases" on.
// Returns { latestStable, latestPrerelease, recommended } (each a release or null).
export function selectUpdates(installed, releases, { includePrereleases = false } = {}) {
  const cur = parseVersion(installed);
  if (!cur) return { latestStable: null, latestPrerelease: null, recommended: null };
  const newer = releases.filter(r => { const p = parseVersion(r.version); return p && compareVersions(p, cur) > 0; });
  const best = list => list.reduce((a, r) => (!a || compareVersions(r.version, a.version) > 0 ? r : a), null);
  const latestStable = best(newer.filter(r => !r.prerelease && !parseVersion(r.version).pre.length));
  const preAllowed = includePrereleases && cur.pre.length > 0;
  const latestPrerelease = preAllowed ? best(newer.filter(r => { const p = parseVersion(r.version); return (r.prerelease || p.pre.length > 0) && lineOf(p) === lineOf(cur); })) : null;
  return { latestStable, latestPrerelease, recommended: best([latestStable, latestPrerelease].filter(Boolean)) };
}
