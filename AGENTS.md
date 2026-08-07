# AGENTS.md — contributor & agent guidelines

This repo follows the conventions of [`cjangrist/omnifetch`](https://github.com/cjangrist/omnifetch).
Read this before writing any code or making any commit.

## Golden rules

1. **Never commit secrets.** No tokens, cookies, JWTs, HARs, API keys, passwords, or MCP
   secrets — not in source, not in tests, not in fixtures, not in commit messages. This repo
   is **public**. `trash/`, `tmp/`, `temp/`, `.env`, `*.har` and `*secret*` are gitignored;
   do not defeat that with `git add -f`.
2. **Never `rm`.** Move throwaway files into a dated `trash/<YYYY-MM-DD>-<topic>/` directory
   (gitignored). This is a hard user rule.
3. **Never claim something works that you have not run.** Every claim in a commit body must
   have a command and its real output behind it.
4. **Redact account data.** Real conversation titles, emails and IDs may appear in your
   *report*, but never in committed code, fixtures, or docs.

## Commit style — gitmoji + Conventional Commits

Format: `<emoji> <type>(<scope>): <imperative summary>`

```
✨ feat(claude): add project membership tools
🐛 fix(gemini): match nested conversation anchors in sidebar
♻️  refactor(shared): extract cursor pagination helper
✅ test(qwen): cover thinking-level selection
📝 docs(spec): clarify deep-research clarification flow
```

Common types: `feat` `fix` `refactor` `test` `docs` `build` `ci` `perf` `chore`.
Scope is the provider name (`claude`, `zai`, …) or `shared` / `spec`.

**Commit small and often.** One logical change per commit. Do not batch a whole provider
into a single commit — a provider should land as a series of commits (API layer, then each
tool group, then tests, then docs).

### Commit body template

```
## Changes

- Bullet per meaningful change.

## Validation

- `npm run build` — clean
- `mcp-inspector --cli … --tool-name claude__list_conversations` — 1004 conversations,
  first 12 match the rendered sidebar positionally

## Checklist

- [x] `npm run check` passes (build + type-check + lint + format)
- [x] Every changed tool called live via MCP Inspector CLI
- [x] Pagination verified across a page boundary
- [x] No secrets, credentials, or tokens committed
```

End commit messages with:

```
Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
```

## Branch & PR workflow

- One provider per branch: `feat/<provider>-normalized-tools`.
- Open a PR per provider with the same `## Changes` / `## Validation` / `## Checklist` body.
- Never force-push `main`. Never commit directly to `main` for feature work.

## Code style

- TypeScript, ESM, `strict`. `npm run check` (build + `tsc` + `biome lint` + `biome format`)
  must pass before every commit.
- Prefer descriptive names over abbreviations. No inline comments explaining *what* — write
  a comment only to explain *why* something non-obvious is done (e.g. a site quirk).
- Every provider exposes the same tool names and shapes — see `SPEC.md`. Provider-specific
  behaviour goes behind the normalized surface, not into new tool names.
- Prefer the site's real JSON APIs over DOM scraping. Scrape only as a documented fallback.

## Testing bar (non-negotiable)

A tool is "done" only when it has been **called live through the MCP Inspector CLI** and its
output cross-checked against what the site actually renders.

- An empty array is **not** success. Count the rendered rows and compare positionally.
- HTTP 200 is **not** success. Streaming/Connect/SSE transports return errors as in-stream
  frames; parse them.
- Pagination must be proven **across a page boundary**, not just on page one.
- Write/destructive tools may only act on artifacts you created, prefixed `[opentabs-test]`,
  and must be cleaned up. Never touch pre-existing user content.

## Known failure modes (all of these shipped in real upstream plugins)

| Failure | Example |
|---|---|
| Auth check keyed on markup the site no longer emits | reddit — all 23 tools dead |
| Stale `urlPatterns` / API host after a domain move | notion — 100% dead |
| Response payload re-versioned; mappers return `""` at HTTP 200 | notion, linkedin, chatgpt, claude |
| Only the first content block read | chatgpt — 673 of 946 messages dropped |
| Write helper ignores an error payload inside a 200 | reddit, linkedin, supabase |
| Endpoint silently caps results and ignores `limit`/`offset` | perplexity — capped at 20 |
| A version header changes which A/B payload you get | kimi — `x-msh-version` |
