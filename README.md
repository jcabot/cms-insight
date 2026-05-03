# cms-insight

A local web dashboard that reads a [`wpsync`](https://github.com/jcabot/wordpress-file-sync)-managed content directory and runs analyses on it. v1 ships a site-overview view and a broken-link finder with assisted in-place fixes.

## Requirements

- Node 20.10+
- pnpm 9+

## Quick start

```bash
pnpm install
pnpm -r build
node packages/server/dist/cli.js start --dir /path/to/wpsync/content
```

The server binds to `127.0.0.1:5174` and opens your browser. Add `--no-open` to skip the auto-open.

## Dev mode

```bash
# terminal 1 — server with hot reload
pnpm --filter @cms-insight/server dev -- start --dir packages/server/test/fixtures/site

# terminal 2 — Vite dev server proxying /api -> 127.0.0.1:5174
pnpm --filter @cms-insight/web dev
```

Then open http://127.0.0.1:5173.

A small fixture site is bundled under `packages/server/test/fixtures/site/` for quick iteration.

## Tests

```bash
pnpm -r test
```

Currently covers (see `packages/server/src/**/*.test.ts`):

- **AC1, AC2, AC3** — surgical replace / remove preserves all bytes outside the targeted span.
- **AC4** — `ApplyContext.writeFile` refuses when the on-disk body hash differs from the recorded extraction-time hash.
- **AC7** — parking-platform fingerprint detection (Sedo, GoDaddy, generic parking).
- **AC8** — soft-404 detection in `<title>` and `<h1>`.

The remaining ACs (AC5/AC6 incremental, AC9 wpsync round-trip, AC10 politeness) are exercised manually via the dev server; integration test scaffolding can be added later.

## Layout

- `packages/plugin-api` — `@cms-insight/plugin-api`, the public plugin contract (types only).
- `packages/server` — Node 20 + Fastify host runtime + the built-in `broken-links` plugin.
- `packages/web` — React 19 + Vite UI.

## Configuration

On first run against a content directory, `cms-insight` creates `<dir>/.cmsinsight/config.toml` with defaults from PRD §8 and adds `.cmsinsight/` to the directory's `.gitignore`. Edit `config.toml` and restart to change ports, concurrency, TTLs, or tracking-param strip lists.

Per-project classifier overrides go in `<dir>/.cmsinsight/rules.json` (same shape as `packages/server/src/plugins/broken-links/classifier/rules.json`).

## LLM features (optional)

The broken-links analysis can call an LLM to propose replacement URLs for dead links — useful when an external resource has moved (Wikipedia rename, domain change, etc.). It's **opt-in** and disabled by default; enable it by providing an API key.

The dashboard reads `ANTHROPIC_API_KEY` from any of these (highest priority first):

1. **The shell environment** — `export ANTHROPIC_API_KEY=sk-ant-...` then start the server.
2. **`<contentDir>/.cmsinsight/.env`** — per-project. Already inside the `.cmsinsight/` folder that's auto-added to the content directory's `.gitignore`.
3. **`~/.cmsinsight/.env`** — user-wide default for all your projects. The `~/.cmsinsight/` folder is your home directory state, never in any repo.

The format is `KEY=value`, one per line, with `#` comments. See [`.env.example`](./.env.example) at the repo root for an annotated template. Restart the server after editing.

```bash
# create the file once, copying from the template
mkdir -p ~/.cmsinsight
cp .env.example ~/.cmsinsight/.env
# edit ~/.cmsinsight/.env and replace REPLACE_ME with your real key

# any project will now pick it up
node packages/server/dist/cli.js start --dir /path/to/wpsync/content
```

Once enabled, click **✨ Suggest replacements** on the broken-links page. The server batches broken links (default 20 per request) into a single LLM call, sends the original URL plus the surrounding paragraph from the post body, and gets back a structured response with confidence levels. Suggestions persist in the per-post sidecar; they appear inline under each broken row, and the action editor lets you **Confirm** (accept), **Clean** (dismiss), or override with your own URL.

Configurable in `<dir>/.cmsinsight/config.toml`:

```toml
[llm]
provider              = "anthropic"
model                 = "claude-haiku-4-5"
suggest_batch_size    = 20
suggest_concurrency   = 3
suggest_context_chars = 200
```

The Anthropic SDK is the only provider shipping in v1, but the architecture (`packages/server/src/llm/`) is provider-agnostic — adding OpenAI or another vendor is one new `LlmProvider` implementation plus a factory branch.

Cost ballpark: a site with ~100 broken links typically runs in 5 batches at roughly $0.01–$0.05 with Haiku. The server reports tokens used and an estimate in the SSE finish event.

## Plugins

The broken-links analysis is itself a plugin (built into the server bundle). Third-party plugins can be dropped in `<dir>/.cmsinsight/plugins/<id>/` as compiled JS modules with a `plugin.json` manifest. See `packages/plugin-api/src/index.ts` for the contract.
