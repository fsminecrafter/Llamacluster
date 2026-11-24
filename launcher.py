#!/usr/bin/env python3
"""One command to run LlamaCluster. Called by start.sh (Linux/macOS) and start.ps1 (Windows).

    start.sh                  controller + new web UI
    start.sh --worker         controller + a worker on this computer, registered automatically
    start.sh --classic        keep the old single-file UI (ui.html) at /
    start.sh --rebuild        rebuild the new web UI first

Anything this script doesn't know (--port, --token, --local-only, --workspace, --no-exec, ...) goes to controller.py.
Worker options: --worker-port, --worker-name, --worker-host, --worker-token, --models-dir, --llama-server.
"""
import argparse
import json
import os
import shutil
import signal
import subprocess
import sys
import time
import urllib.error
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
WEB = os.path.join(HERE, "llamacluster-web")
DIST = os.path.join(WEB, "dist")


def say(msg):
    print("[start] " + msg, flush=True)


# ------------------------------------------------------------------ web build
def newest(path, skip=("node_modules", "dist")):
    t = 0.0
    for root, dirs, files in os.walk(path):
        dirs[:] = [d for d in dirs if d not in skip]
        for f in files:
            try:
                t = max(t, os.path.getmtime(os.path.join(root, f)))
            except OSError:
                pass
    return t


def web_is_stale():
    index = os.path.join(DIST, "index.html")
    if not os.path.isfile(index):
        return True
    return newest(WEB) > os.path.getmtime(index)


def build_web(force):
    """Build llamacluster-web/dist if it is missing or older than the sources. Returns True if a build exists afterwards."""
    if not os.path.isdir(WEB):
        return False
    if not force and not web_is_stale():
        return True
    npm = shutil.which("npm")
    if not npm:
        say("Node.js/npm not found - can't build the new UI. Install Node 18+ (https://nodejs.org) and run again.")
        return os.path.isfile(os.path.join(DIST, "index.html"))
    try:
        if not os.path.isdir(os.path.join(WEB, "node_modules")):
            say("installing web UI dependencies (first run only)...")
            subprocess.run([npm, "install", "--no-audit", "--no-fund"], cwd=WEB, check=True)
        say("building the web UI...")
        subprocess.run([npm, "run", "build"], cwd=WEB, check=True)
    except (subprocess.CalledProcessError, OSError) as e:
        say("web UI build failed (%s)" % e)
        return os.path.isfile(os.path.join(DIST, "index.html"))   # an older build still works
    return True


# --------------------------------------------------------------------- http
def http(method, url, token="", body=None, timeout=5):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(url, data=data, method=method)
    if data is not None:
        req.add_header("Content-Type", "application/json")
    if token:
        req.add_header("Authorization", "Bearer " + token)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            raw = r.read()
            return r.status, (json.loads(raw) if raw else None)
    except urllib.error.HTTPError as e:
        try:
            return e.code, json.loads(e.read() or b"null")
        except ValueError:
            return e.code, None


def wait_for(url, token, seconds, alive):
    """Poll until `url` answers (any status below 500 counts), the deadline passes or a child exits."""
    end = time.time() + seconds
    while time.time() < end and alive():
        try:
            code, _ = http("GET", url, token, timeout=2)
            if code < 500:
                return code
        except (OSError, ValueError):
            pass
        time.sleep(0.4)
    return None


def register_worker(ctrl_url, ctrl_token, worker_url, worker_token, name):
    code, nodes = http("GET", ctrl_url + "/api/nodes", ctrl_token)
    if code == 401:
        say("the controller wants a token to register the worker - add it in the UI (Add node): %s" % worker_url)
        return
    if code == 200 and any((n.get("url") or "").rstrip("/") == worker_url for n in (nodes or [])):
        say("worker already registered")
        return
    code, d = http("POST", ctrl_url + "/api/nodes", ctrl_token,
                   {"url": worker_url, "token": worker_token, "name": name, "kind": "lan"}, timeout=15)
    if code == 200:
        say("worker registered as '%s'" % (d or {}).get("name", name))
    else:
        say("could not register the worker automatically (%s) - add %s in the UI (Add node)" % ((d or {}).get("error", code), worker_url))


