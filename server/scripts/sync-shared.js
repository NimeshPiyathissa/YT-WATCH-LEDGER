// Keeps the browser/server copies of the shared pure modules identical to the extension's originals.
//   node scripts/sync-shared.js          copy
//   node scripts/sync-shared.js --check  exit 1 if any copy has drifted (also run by the test suite)
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const server = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ext = path.resolve(server, "..");

export const SHARED = [
  ["lib/util.js", "web/vendor/util.js"], ["lib/accounting.js", "web/vendor/accounting.js"],
  ["lib/stats.js", "web/vendor/stats.js"], ["lib/charts.js", "web/vendor/charts.js"],
  ["lib/theme.css", "web/vendor/theme.css"], ["lib/theme-init.js", "web/vendor/theme-init.js"],
  ["lib/accounting.js", "src/lib/accounting.cjs"]
];

export function drifted() {
  return SHARED.filter(([from, to]) => {
    const dest = path.join(server, to);
    return !fs.existsSync(dest) || !fs.readFileSync(path.join(ext, from)).equals(fs.readFileSync(dest));
  }).map(([, to]) => to);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.includes("--check")) {
    const d = drifted();
    if (d.length) { console.error("out of date: " + d.join(", ") + "\nrun: node scripts/sync-shared.js"); process.exit(1); }
    console.log("shared files are in sync");
  } else {
    for (const [from, to] of SHARED) {
      fs.mkdirSync(path.dirname(path.join(server, to)), { recursive: true });
      fs.copyFileSync(path.join(ext, from), path.join(server, to));
    }
    console.log("copied " + SHARED.length + " files");
  }
}
