// Drives a real Chrome with the built extension loaded, over the DevTools pipe. Dependency free.
//
// Why a pipe: since Chrome 137 the branded browser ignores --load-extension, but it still honours the DevTools command
// Extensions.loadUnpacked when it was started with --remote-debugging-pipe --enable-unsafe-extension-debugging. The browser
// runs in a brand-new temporary profile (never your own) that is deleted afterwards; nothing is installed anywhere.
//
// The extension is copied to a temporary folder first and ONE line of its manifest is changed there: the local test server
// (http://127.0.0.1) is added to host_permissions. A real install asks the person for that permission with a prompt that a script
// cannot answer; everything else in the manifest, and every file, is what was built.
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export function findChrome() {
  return [process.env.CHROME, "C:/Program Files/Google/Chrome/Application/chrome.exe", "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe", "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable", "/usr/bin/chromium", "/usr/bin/chromium-browser", "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"].find(p => p && fs.existsSync(p)) || null;
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

export async function launch({ extensionDir, extraHostPermissions = ["http://127.0.0.1/*"], headless = true, chromeArgs = [] }) {
  const chrome = findChrome();
  if (!chrome) throw new Error("no Chrome found");
  const ext = fs.mkdtempSync(path.join(os.tmpdir(), "wl-ext-")), profile = fs.mkdtempSync(path.join(os.tmpdir(), "wl-prof-"));
  if (extensionDir) { // without one this is just a clean temporary browser (the dashboard interaction test uses it that way)
    fs.cpSync(extensionDir, ext, { recursive: true });
    const mf = JSON.parse(fs.readFileSync(path.join(ext, "manifest.json"), "utf8"));
    mf.host_permissions = [...new Set([...(mf.host_permissions || []), ...extraHostPermissions])];
    fs.writeFileSync(path.join(ext, "manifest.json"), JSON.stringify(mf, null, 2));
  }

  const proc = spawn(chrome, [...(headless ? ["--headless=new"] : []), "--remote-debugging-pipe", "--enable-unsafe-extension-debugging", `--user-data-dir=${profile}`,
    "--no-first-run", "--no-default-browser-check", ...chromeArgs, "--mute-audio", "--autoplay-policy=no-user-gesture-required", "--window-size=1280,800", "about:blank"], { stdio: ["ignore", "ignore", "ignore", "pipe", "pipe"] });
  const [toChrome, fromChrome] = [proc.stdio[3], proc.stdio[4]];
  let buf = "", id = 0; const pending = new Map(), listeners = [];
  fromChrome.on("data", d => {
    buf += d.toString("utf8"); let i;
    while ((i = buf.indexOf("\0")) >= 0) {
      const msg = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1);
      if (msg.id && pending.has(msg.id)) { const { res, rej } = pending.get(msg.id); pending.delete(msg.id); msg.error ? rej(new Error(msg.error.message)) : res(msg.result); }
      else for (const l of listeners) l(msg);
    }
  });
  const send = (method, params = {}, sessionId) => new Promise((res, rej) => { const i = ++id; pending.set(i, { res, rej }); toChrome.write(JSON.stringify({ id: i, method, params, ...(sessionId ? { sessionId } : {}) }) + "\0"); });

  const extensionId = extensionDir ? (await send("Extensions.loadUnpacked", { path: ext })).id : null;
  const targets = async () => (await send("Target.getTargets")).targetInfos;
  const sessions = new Map();
  async function attach(targetId) {
    if (!sessions.has(targetId)) sessions.set(targetId, (await send("Target.attachToTarget", { targetId, flatten: true })).sessionId);
    return sessions.get(targetId);
  }
  // evaluate JavaScript inside a target (a page, or the extension's service worker); promises are awaited
  async function evalIn(targetId, expression, { userGesture = false } = {}) {
    const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true, userGesture }, await attach(targetId));
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    return r.result.value;
  }
  async function waitFor(fn, { timeout = 15000, step = 300 } = {}) {
    const end = Date.now() + timeout; let last;
    while (Date.now() < end) { try { last = await fn(); if (last) return last; } catch { /* not yet */ } await sleep(step); }
    return last || null;
  }
  async function serviceWorker() {
    const t = await waitFor(async () => (await targets()).find(x => x.type === "service_worker" && x.url.startsWith(`chrome-extension://${extensionId}/`)), { timeout: 15000 });
    if (t) return t.targetId;
    // an idle worker may have stopped: opening an extension page wakes it
    await openTab(`chrome-extension://${extensionId}/popup/popup.html`);
    const t2 = await waitFor(async () => (await targets()).find(x => x.type === "service_worker" && x.url.startsWith(`chrome-extension://${extensionId}/`)), { timeout: 15000 });
    return t2 ? t2.targetId : null;
  }
  async function openTab(url) { return (await send("Target.createTarget", { url })).targetId; }
  async function closeTab(targetId) { try { await send("Target.closeTarget", { targetId }); } catch { /* gone */ } sessions.delete(targetId); }
  async function screenshot(targetId, file) { const r = await send("Page.captureScreenshot", { format: "png" }, await attach(targetId)); fs.writeFileSync(file, Buffer.from(r.data, "base64")); }
  async function close() {
    try { await send("Browser.close"); } catch { /* closing */ }
    setTimeout(() => { try { proc.kill(); } catch { /* done */ } for (const d of [profile, ext]) { try { fs.rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 400 }); } catch { /* Chrome still releasing files; it is a temp folder */ } } }, 2500).unref();
  }
  return { extensionId, send, targets, attach, evalIn, waitFor, serviceWorker, openTab, closeTab, screenshot, close, onEvent: fn => listeners.push(fn), sleep };
}
