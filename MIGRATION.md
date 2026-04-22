# Migration notes

## 1.2.0 — tool-harness refactor (coordinator internals)

This release restructures the coordinator internals behind the same
CLI contract. External behavior is byte-identical for `py-direct`,
`ts-direct`, `cs-direct`, `java-direct`, `vue-direct` — steady-state
response shape + state-dir layout unchanged.

### What moved

- `bin/lsp-stdio-proxy.js` body replaced with a composition of:
  - `bin/tool-harness.js` — shared primitives (resolveWorkspace,
    stateDir, serveHttp, invalidationLoop, callLog, framing).
  - `bin/tool-server-proxy.js` — external-process coordinator.
  - `bin/adapters/lsp-stdio.js` — LSP-specific adapter (extracted
    verbatim from the old monolithic proxy).
- `bin/vue-direct-coordinator.js` body similarly replaced; logic moved
  to `bin/adapters/vue-hybrid.js` on the same harness.

### Compatibility

Both entrypoint files still exist and expose the same CLI
(`--workspace <path> --port <N>` for both; `--lang-id <id> -- <cmd>
[<args>...]` for lsp-stdio-proxy). External callers that
`require('./lsp-stdio-proxy.js')` as a Node module or spawn either
coordinator directly see no breaking change.

Wrappers (`py-direct`, etc.) go through the new composition by
default — no env toggle, no fallback path. The previous
`LSP_PROXY_IMPL=v1|v2` env var (transitional, shipped in a preview
commit) has been removed.

### New observable behavior

Features added during the refactor (documented in `docs/architecture.md`):

- **Auto-reload on config changes.** Each LSP adapter declares soft
  triggers (`tsconfig.json`, `*.csproj`, `pom.xml`, etc.); touching
  one no longer requires `stop && start`. `workspace/didChangeConfiguration`
  + `workspace/didChangeWatchedFiles` fire automatically on next call.
- **Hard-restart triggers.** Touching `.env`, `.env.local`, or
  ecosystem-specific files (`.python-version`, `.java-version`,
  `global.json`, `pnpm-lock.yaml`, …) forces a coordinator restart
  on next call — necessary because JVM/runtime env is frozen at
  spawn.
- **Per-call structured log.** Each `call` appends a JSON line to
  `<stateDir>/calls.log`: `{ts, method, ms, adopted,
  invalidation_fired, outcome}`. Disable via
  `TOOL_DIRECT_CALLLOG=0`.
- **Invalidation mtime baseline.** `<stateDir>/triggers.json` stores
  the last-seen mtime of every trigger file.

### New wrappers in this release

Opt-in additions (not auto-used):

- `sbt-direct` — per-call sbt coordinator. See
  `docs/per-language/sbt.md` (note sandbox limitation).
- `dotnet-direct` — per-call dotnet coordinator. MSBuild
  build-server handles warm persistence automatically. See
  `docs/per-language/dotnet.md`.
- `prettier-direct` — in-process prettier daemon (sibling
  `node-formatter-daemon.js` module). See
  `docs/per-language/node-formatters.md`.
- `eslint-direct` — in-process eslint daemon.
- `scalafmt-direct` — per-call scalafmt coordinator.

### Nothing to do

Existing users should notice no CLI or state-dir change. Run your
usual `py-direct call ...` (or ts/cs/java/vue) workflows; the
refactor is invisible except for the new auto-reload + calls.log
features, which activate automatically.

### Rolling back

Git tags land at each step: `pre-refactor`, `refactor-wave-1`,
`refactor-wave-2-step-{2,3,4,5}`, `refactor-wave-3-step-{6,7}`,
`refactor-wave-4`. Reset to any of these if you need the previous
state.
