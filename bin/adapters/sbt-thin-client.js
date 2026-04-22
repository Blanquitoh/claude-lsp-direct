// adapters/sbt-thin-client — persistent-JVM sbt via the thin-client
// path. Coordinator spawns `sbt` in server mode once per workspace
// (detached, ~20-40s first boot, ~5-10s warm boot) and keeps it alive
// for the session. Each /call invokes `sbt --client "<cmd>"` which
// reuses that server over ipcsocket — ~200-500ms per call vs. 20-40s
// cold for the one-shot adapter.
//
// Adoption: if `<workspace>/target/active.json` exists and its socket
// is live (thin client can handshake in <1s), attach to that server
// instead of spawning a new one. This lets the user run `sbt shell`
// in a terminal and have sbt-direct share that session.
//
// Sandbox: sbt writes its ipcsocket to a tmpdir that the macOS
// sandbox denies by default. `scripts/install.sh` pre-allows the
// required paths (/private/var/folders/**/.sbt/**, ~/.sbt/**,
// ~/.ivy2/**, ~/.coursier/**) — after running install.sh this
// adapter works under Claude Bash without `dangerouslyDisableSandbox`.

'use strict';

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

function createAdapter({
  name = 'sbt-direct',
  markers = ['build.sbt', 'project/build.properties'],
  triggers = {
    soft: ['build.sbt', 'project/build.properties', 'project/plugins.sbt'],
    hard: ['.env', '.env.local', '.sbtopts', '.jvmopts'],
  },
  sbtCmd = 'sbt',
} = {}) {
  return {
    name,
    markers,
    triggers,

    spawn(workspace, stateDir) {
      return [{
        id: 'sbt-server',
        frame: 'jsonLine',
        cmd: sbtCmd,
        args: [
          '-Dsbt.server.forcestart=true',
          'shell',
        ],
        cwd: workspace,
        env: {
          ...process.env,
          // propagate $TMPDIR into java.io.tmpdir best-effort; install.sh
          // allowlist covers the fallback path.
          SBT_OPTS: `${process.env.SBT_OPTS || ''} -Djava.io.tmpdir=${process.env.TMPDIR || '/tmp'}`.trim(),
        },
      }];
    },

    async adopt(workspace) {
      const activeJson = path.join(workspace, 'target', 'active.json');
      if (!fs.existsSync(activeJson)) return null;
      try {
        const info = JSON.parse(fs.readFileSync(activeJson, 'utf8'));
        if (!info.uri) return null;
        // Two-stage adopt: (1) mtime age check — if active.json was
        // written <30min ago and the server hasn't crashed, trust it
        // without paying for a thin-client handshake. (2) fallback
        // live probe with 30s timeout (cold sbt clients can spend 10-20s
        // resolving dependencies before completing `about`).
        const ageMs = Date.now() - fs.statSync(activeJson).mtimeMs;
        if (ageMs < 30 * 60 * 1000) {
          return [{
            id: 'sbt-server',
            frame: 'jsonLine',
            cmd: process.execPath,
            args: ['-e', 'setInterval(() => {}, 1 << 30)'],
          }];
        }
        // older active.json — server may be stale; verify with a real call.
        const result = await runSbtClient(
          sbtCmd, workspace,
          ['about'],
          30000,
        );
        if (result.exit === 0) {
          return [{
            id: 'sbt-server',
            frame: 'jsonLine',
            cmd: process.execPath,
            args: ['-e', 'setInterval(() => {}, 1 << 30)'],
          }];
        }
      } catch { /* adoption probe failed — spawn fresh */ }
      return null;
    },

    async init(ctx) {
      // wait for target/active.json to appear — that's sbt's signal
      // that the server is ready to accept --client requests.
      const activeJson = path.join(ctx.workspace, 'target', 'active.json');
      const deadline = Date.now() + 90_000; // 90s — first boot on a cold
                                             // checkout can be long.
      while (Date.now() < deadline) {
        if (fs.existsSync(activeJson)) {
          ctx.log(`sbt server ready (active.json detected)`);
          return;
        }
        await new Promise(r => setTimeout(r, 500));
      }
      throw new Error(`sbt server did not create ${activeJson} within 90s — check ${ctx.stateDir}/log`);
    },

    onChildMessage() {
      // sbt server stdout is the interactive prompt; we don't parse it.
      // All interaction happens via the thin-client subprocess per call.
    },

    async call({ method, params }, ctx) {
      const p = params || {};
      switch (method) {
        case 'version':
          return runSbtClient(sbtCmd, ctx.workspace, ['about'], 30_000);
        case 'reload':
          return runSbtClient(sbtCmd, ctx.workspace, ['reload'], 60_000);
        case 'task': {
          const task = p.task;
          const project = p.project;
          if (!task || typeof task !== 'string') {
            throw new Error('sbt call "task" requires params.task (string)');
          }
          const cmd = project ? `${project}/${task}` : task;
          return runSbtClient(sbtCmd, ctx.workspace, [cmd], p.timeoutMs || 600_000);
        }
        case 'shutdown':
          return runSbtClient(sbtCmd, ctx.workspace, ['shutdown'], 15_000);
        default:
          throw new Error(`unknown sbt method: ${method} — supported: version, reload, task, shutdown`);
      }
    },

    async reload(ctx) {
      ctx.log('sbt thin-client soft-reload via sbt --client reload');
      try { await runSbtClient(sbtCmd, ctx.workspace, ['reload'], 60_000); }
      catch (e) { ctx.log('reload failed — exiting for restart:', e.message); process.exit(2); }
    },
  };
}

function runSbtClient(sbtCmd, workspace, sbtArgs, timeoutMs) {
  return new Promise((resolve, reject) => {
    const child = spawn(sbtCmd, ['--client', ...sbtArgs], {
      cwd: workspace,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        SBT_OPTS: `${process.env.SBT_OPTS || ''} -Djava.io.tmpdir=${process.env.TMPDIR || '/tmp'}`.trim(),
      },
    });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    child.stdout.on('data', d => { stdout += d.toString('utf8'); });
    child.stderr.on('data', d => { stderr += d.toString('utf8'); });
    child.on('error', reject);
    const timer = setTimeout(() => {
      timedOut = true;
      try { child.kill('SIGTERM'); } catch {}
    }, timeoutMs);
    child.on('exit', (code, sig) => {
      clearTimeout(timer);
      resolve({
        exit: code,
        signal: sig,
        stdout,
        stderr,
        timedOut,
      });
    });
  });
}

module.exports = { createAdapter };
