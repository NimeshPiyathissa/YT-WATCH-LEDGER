// A temporary directory that is removed when the test process exits (BUG_FIX_REPORT A26: the suites used to leave every one behind;
// 1,743 of them, 2.7 GB, had piled up in the system temp folder). Removal is best effort: a file Windows still holds open is skipped.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const made = new Set();
process.on("exit", () => {
  for (const d of made) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* still in use: the OS temp cleaner gets it */ } }
});
export function tmpDir(prefix) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  made.add(d);
  return d;
}
