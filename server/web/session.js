/* session.js: one shared token refresh (window.WLSession). The server rotates the refresh cookie on every use and treats a second use
   of the same cookie as theft, revoking every session. Several requests that fail with 401 at the same moment must therefore wait for
   ONE refresh instead of each sending their own. */
(function (root) {
  "use strict";
  // send() performs the refresh request and resolves true on success. Callers get true/false; a thrown error counts as false.
  function createRefresher(send) {
    let inflight = null;
    return function refresh() {
      if (!inflight) inflight = Promise.resolve().then(send).then(ok => ok === true, () => false).then(ok => { inflight = null; return ok; });
      return inflight;
    };
  }
  const api = { createRefresher };
  root.WLSession = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof window !== "undefined" ? window : typeof self !== "undefined" ? self : this);
