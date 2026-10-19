/* lib/theme-init.js — applies the saved theme before first paint. self.YTTheme.
   Stored in localStorage (sync read) so pages don't flash the wrong theme. */
(function (root) {
  "use strict";
  const KEY = "yt_theme";
  function current() { try { return localStorage.getItem(KEY) || "auto"; } catch (_e) { return "auto"; } }
  function apply(t) {
    const dark = t === "dark" || (t === "auto" && root.matchMedia && root.matchMedia("(prefers-color-scheme: dark)").matches);
    document.documentElement.setAttribute("data-theme", dark ? "dark" : "light");
  }
  function set(t) { try { localStorage.setItem(KEY, t); } catch (_e) {} apply(t); }
  apply(current());
  root.YTTheme = { current, set };
})(window);
