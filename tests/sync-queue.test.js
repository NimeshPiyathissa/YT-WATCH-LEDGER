"use strict"; global.self = global;
require("../lib/sync.js"); const Q = global.YTSync;
let p=0,f=0; const eq=(n,g,w)=>{const ok=JSON.stringify(g)===JSON.stringify(w);ok?p++:f++;console.log((ok?"  ✓ ":"  ✗ ")+n+(ok?"":`  got=${JSON.stringify(g)} want=${JSON.stringify(w)}`));};
// --- outbox batching: pure selection logic (the IndexedDB side is covered end-to-end in server/test/device-client.test.js) ---
const rows=[{sessionId:"a",rev:1},{sessionId:"b",rev:2},{sessionId:"c",rev:1},{sessionId:"gone",rev:4}];
const byId={a:{sessionId:"a",rev:1},b:{sessionId:"b",rev:2},c:{sessionId:"c",rev:1}};
eq("batch keeps queue order", Q.buildBatch(rows,byId,10).send.map(x=>x.sessionId), ["a","b","c"]);
eq("queued rows whose session was deleted are dropped, with their rev", Q.buildBatch(rows,byId,10).gone, [{sessionId:"gone",rev:4}]);
eq("batch size limit respected", Q.buildBatch(rows,byId,2).send.map(x=>x.sessionId), ["a","b"]);
eq("event id is session + revision", Q.eventId({sessionId:"s1",rev:3}), "s1:3");
eq("event id differs per revision", Q.eventId({sessionId:"s1",rev:3})!==Q.eventId({sessionId:"s1",rev:4}), true);
eq("event id of an unversioned session", Q.eventId({sessionId:"s1"}), "s1:0");
const b0=Q.backoff(0), b5=Q.backoff(5), b20=Q.backoff(20); eq("backoff grows & capped", [b0<2000, b5<=60500, b20<=60500], [true,true,true]);

// --- how the device reacts to server answers ---
eq("expired access token -> refresh and retry", Q.classifyAuth(401,"token_invalid"), "refresh");
eq("unknown device -> removed", Q.classifyAuth(401,"bad_token"), "removed");
eq("bad credential -> removed", Q.classifyAuth(401,"bad_credential"), "removed");
eq("awaiting approval -> pending", Q.classifyAuth(403,"pending_approval"), "pending");
eq("revoked -> revoked", Q.classifyAuth(403,"revoked"), "revoked");
eq("server error is not an auth problem", Q.classifyAuth(500,"internal_error"), null);
eq("rate limit is not an auth problem", Q.classifyAuth(429,"rate_limited"), null);
eq("success is not an auth problem", Q.classifyAuth(200), null);

// --- pairing state and the notice the user always sees ---
eq("not paired -> no notice", Q.syncNoticeText({}), "");
eq("legacy token only -> not paired", Q.isEnrolled({sync_server:"https://x.test",device_token:"old"}), false);
eq("refresh credential -> paired", Q.isEnrolled({sync_server:"https://x.test",device_refresh:"r"}), true);
eq("pending notice says nothing is sent", /Nothing is sent until then/.test(Q.syncNoticeText({sync_server:"https://x.test",device_refresh:"r",sync_status:"pending"})), true);
eq("active notice names the server", Q.syncNoticeText({sync_server:"https://x.test",device_refresh:"r",sync_status:"active"}), "Syncing YouTube watch data to x.test.");

eq("https server accepted -> origin only", Q.normalizeServerUrl(" https://tracker.example.com/some/path?x=1 "), "https://tracker.example.com");
eq("http localhost allowed for dev", Q.normalizeServerUrl("http://localhost:8443"), "http://localhost:8443");
eq("http 127.0.0.1 allowed for dev", Q.normalizeServerUrl("http://127.0.0.1:8443/"), "http://127.0.0.1:8443");
eq("plain http to a real host refused", Q.normalizeServerUrl("http://tracker.example.com"), null);
eq("embedded credentials refused", Q.normalizeServerUrl("https://u:p@tracker.example.com"), null);
eq("garbage refused", Q.normalizeServerUrl("not a url"), null);
eq("non-http scheme refused", Q.normalizeServerUrl("ftp://tracker.example.com"), null);

eq("pause command ok", Q.validateCommand({type:"pause_tracking"}), {type:"pause_tracking",payload:{}});
eq("unknown command refused", Q.validateCommand({type:"format_disk"}), null);
eq("null command refused", Q.validateCommand(null), null);
eq("set_retention valid", Q.validateCommand({type:"set_retention",payload:{days:30}}).payload, {days:30});
eq("set_retention negative refused", Q.validateCommand({type:"set_retention",payload:{days:-1}}), null);
eq("set_retention fractional refused", Q.validateCommand({type:"set_retention",payload:{days:1.5}}), null);
eq("set_retention too large refused", Q.validateCommand({type:"set_retention",payload:{days:99999}}), null);
eq("delete_range valid", Q.validateCommand({type:"delete_range",payload:{from:1,to:2}}).payload, {from:1,to:2});
eq("delete_range reversed refused", Q.validateCommand({type:"delete_range",payload:{from:5,to:1}}), null);
eq("delete_range missing bounds refused", Q.validateCommand({type:"delete_range"}), null);


console.log(`\n${p} passed, ${f} failed`); process.exit(f?1:0);