# --------------------------------------------------------------------- main
def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--worker", action="store_true", help="also run a worker on this computer and register it")
    ap.add_argument("--classic", action="store_true", help="serve the old UI (ui.html) instead of the new one")
    ap.add_argument("--rebuild", action="store_true", help="rebuild the new web UI even if it looks up to date")
    ap.add_argument("--no-build", action="store_true", help="never build the web UI")
    ap.add_argument("--worker-port", type=int, default=7860)
    ap.add_argument("--worker-host", default="127.0.0.1", help="default 127.0.0.1: only this computer talks to the worker")
    ap.add_argument("--worker-name", default="")
    ap.add_argument("--worker-token", default=os.environ.get("LLAMACLUSTER_TOKEN", ""))
    ap.add_argument("--models-dir", default="")
    ap.add_argument("--llama-server", default="")
    a, ctrl_extra = ap.parse_known_args()

    # what the controller will listen on / which token it uses (only needed to register the worker)
    port, token = 7870, os.environ.get("LLAMACLUSTER_CTRL_TOKEN", "")
    for i, x in enumerate(ctrl_extra):
        if x == "--port" and i + 1 < len(ctrl_extra):
            port = int(ctrl_extra[i + 1])
        elif x.startswith("--port="):
            port = int(x.split("=", 1)[1])
        elif x == "--token" and i + 1 < len(ctrl_extra):
            token = ctrl_extra[i + 1]
        elif x.startswith("--token="):
            token = x.split("=", 1)[1]

    if not a.classic and not a.no_build:
        build_web(a.rebuild)

    env = dict(os.environ, PYTHONUNBUFFERED="1")
    procs = []

    def alive():
        return all(p.poll() is None for p in procs)

    def stop_all():
        for p in procs:
            if p.poll() is None:
                p.terminate()
        end = time.time() + 8
        for p in procs:
            try:
                p.wait(max(0.1, end - time.time()))
            except subprocess.TimeoutExpired:
                p.kill()

    def bye(*_):
        raise KeyboardInterrupt
    for sig in (signal.SIGINT, signal.SIGTERM):   # also when started in the background / by a service manager
        try:
            signal.signal(sig, bye)
        except (OSError, ValueError):
            pass

    ctrl_cmd = [sys.executable, os.path.join(HERE, "controller.py")] + ctrl_extra + (["--classic"] if a.classic else [])
    try:
        if a.worker:
            w_cmd = [sys.executable, os.path.join(HERE, "worker.py"), "--host", a.worker_host, "--port", str(a.worker_port)]
            for flag, val in (("--name", a.worker_name), ("--token", a.worker_token),
                              ("--models-dir", a.models_dir), ("--llama-server", a.llama_server)):
                if val:
                    w_cmd += [flag, val]
            say("starting worker on %s:%d" % (a.worker_host, a.worker_port))
            procs.append(subprocess.Popen(w_cmd, cwd=HERE, env=env))
        say("starting controller")
        procs.append(subprocess.Popen(ctrl_cmd, cwd=HERE, env=env))

        if a.worker:
            ctrl_url = "http://127.0.0.1:%d" % port
            w_host = "127.0.0.1" if a.worker_host in ("0.0.0.0", "::") else a.worker_host
            w_url = "http://%s:%d" % (w_host, a.worker_port)
            if wait_for(w_url + "/api/status", a.worker_token, 30, alive) and wait_for(ctrl_url + "/api/gateway", token, 30, alive):
                register_worker(ctrl_url, token, w_url, a.worker_token, a.worker_name or "This computer")
            elif alive():
                say("worker or controller didn't answer in time - add %s in the UI (Add node)" % w_url)

        while alive():
            time.sleep(0.5)
        for p in procs:
            if p.returncode:
                say("a process exited with code %s - stopping" % p.returncode)
                return p.returncode
        return 0
    except KeyboardInterrupt:
        say("stopping...")
        return 0
    finally:
        stop_all()


if __name__ == "__main__":
    sys.exit(main())
