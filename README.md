# cms-insight

A local web dashboard that reads one or more [`wpsync`](https://github.com/jcabot/wordpress-file-sync)-managed content directories and runs analyses on them. Ships with two built-in plugins: a **broken-link finder** (with optional AI-assisted replacement suggestions) and a **missing-alt-text detector** for accessibility (WCAG 1.1.1).

## Requirements

- Node 20.10+
- pnpm 9+

## Quick start

```bash
pnpm install
pnpm -r build
node packages/server/dist/cli.js start --root /path/to/wpsync-parent
```

The server binds to `127.0.0.1:5174` and opens your browser at the **Home** page. Add `--no-open` to skip the auto-open.

`--root` points at a directory that contains one or more wpsync content folders as subfolders, e.g.:

```
~/sites/                 ← --root
  blog-en/               ← a wpsync content dir
    .wpsync/config.toml
    posts/
    pages/
  blog-fr/               ← another wpsync content dir
    .wpsync/config.toml
    posts/
    pages/
```

The first time you launch against a root, cms-insight creates `<root>/.cmsinsight/sites.json` (empty). Use the Home page to register subfolders as **sites**, set one **active**, and run analyses against it.

## Dev mode

```bash
# terminal 1 — server with hot reload
pnpm --filter @cms-insight/server dev -- start --root packages/server/test/fixtures

# terminal 2 — Vite dev server proxying /api -> 127.0.0.1:5174
pnpm --filter @cms-insight/web dev
```

Then open http://127.0.0.1:5173.

## Multi-site

Each cms-insight instance manages **N sites under one root**. The dashboard's Home page (`/`) lists registered sites; analyses always run against the **active** site only. Switching active sites is one click — either on a site card on Home or via the dropdown pill in the top-right of every page.

What lives where:

| Path | Purpose |
|------|---------|
| `<root>/.cmsinsight/sites.json` | Site registry: ordered list, active selection, cached `postCount`, last-run summary per plugin per site. |
| `<root>/.cmsinsight/.env` | Root-shared env (e.g., one `ANTHROPIC_API_KEY` for every site under this root). |
| `<root>/<site>/.cmsinsight/config.toml` | Per-site config (port, crawler concurrency, TTLs, plugin sections). Created on first activation. |
| `<root>/<site>/.cmsinsight/<plugin-id>/` | Per-site, per-plugin storage (sidecars, index files). |
| `<root>/<site>/.cmsinsight/.env` | Per-site env override (highest priority of the file slots). |
| `~/.cmsinsight/.env` | User-wide fallback. |
| `~/.cmsinsight/state.json` | Last `--root` and last active site, used as defaults when you launch without flags. |

Removing a site from the Home dashboard only removes its registry entry — its `<root>/<site>/.cmsinsight/` folder is preserved, so re-adding restores history.

## Plugins (v1 ships two)

### broken-links

Scans every post body for internal and external `<a>` tags, checks them with a polite (per-host rate-limited) HEAD/GET fan-out, and groups results into `OK` / `SUSPICIOUS` / `BROKEN`. Per-link checks are cached with verdict-specific TTLs (`ttl_ok_days`, `ttl_suspicious_days`, `ttl_broken_days` in `config.toml`); re-runs only re-check links that are due. Apply actions: **replace URL** or **remove `<a>` wrapper preserving inner text**, both via byte-level surgical edit with stale-hash protection.

The progress bar updates in near-real-time during link checks (per-link events flow through a producer/consumer queue, throttled to ~1 event per 1% on very large sites).

### missing-alt-text

Scans every post body for `<img>` tags whose `alt` attribute is missing (`D1`), whitespace-only (`D2`), or the empty string (`D3` — flagged by default; opt out per-site via `[plugins.missing-alt-text] flagEmptyAlt = false` in `config.toml`). This only covers images explicitly present in the stored post/page text; it does not inspect images added later by the rendering engine, such as galleries, featured images, theme templates, shortcodes, or blocks expanded at render time. Each finding shows the image as a clickable thumbnail (lazy-loaded directly from the source URL — cms-insight never proxies image bytes). Apply action: type an alt string, click **Add alt text**; the host inserts or replaces `alt="…"` byte-precisely, preserving every other attribute, and asserts the single-`alt` invariant before writing.

Re-runs are gated purely by body hash (no TTL — alt findings are a function of the body alone).

## LLM features (optional, broken-links only)

The broken-links analysis can call Claude to propose replacement URLs for dead links — useful when an external resource has moved (Wikipedia rename, domain change, etc.). It's **opt-in** and disabled by default; enable it by providing an API key.

The dashboard reads `ANTHROPIC_API_KEY` from any of these (highest priority first):

1. **Shell environment** — `export ANTHROPIC_API_KEY=sk-ant-...` then start the server.
2. **`<root>/<site>/.cmsinsight/.env`** — per-site override.
3. **`<root>/.cmsinsight/.env`** — root-shared (every site under this root sees it).
4. **`~/.cmsinsight/.env`** — user-wide fallback.

Format: `KEY=value`, one per line, with `#` comments. See [`.env.example`](./.env.example) for an annotated template. Existing `process.env` values are never overwritten — the shell always wins.

```bash
mkdir -p ~/.cmsinsight
cp .env.example ~/.cmsinsight/.env
# edit ~/.cmsinsight/.env and replace REPLACE_ME with your real key

node packages/server/dist/cli.js start --root /path/to/wpsync-parent
```

Once enabled, click **✨ Suggest replacements** on the broken-links page. Default: Claude Haiku, batches of 20 links per API call, 3 batches in flight. Cost ballpark: a site with ~100 broken links runs in 5 batches at roughly $0.01–$0.05.

Configurable per-site in `<root>/<site>/.cmsinsight/config.toml`:

```toml
[llm]
provider              = "anthropic"
model                 = "claude-haiku-4-5"
suggest_batch_size    = 20
suggest_concurrency   = 3
suggest_context_chars = 200
```

The Anthropic SDK is the only provider shipped in v1, but the architecture (`packages/server/src/llm/`) is provider-agnostic.

## Tests

```bash
pnpm -r test
```

Currently 74 tests covering the surgical-edit primitives, broken-links url + classifier + extract, missing-alt-text extract + apply, content frontmatter, hash-guarded apply, dotenv loader, and the multi-site registry.

## Layout

- `packages/plugin-api` — `@cms-insight/plugin-api`, the public plugin contract (types only).
- `packages/server` — Node 20 + Fastify host runtime + the built-in plugins.
  - `src/sites/` — multi-site registry service.
  - `src/plugins/_shared/` — parse5 helpers shared between plugins.
  - `src/plugins/broken-links/` — first built-in plugin.
  - `src/plugins/missing-alt-text/` — second built-in plugin.
  - `src/host/surgical-edit.ts` — byte-level HTML edit primitives (insert / splice / remove).
- `packages/web` — React 19 + Vite UI.

## Configuration

Per-site `<root>/<site>/.cmsinsight/config.toml` is created with defaults on first activation. Edit and **restart** to change ports, concurrency, TTLs, tracking-param strip lists, or per-plugin settings. Per-project classifier overrides for broken-links go in `<root>/<site>/.cmsinsight/rules.json` (same shape as `packages/server/src/plugins/broken-links/classifier/rules.json`).

## Adding a third plugin

The plugin contract (`@cms-insight/plugin-api` v1.0.0) accommodates more than the two shipped plugins without changes. To add one:

1. Create `packages/server/src/plugins/<your-id>/` with a `manifest.json`, `index.ts` exporting an `AnalysisPlugin`, and any plugin-specific `extract.ts` / `apply.ts` / `sidecar.ts`.
2. Reuse `packages/server/src/plugins/_shared/parse5-utils.ts` for HTML walking and attribute-span lookup.
3. Use `packages/server/src/host/surgical-edit.ts` (`spliceAttrValue`, `insertAttrInOpeningTag`, `spliceHrefValue`, `removeAnchorPreserveText`) for byte-precise rewrites.
4. Use `ApplyContext.writeFile(path, buf, expectedHash)` for stale-hash-guarded writes.
5. Add one `out.push(await registerPlugin(opts.contentDir, yourPlugin, { ... }))` block in `packages/server/src/plugins/registry.ts`.
6. Add a route at `/analyses/<your-resultsView>` in `packages/web/src/App.tsx`.

Third-party plugins (without modifying the server bundle) can drop into `<root>/<site>/.cmsinsight/plugins/<id>/` as compiled JS modules with a `plugin.json` manifest. See `packages/plugin-api/src/index.ts` for the contract.
