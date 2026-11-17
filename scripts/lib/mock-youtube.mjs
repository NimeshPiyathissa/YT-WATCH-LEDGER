// A stand-in for www.youtube.com for tests that need a REAL <video> in a REAL Chrome without depending on YouTube (which throttles or
// refuses automated browsers from time to time). It serves one watch page over HTTPS with a real, locally generated video; Chrome is
// pointed at it with --host-resolver-rules, so the page really is https://www.youtube.com/watch?v=... and the extension's content script
// runs on it exactly as it does on the real site. Needs `openssl` and `ffmpeg` on the PATH (the test skips when they are missing).
// It is NOT YouTube: ads, the single-page navigation and the player's own buffering are not reproduced.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import https from "node:https";
import os from "node:os";
import path from "node:path";

const have = cmd => spawnSync(cmd, ["-version"], { stdio: "ignore" }).status === 0 || spawnSync(cmd, ["version"], { stdio: "ignore" }).status === 0;
export const mockAvailable = () => have("openssl") && have("ffmpeg");

export async function startMockYouTube({ seconds = 240 } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wl-mockyt-"));
  const key = path.join(dir, "key.pem"), cert = path.join(dir, "cert.pem"), media = path.join(dir, "v.webm");
  let r = spawnSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", key, "-out", cert, "-days", "2", "-subj", "/CN=www.youtube.com", "-addext", "subjectAltName=DNS:www.youtube.com"], { encoding: "utf8" });
  if (r.status !== 0) throw new Error("openssl failed: " + r.stderr);
  r = spawnSync("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", "testsrc=size=320x180:rate=15", "-f", "lavfi", "-i", "sine=frequency=330", "-t", String(seconds), "-c:v", "libvpx", "-b:v", "80k", "-c:a", "libvorbis", media], { encoding: "utf8" });
  if (r.status !== 0) throw new Error("ffmpeg failed: " + r.stderr);
  const size = fs.statSync(media).size;
  const page = `<!doctype html><html><head><title>Mock watch page - YouTube</title></head><body>
<div class="html5-video-player"><video class="html5-main-video" src="/v.webm" preload="auto" playsinline></video></div>
<h1 class="title">Mock video</h1></body></html>`;
  const server = https.createServer({ key: fs.readFileSync(key), cert: fs.readFileSync(cert) }, (req, res) => {
    if (req.url.startsWith("/v.webm")) {
      const range = /bytes=(\d+)-(\d*)/.exec(req.headers.range || "");
      if (range) {
        const start = Number(range[1]), end = range[2] ? Math.min(Number(range[2]), size - 1) : size - 1;
        res.writeHead(206, { "Content-Type": "video/webm", "Accept-Ranges": "bytes", "Content-Range": `bytes ${start}-${end}/${size}`, "Content-Length": end - start + 1 });
        return fs.createReadStream(media, { start, end }).pipe(res);
      }
      res.writeHead(200, { "Content-Type": "video/webm", "Accept-Ranges": "bytes", "Content-Length": size });
      return fs.createReadStream(media).pipe(res);
    }
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }); res.end(page);
  });
  await new Promise(ok => server.listen(0, "127.0.0.1", ok));
  const port = server.address().port;
  return {
    port,
    // Chrome arguments that make https://www.youtube.com/ resolve to this server
    chromeArgs: [`--host-resolver-rules=MAP www.youtube.com 127.0.0.1:${port}`, "--ignore-certificate-errors"],
    watchUrl: id => `https://www.youtube.com/watch?v=${id}`,
    close: () => new Promise(ok => { server.closeAllConnections?.(); server.close(() => { fs.rmSync(dir, { recursive: true, force: true }); ok(); }); })
  };
}
