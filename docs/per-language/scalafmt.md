# scalafmt — `scalafmt-direct`

Per-workspace scalafmt coordinator. One-shot mode — each `call` runs
`scalafmt` as a subprocess. Persistent-JVM adapter (scalafmt-dynamic
Scala API in a long-running JVM) is future work.

## Install prereq

```bash
brew install scalafmt           # or: cs install scalafmt
```

Either puts a `scalafmt` binary on `PATH`. The binary is a coursier-
launched JVM wrapper; cold start is 3-5s per call.

## Workspace markers (walk-up order)

1. `.scalafmt.conf`
2. `build.sbt`
3. `build.sc`
4. `build.mill`

## Invocation

```bash
scalafmt-direct call version      '{}'
scalafmt-direct call format-stdin '{"source":"object A{}","filepath":"A.scala"}'
scalafmt-direct call format-files '{"files":["src/main/scala/A.scala","src/main/scala/B.scala"]}'
scalafmt-direct call check-files  '{"files":["src/main/scala/A.scala"]}'
```

## Method surface

| method | params | wraps |
|---|---|---|
| version | `{}` | `scalafmt --version` |
| format-stdin | `{source, filepath?}` | `scalafmt --stdin [--stdin-filename <p>]` (stdout = formatted) |
| format-files | `{files: [abs-path...]}` | `scalafmt --non-interactive <files...>` (rewrites in place) |
| check-files | `{files: [abs-path...]}` | `scalafmt --test --non-interactive <files...>` (exit !=0 on diff) |

Results are `{exit, signal, stdout, stderr}` from the subprocess.

## Timing

- Every call: 3-5s cold (JVM boot + classloader + conf parse).
- Persistent-JVM adapter via scalafmt-dynamic would drop warm calls to
  <300ms; out of scope for v1.

## Invalidation matrix

| type | files | action |
|---|---|---|
| soft | `.scalafmt.conf` | no-op (scalafmt re-reads the conf on every invocation) |
| hard | `.env`, `.env.local` | coordinator restart |

## State directory

```
~/.cache/scalafmt-direct/<workspace-hash>/
├── pid           coordinator pid
├── port          loopback port
├── workspace     absolute workspace path
├── log           coordinator stderr
├── calls.log     per-call JSON lines
└── triggers.json mtime baseline
```

## Future work

- scalafmt-dynamic adapter: coursier-fetch scalafmt-dynamic_2.13, host
  its `Scalafmt` interface in a stay-open JVM, route calls via
  JSON-RPC over stdio. Warm calls <300ms; config hot-reload via the
  dynamic API's `resetConfig`.
