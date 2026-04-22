#!/usr/bin/env python3
"""SessionStart hook — pre-warm every direct-wrapper state dir whose
server is no longer alive. Fires `<wrapper>-direct start <workspace>`
in the background for each dead slot so the first user `call` is warm.

Runs async + best-effort: failures are logged to the wrapper's own log
file and never block session start.

Detection: a wrapper is considered "cached" when
`~/.cache/<wrapper>-direct/<hash>/workspace` exists and names an
existing directory. Liveness probe via HTTP /health on the saved port.
"""
from __future__ import annotations

import json
import os
import subprocess
import sys
import urllib.request
from pathlib import Path

HOME = Path(os.environ.get("HOME", str(Path.home())))
CACHE_ROOT = HOME / ".cache"
BIN_ROOT = HOME / ".claude" / "bin"

# wrappers that support `<wrapper> start <workspace>` — skip read-only
# daemons / one-shot tools that would pay cold cost without warm benefit.
# metals-direct intentionally excluded: its adoption path reads
# <ws>/.metals/mcp.json written by the user's IDE, and SessionStart
# prewarm can race an IDE that just started — causing port conflicts
# or adoption of a stale server. Metals callers start it on-demand.
PREWARM_TARGETS = {
    "py-direct", "ts-direct", "cs-direct", "java-direct",
    "vue-direct",
    "prettier-direct", "eslint-direct",
}


def port_alive(port: str) -> bool:
    try:
        urllib.request.urlopen(f"http://127.0.0.1:{port}/health", timeout=1)
        return True
    except Exception:
        return False


def prewarm_slot(wrapper: str, slot: Path) -> None:
    workspace_file = slot / "workspace"
    port_file = slot / "port"
    if not workspace_file.exists():
        return
    workspace = workspace_file.read_text().strip()
    if not workspace or not Path(workspace).is_dir():
        return
    if port_file.exists():
        port = port_file.read_text().strip()
        if port and port_alive(port):
            return  # already warm
    wrapper_bin = BIN_ROOT / wrapper
    if not wrapper_bin.exists():
        return
    # fire-and-forget — the wrapper's own background spawn writes new
    # pid/port. stderr tee'd to slot/log so failures are visible.
    log = slot / "log"
    try:
        with open(log, "a") as lf:
            subprocess.Popen(
                [str(wrapper_bin), "start", workspace],
                stdout=subprocess.DEVNULL,
                stderr=lf,
                start_new_session=True,
            )
    except Exception as e:
        sys.stderr.write(f"[prewarm] {wrapper} {workspace}: {e}\n")


def main() -> None:
    if not CACHE_ROOT.is_dir():
        return
    count = 0
    for wrapper in PREWARM_TARGETS:
        wdir = CACHE_ROOT / wrapper
        if not wdir.is_dir():
            continue
        for slot in wdir.iterdir():
            if not slot.is_dir():
                continue
            prewarm_slot(wrapper, slot)
            count += 1
    # non-blocking stdout — hook runner captures but doesn't require content
    print(json.dumps({"prewarm_slots_visited": count}))


if __name__ == "__main__":
    main()
