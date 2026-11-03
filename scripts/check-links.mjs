#!/usr/bin/env node
// Checks that every relative link and image in the tracked Markdown files points at a file that exists (and, for #anchors into
// Markdown files, at a heading that exists). External http(s) links are not fetched. Usage: node scripts/check-links.mjs
import { execFileSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";

const root = execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();
const files = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "*.md"], { cwd: root, encoding: "utf8" }).split("\n").filter(Boolean).filter(f => !f.includes("node_modules/") && !f.startsWith("docs/superpowers/"));
const slug = h => h.toLowerCase().replace(/<[^>]+>/g, "").replace(/[`*_~]/g, "").replace(/[^\w\- ]/g, "").trim().replace(/ /g, "-");
const anchors = f => new Set([...readFileSync(f, "utf8").replace(/```[\s\S]*?```/g, "").matchAll(/^#{1,6}\s+(.+?)\s*#*$/gm)].map(m => slug(m[1])));
let bad = 0, n = 0;
for (const f of files) {
  const text = readFileSync(path.join(root, f), "utf8").replace(/```[\s\S]*?```/g, "").replace(/`[^`\n]*`/g, "");
  const links = [...text.matchAll(/!?\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g)].map(m => m[1]).concat([...text.matchAll(/(?:src|href)="([^"]+)"/g)].map(m => m[1]));
  for (const l of links) {
    if (/^(https?:|mailto:|data:|#$)/.test(l)) continue;
    n++;
    const [rel, frag] = l.split("#");
    const target = rel ? path.resolve(root, path.dirname(f), decodeURIComponent(rel)) : path.join(root, f);
    if (!existsSync(target)) { console.log(`BROKEN  ${f}: ${l}`); bad++; continue; }
    if (frag && target.endsWith(".md") && !anchors(target).has(frag.toLowerCase())) { console.log(`ANCHOR  ${f}: ${l}`); bad++; }
  }
}
console.log(`${n} relative links checked in ${files.length} files, ${bad} problem(s)`);
process.exit(bad ? 1 : 0);
