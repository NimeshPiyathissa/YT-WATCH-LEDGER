// BUG_FIX_REPORT A21: the Security page asked for an icon ("shield") that the icon set does not have; an unknown name silently draws the
// "circle-alert" fallback, so the sidebar entry showed a warning symbol. Every icon name the dashboard and the extension ask for must exist.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const read = f => fs.readFileSync(path.join(ROOT, f), "utf8");
function iconSet(file) {
  const ctx = { self: {}, window: {} }; ctx.self = ctx.window = ctx; vm.runInNewContext(read(file), ctx);
  const fallback = ctx.YTIcons.icon("circle-alert");
  return { icon: name => name === "circle-alert" || ctx.YTIcons.icon(name) !== fallback }; // an unknown name draws the fallback
}

test("every icon the dashboard asks for exists in its icon set", () => {
  const set = iconSet("server/web/vendor/icons.js");
  const files = fs.readdirSync(path.join(ROOT, "server/web")).filter(f => f.endsWith(".js") || f.endsWith(".html")).map(f => "server/web/" + f);
  const missing = [];
  for (const f of files) {
    const src = read(f);
    for (const re of [/\bic\(\s*["']([a-z0-9-]+)["']/g, /data-icon=["']([a-z0-9-]+)["']/g, /\bempty\(\s*["']([a-z0-9-]+)["']/g, /WL\.empty\(\s*["']([a-z0-9-]+)["']/g])
      for (const m of src.matchAll(re)) if (!set.icon(m[1])) missing.push(`${f}: ${m[1]}`);
  }
  assert.deepEqual([...new Set(missing)], []);
});

test("every icon the extension asks for exists, and the two icon sets are the same file", () => {
  assert.equal(read("lib/icons.js"), read("server/web/vendor/icons.js"));
  const set = iconSet("lib/icons.js"), missing = [];
  for (const f of ["popup/popup.js", "popup/popup.html", "settings/settings.js", "settings/settings.html"]) {
    const src = read(f);
    for (const re of [/\bic\(\s*["']([a-z0-9-]+)["']/g, /IC\.icon\(\s*["']([a-z0-9-]+)["']/g, /data-icon=["']([a-z0-9-]+)["']/g])
      for (const m of src.matchAll(re)) if (!set.icon(m[1])) missing.push(`${f}: ${m[1]}`);
  }
  assert.deepEqual([...new Set(missing)], []);
});
