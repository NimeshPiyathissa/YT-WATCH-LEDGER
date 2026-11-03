# Third-party notices

Watch Ledger is MIT-licensed (see [LICENSE](LICENSE)). It includes or depends on the following third-party material.

## Bundled assets

| Asset | Where | Licence |
|---|---|---|
| **Bricolage Grotesque** (variable font, latin subset) | `server/web/vendor/fonts/`, `lib/` theme | SIL Open Font License 1.1 |
| **Geist** (variable font, latin subset) | same | SIL Open Font License 1.1 |
| **Lucide** icon paths | `server/web/vendor/icons.js`, `lib/` | ISC |

The fonts are redistributed unmodified apart from subsetting; the OFL permits this. Their licence texts are included next to the font files (`OFL-*.txt`).

## npm runtime dependencies (server)

`fastify`, `@fastify/cookie`, `@fastify/cors`, `@fastify/rate-limit`, `@fastify/static`, `@fastify/websocket`, `better-sqlite3`, `argon2`, and their transitive dependencies. They are installed from npm (`server/package-lock.json` pins the exact versions) and keep their own licences, mostly MIT, BSD-2/3-Clause, ISC and Apache-2.0. Run `npm ls --omit=dev` in `server/` for the list, and see each package's `LICENSE` file in `node_modules/`.

The Chrome extension itself has no third-party runtime code.

## Trademarks

YouTube and Chrome are trademarks of Google LLC. Watch Ledger is an independent project and is not affiliated with or endorsed by Google, YouTube, or Let's Encrypt.
