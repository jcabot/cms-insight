# CLAUDE.md — guidance for Claude on this repo

Quick orientation for future sessions. Read once, then dive in.

## What this is

A local Fastify + React dashboard that reads `wpsync`-managed WordPress content directories and runs analyses against them. v1 ships **two plugins** (broken-links, missing-alt-text) and **multi-site** support (one server, N sites under one `--root`).

## Topology

```
packages/plugin-api/       Type-only contract (frozen at v1.0.0)
packages/server/           Fastify host + built-in plugins + sites registry
packages/web/              React 19 + Vite SPA
```

Build is monorepo-wide — always run from repo root: `pnpm -r build`. The server's CLI lives at `packages/server/dist/cli.js`.

## Core architectural facts

- **Plugin contract is frozen.** No new fields on `AnalysisPlugin` / `AnalysisContext` / `ApplyContext` / `ParsedPost` without a major bump. Adding a plugin is an additive operation: new folder under `packages/server/src/plugins/`, plus one `out.push(...)` in `plugins/registry.ts`.
- **Multi-site is server-side state.** `AppContext` exposes `root`, `activeSiteId`, and proxies `contentDir` / `siteUrl` / `config` / `runner` to the active site. Switching active sites calls `ctx.setActiveSite(id)` which cancels in-flight jobs and rebuilds the runner. Existing routes (`/api/overview`, `/api/analyses/...`) are NOT path-keyed by site — they just operate on whatever's active.
- **Site registry** lives at `<root>/.cmsinsight/sites.json` (created on first launch). Service: `packages/server/src/sites/registry.ts`. Routes: `packages/server/src/http/routes/sites.ts`.
- **Body-hash incremental gate.** Every plugin re-extracts a post only when `sidecar.body_hash !== p.bodyHash`. This is the v1 SLA — never re-parse unchanged posts.
- **Stale-hash apply guard.** `ApplyContext.writeFile(path, buf, expectedHash)` re-reads from disk and refuses if the body hash diverged from extraction. Plugins must compute hash off `parseFile(text).body` (the post-frontmatter body, not the whole file).
- **Surgical edits, not regex.** `packages/server/src/host/surgical-edit.ts` ships byte-precise primitives: `spliceHrefValue`, `spliceAttrValue`, `insertAttrInOpeningTag`, `removeAnchorPreserveText`, `encodeForAttr`. `encodeForAttr` escapes `&`, the matching quote, `<`, `>`, and newlines (defensively).
- **parse5 helpers are shared** in `packages/server/src/plugins/_shared/parse5-utils.ts`: `walk`, `getAttr`, `findAttrValueSpan`, `parseBody`. Always parse with `sourceCodeLocationInfo: true`.

## Conventions to follow

- **Per-post sidecars** at `<contentDir>/.cmsinsight/<plugin-id>/{posts,pages}/<slug>.json`. Plus `index.json` for the home dashboard.
- **`formatHeadline(storage)` on plugins** drives the home-page card row: `"23 broken / 612 checked"`, `"7 missing / 81 images"`. Keep it short.
- **Apply payloads are typed unions** (e.g. `{ kind: 'edit', edits: ApplyEdit[] }`) — never accept `unknown` and decode ad-hoc; use a guard like `isApplyPayload`.
- **Sort apply edits by `tag_start` descending** before splicing so earlier offsets stay valid.
- **Re-parse rewritten tags after surgical edit** to assert per-plugin invariants (e.g. single-`alt` for missing-alt-text).
- **Web routes match `resultsView`** on the plugin: a plugin with `resultsView: 'foo'` wires up at `/analyses/foo` in `packages/web/src/App.tsx`.

## LLM features

- Anthropic SDK only in v1. `packages/server/src/llm/factory.ts` is provider-agnostic; add new providers there.
- Env precedence (highest first): `process.env` → `<root>/<site>/.cmsinsight/.env` → `<root>/.cmsinsight/.env` → `~/.cmsinsight/.env`. Existing `process.env` is never overwritten — shell always wins.
- Plugins access the LLM via `ctx.llm` (optional). Auxiliary actions can declare `requiresLlm: true` to get host-side 503 short-circuiting when the key is missing.
- Default model is the latest Claude Haiku — see `packages/server/src/config/defaults.ts`. **Default to current Claude models when adding LLM features.** Latest as of writing: Opus 4.7, Sonnet 4.6, Haiku 4.5.

## Gotchas hit during v1 build

- **Empty-body POSTs** with `Content-Type: application/json` make Fastify throw `FST_ERR_CTP_EMPTY_JSON_BODY`. The `jsonFetch` wrapper in `packages/web/src/api/client.ts` only sets the header when `init.body` is present. Don't regress this.
- **The Fastify host's static-file fallback for the SPA** (in `packages/server/src/http/server.ts`) needs the web bundle built (`packages/web/dist/`). After any web change: `pnpm --filter @cms-insight/web build`. The fastify-static plugin reads from disk per request, so a hot-reload of the bundle is just a hard browser refresh — no server restart needed.
- **Progress streams hide silent work.** When a plugin does parallel work behind `Promise.all`, push events through a producer/consumer queue rather than yielding only at the end. See the broken-links Phase B implementation in `packages/server/src/plugins/broken-links/index.ts`.
- **PowerShell on Windows is the default shell here.** `&&` doesn't work; use `;` or `if ($?) { ... }`. Bash via the Bash tool is also available — both are fine.
- **Do NOT run a destructive `Stop-Process` over PIDs you didn't capture cleanly** — `Get-NetTCPConnection -State Listen` returns the OS Idle PID 0 in some states.

## Testing

- vitest, run with `pnpm --filter @cms-insight/server test` or `pnpm -r test`.
- **Apply tests use real temp dirs.** See `packages/server/src/host/apply.test.ts` for the `fs.mkdtemp` + `createApplyContext` pattern. Don't mock the filesystem.
- **Byte-perfect assertions** on rewritten files are the standard. `expect(after).toBe(expected)` with the full text, not snippet matching.
- `parse5` round-trip is the AC8-style validation: write the rewritten body, re-parse it, verify the user-supplied raw value comes back through `getAttr(el, 'alt')`.

## Open refactor opportunities (notes for future sessions)

After shipping plugin #2, the duplication between `broken-links/sidecar.ts` and `missing-alt-text/sidecar.ts` is significant. Worth extracting `packages/server/src/plugins/_shared/per-post-sidecar.ts<TFinding>` and `runPerPost(ctx, extractFn)` before adding plugin #3. Plugin auto-registration (manifest-driven, no hand-edited `out.push` in `registry.ts`) is a smaller, mechanical follow-up.

## What NOT to do

- Don't break the plugin API. Frozen.
- Don't re-introduce a single-site `--dir` flag. v2 is `--root` only, no migration path.
- Don't commit unless explicitly asked.
- Don't run `--no-verify` on git commits unless the user explicitly says so.
- Don't write code comments that just narrate what the code does. Reserve them for non-obvious *why*.
