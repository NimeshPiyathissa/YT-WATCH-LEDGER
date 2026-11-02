/* lib/build-config.js — values baked in by tools/build-extension.mjs (self.YTBuildConfig).
   In the source tree it is empty: the server address is entered in the extension. A release build replaces this file
   with the server it was built for, so the person installing it only needs the pairing code. */
(function (root) {
  "use strict";
  root.YTBuildConfig = { server: "", builtAt: null };
})(typeof self !== "undefined" ? self : this);
