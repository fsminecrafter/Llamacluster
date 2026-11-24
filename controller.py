#!/usr/bin/env python3
"""LlamaCluster controller.

* Serves the web UI (new React build in llamacluster-web/dist; old ui.html with --classic)
* Keeps a list of worker nodes (LAN, Modal, Colab, anything reachable by URL)
* Polls them, forwards management actions (start/stop/settings/install models)
* Exposes ONE OpenAI-compatible endpoint (/v1/*) that load-balances across all
  ready nodes, with failover.
* Can launch a *distributed* model (llama.cpp RPC) across LAN nodes.

* Runs chat tools (web search, page fetch, sandboxed workspace files, shell commands) - see tools.py,
  with manual / semi / uncontrolled approval levels

Pure standard library. Python 3.8+.
"""
import argparse
import base64
import concurrent.futures
import codecs
import http.client
import ipaddress
import json
import math
import mimetypes
import os
import re
import secrets
import socket
import tempfile
import threading
import time
import urllib.parse
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import term
import tools

HERE = os.path.dirname(os.path.abspath(__file__))
STATE_FILE = os.path.expanduser("~/.config/llamacluster/nodes.json")
WEB_DIST = os.path.join(HERE, "llamacluster-web", "dist")   # built React UI (npm run build); served at / unless --classic
CLASSIC = False                                              # --classic: keep serving the old single-file ui.html at /
_WEB_TYPES = {".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".mjs": "text/javascript; charset=utf-8",
              ".css": "text/css; charset=utf-8", ".json": "application/json", ".svg": "image/svg+xml", ".map": "application/json",
              ".woff2": "font/woff2", ".woff": "font/woff", ".png": "image/png", ".jpg": "image/jpeg", ".ico": "image/x-icon",
              ".webp": "image/webp", ".txt": "text/plain; charset=utf-8"}


def new_ui_available():
    return not CLASSIC and os.path.isfile(os.path.join(WEB_DIST, "index.html"))
POLL_S = 3.0

lock = threading.Lock()
nodes = {}     # id -> {id,name,url,token,kind}
status = {}    # id -> {"ok":bool,"error":str,"data":{...},"seen":ts}
inflight = {}  # id -> int (requests routed by this gateway)
last_used = {}  # id -> ts of last routed request
CTRL_TOKEN = ""
TOKEN_AUTO = False      # True when the token was generated for us (then the computer itself may skip typing it)
PORT = 7870
CHAT_RUN_TTL = 1800
CHAT_RUN_LIMIT = 48
CHAT_RUN_MAX_BYTES = 16 * 1024 * 1024
chat_runs = {}
chat_run_keys = {}
chat_runs_lock = threading.Lock()
scheduled_tasks = {}
scheduled_tasks_lock = threading.Lock()


class ChatRun:
    def __init__(self, run_id, request_id):
        self.id = run_id
        self.request_id = request_id
        self.created = time.time()
        self.updated = self.created
        self.node = ""
        self.lines = []
        self.byte_count = 0
        self.done = False
        self.error = None
        self.cancelled = False
        self.connection = None
        self.condition = threading.Condition()

    def append(self, line):
        raw_size = len(line.encode("utf8"))
        with self.condition:
            if self.byte_count + raw_size > CHAT_RUN_MAX_BYTES:
                self.error = "chat stream exceeded the controller's 16 MiB replay buffer"
                self.done = True
                self.cancelled = True
                if self.connection:
                    self.connection.close()
                self.condition.notify_all()
                return False
            self.lines.append(line)
            self.byte_count += raw_size
            self.updated = time.time()
            self.condition.notify_all()
            return True

    def snapshot(self, after, wait=15):
        deadline = time.monotonic() + min(20, max(0, wait))
        with self.condition:
            while after >= len(self.lines) and not self.done:
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    break
                self.condition.wait(remaining)
            end = min(len(self.lines), after + 2048)
            return {"id": self.id, "node": self.node, "lines": self.lines[after:end],
                    "next": end, "done": self.done, "error": self.error,
                    "cancelled": self.cancelled}

    def cancel(self):
        with self.condition:
            self.cancelled = True
            self.done = True
            self.updated = time.time()
            if self.connection:
                self.connection.close()
            self.condition.notify_all()


def _chat_run_worker(run, body, candidates):
    last_error = "no candidate node"
    for node in candidates:
        if run.cancelled:
            break
        inflight[node["id"]] = inflight.get(node["id"], 0) + 1
        c = None
        try:
            if node.get("kind") == "browser":
                err = _chat_run_browser(run, node, body)
                if err:
                    last_error = err
                    continue
                break
            c, prefix = conn_for(node["url"], 600)
            with run.condition:
                run.connection = c
            hdrs = {"Content-Type": "application/json"}
            if node.get("token"):
                hdrs["Authorization"] = "Bearer " + node["token"]
            c.request("POST", prefix + "/v1/chat/completions",
                      body=json.dumps(body).encode("utf8"), headers=hdrs)
            response = c.getresponse()
            if response.status >= 500:
                last_error = f"{node['name']}: HTTP {response.status} " + response.read()[:300].decode("utf8", "replace")
                c.close()
                continue
            if response.status != 200:
                detail = response.read()[:2000].decode("utf8", "replace")
                try:
                    detail = json.loads(detail).get("error", {}).get("message", detail)
                except (ValueError, AttributeError):
                    pass
                run.error = f"{node['name']}: HTTP {response.status} {detail}"
                break
            run.node = node["name"]
            decoder = codecs.getincrementaldecoder("utf8")("replace")
            saw_done = False
            while not run.cancelled:
                raw = response.readline()
                if not raw:
                    break
                line = decoder.decode(raw)
                if line.startswith("data:") and line.strip() == "data: [DONE]":
                    saw_done = True
                if not run.append(line):
                    break
            if not run.cancelled and not run.error and not saw_done:
                run.error = f"{node['name']}: model stream ended before [DONE]"
            break
        except Exception as e:
            if not run.cancelled:
                last_error = f"{node['name']}: {type(e).__name__}: {e}"
        finally:
            if c:
                c.close()
            with run.condition:
                if run.connection is c:
                    run.connection = None
            inflight[node["id"]] = max(0, inflight.get(node["id"], 1) - 1)
    with run.condition:
        if not run.cancelled and run.error is None and not run.node:
            run.error = "all nodes failed: " + last_error
        run.done = True
        run.updated = time.time()
        run.condition.notify_all()


def create_chat_run(request_id, body, target=""):
    now = time.time()
    with chat_runs_lock:
        expired = [rid for rid, run in chat_runs.items() if run.done and now - run.updated > CHAT_RUN_TTL]
        for rid in expired:
            old = chat_runs.pop(rid)
            chat_run_keys.pop(old.request_id, None)
        existing_id = chat_run_keys.get(request_id)
        if existing_id and existing_id in chat_runs:
            return chat_runs[existing_id]
        active = sum(not run.done for run in chat_runs.values())
        if active >= CHAT_RUN_LIMIT:
            raise RuntimeError("too many active chat streams; try again shortly")
        try:
            hint = body.get("model")
        except AttributeError:
            raise ValueError("body must be a JSON object")
        if not isinstance(body, dict) or not body.get("stream"):
            raise ValueError("body must be a streaming chat completion request")
        if target:
            pool = [n for n in ready_nodes() if target in (n["id"], n["name"])]
        else:
            pool = ready_nodes(hint)
        candidates = pick_order(pool)[:3] if pool else []
        if not candidates:
            raise LookupError("no ready node" + (" named " + target if target else "") + " - start a model on at least one node")
        run = ChatRun(uuid.uuid4().hex, request_id)
        chat_runs[run.id] = run
        chat_run_keys[request_id] = run.id
        thread = threading.Thread(target=_chat_run_worker, args=(run, body, candidates), daemon=True,
                                  name="chat-stream-" + run.id[:8])
        thread.start()
        return run


def get_chat_run(run_id):
    with chat_runs_lock:
        return chat_runs.get(run_id)


def _scheduled_tasks_file():
    return os.path.abspath(STATE_FILE) + ".scheduled.json"


def _save_scheduled_tasks_locked():
    path = _scheduled_tasks_file()
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf8") as f:
        json.dump(list(scheduled_tasks.values()), f, indent=2)
    os.chmod(tmp, 0o600)
    os.replace(tmp, path)


def load_scheduled_tasks():
    try:
        with open(_scheduled_tasks_file(), encoding="utf8") as f:
            tasks = json.load(f)
        if not isinstance(tasks, list):
            raise ValueError("scheduled task state must be a list")
        with scheduled_tasks_lock:
            scheduled_tasks.clear()
            for task in tasks:
                if not isinstance(task, dict) or not task.get("id") or not task.get("prompt"):
                    continue
                try:
                    task["due_at"] = float(task["due_at"])
                except (KeyError, TypeError, ValueError):
                    continue
                if not math.isfinite(task["due_at"]):
                    continue
                if task.get("status") not in ("scheduled", "running", "completed", "failed", "cancelled"):
                    continue
                if task.get("status") == "running":
                    task["status"] = "scheduled"
                    task["run_id"] = ""
                scheduled_tasks[task["id"]] = task
            _save_scheduled_tasks_locked()
    except FileNotFoundError:
        pass
    except Exception as e:
        print("[controller] could not read scheduled tasks", e)


def create_scheduled_task(prompt, due_at, model="", target="", system_prompt=""):
    prompt = str(prompt or "").strip()
    try:
        due_at = float(due_at)
    except (TypeError, ValueError):
        raise ValueError("due_at must be a Unix timestamp")
    if not prompt or len(prompt) > 4000:
        raise ValueError("prompt is required and must be at most 4000 characters")
    if not (time.time() < due_at <= time.time() + 5 * 366 * 86400):
        raise ValueError("scheduled time must be in the future and within five years")
    task = {
        "id": uuid.uuid4().hex[:12], "prompt": prompt, "due_at": due_at,
        "model": str(model or "")[:300], "target": str(target or "")[:200],
        "system_prompt": str(system_prompt or "")[:12000],
        "status": "scheduled", "created_at": time.time(), "result": "", "error": "",
        "started_at": None, "completed_at": None, "run_id": "",
    }
    with scheduled_tasks_lock:
        if sum(t.get("status") in ("scheduled", "running") for t in scheduled_tasks.values()) >= 100:
            raise RuntimeError("at most 100 scheduled tasks may be active")
        scheduled_tasks[task["id"]] = task
        _save_scheduled_tasks_locked()
    return dict(task)


def list_scheduled_tasks():
    with scheduled_tasks_lock:
        return sorted((dict(task) for task in scheduled_tasks.values()),
                      key=lambda task: (task.get("due_at") or 0, task["id"]))


def cancel_scheduled_task(task_id):
    with scheduled_tasks_lock:
        task = scheduled_tasks.get(task_id)
        if not task:
            return False
        if task.get("status") in ("scheduled", "running"):
            task["status"] = "cancelled"
            task["completed_at"] = time.time()
            run_id = task.get("run_id")
            _save_scheduled_tasks_locked()
        else:
            run_id = ""
    if run_id:
        run = get_chat_run(run_id)
        if run:
            run.cancel()
    return True


def _scheduled_task_worker(task_id):
    with scheduled_tasks_lock:
        task = scheduled_tasks.get(task_id)
        if not task or task.get("status") != "running":
            return
        task = dict(task)
    body = {"stream": True, "model": task.get("model") or None, "messages": [
        {"role": "system", "content": (task.get("system_prompt") or
          "You are completing a scheduled task. Respond to the task directly. Chat tools are unavailable in scheduled runs.")},
        {"role": "user", "content": task["prompt"]},
    ]}
    try:
        run = create_chat_run("scheduled-" + task_id, body, task.get("target") or "")
        with scheduled_tasks_lock:
            current = scheduled_tasks.get(task_id)
            if not current or current.get("status") != "running":
                run.cancel()
                return
            current["run_id"] = run.id
            _save_scheduled_tasks_locked()
        cursor = 0
        content, reasoning = [], []
        while True:
            page = run.snapshot(cursor, 15)
            cursor = page["next"]
            for line in page["lines"]:
                if not line.startswith("data:"):
                    continue
                data = line[5:].strip()
                if not data or data == "[DONE]":
                    continue
                try:
                    event = json.loads(data)
                except ValueError:
                    continue
                delta = (event.get("choices") or [{}])[0].get("delta") or {}
                if delta.get("content"):
                    content.append(delta["content"])
                if delta.get("reasoning_content"):
                    reasoning.append(delta["reasoning_content"])
            if page["done"]:
                if page["error"]:
                    raise RuntimeError(page["error"])
                break
        result = "".join(content).strip() or "".join(reasoning).strip()
        if not result:
            raise RuntimeError("the model returned no text")
        if len(result) > 30000:
            result = result[:30000] + "\n[scheduled result truncated]"
        status_value, error = "completed", ""
    except Exception as e:
        result, error, status_value = "", f"{type(e).__name__}: {e}", "failed"
    with scheduled_tasks_lock:
        current = scheduled_tasks.get(task_id)
        if current and current.get("status") == "running":
            current.update(status=status_value, result=result, error=error,
                           completed_at=time.time(), run_id="")
            _save_scheduled_tasks_locked()


def scheduled_task_loop():
    while True:
        now = time.time()
        due = []
        with scheduled_tasks_lock:
            for task in scheduled_tasks.values():
                if task.get("status") == "scheduled" and task.get("due_at", now + 1) <= now:
                    task.update(status="running", started_at=now)
                    due.append(task["id"])
            if due:
                _save_scheduled_tasks_locked()
        for task_id in due:
            threading.Thread(target=_scheduled_task_worker, args=(task_id,), daemon=True,
                             name="scheduled-task-" + task_id).start()
        time.sleep(1)


# ----------------------------------------------------------------- storage
def load():
    try:
        with open(STATE_FILE) as f:
            for n in json.load(f):
                nodes[n["id"]] = n
    except FileNotFoundError:
        pass
    except Exception as e:
        print("[controller] could not read", STATE_FILE, e)


def save():
    os.makedirs(os.path.dirname(STATE_FILE), exist_ok=True)
    tmp = STATE_FILE + ".tmp"
    with open(tmp, "w") as f:
        json.dump([n for n in nodes.values() if n.get("kind") != "browser"], f, indent=2)   # browser nodes live as long as their tab
    os.chmod(tmp, 0o600)  # contains worker tokens
    os.replace(tmp, STATE_FILE)


# -------------------------------------------------------------- node calls
def conn_for(url, timeout):
    u = urllib.parse.urlparse(url)
    port = u.port or (443 if u.scheme == "https" else 80)
    cls = http.client.HTTPSConnection if u.scheme == "https" else http.client.HTTPConnection
    return cls(u.hostname, port, timeout=timeout), (u.path or "").rstrip("/")


def call_node(node, method, path, body=None, timeout=15):
    c, prefix = conn_for(node["url"], timeout)
    hdrs = {"Content-Type": "application/json"}
    if node.get("token"):
        hdrs["Authorization"] = "Bearer " + node["token"]
    data = json.dumps(body).encode() if body is not None else None
    try:
        c.request(method, prefix + path, body=data, headers=hdrs)
        r = c.getresponse()
        raw = r.read()
        try:
            return r.status, json.loads(raw or b"{}")
        except ValueError:
            return r.status, {"error": raw[:200].decode("utf8", "replace")}
    finally:
        c.close()


def poll_loop():
    while True:
        with lock:
            snap = list(nodes.values())
        def one(n):
            if n.get("kind") == "browser":          # no URL to call: the tab reports in by itself
                bn = bnodes.get(n["id"])
                if bn is not None and bnode_alive(bn):
                    status[n["id"]] = bnode_status(bn)
                else:
                    status[n["id"]] = {"ok": False, "data": None, "seen": time.time(),
                                       "error": "the browser tab is not connected (closed, asleep or offline)"}
                    if bn is not None and time.time() - bn.seen > BROWSER_FORGET_S:
                        bnode_remove(n["id"])
                        bnodes_removed.discard(n["id"])   # forgotten, not removed by the user: the tab may re-register
                return
            try:
                code, d = call_node(n, "GET", "/api/status", timeout=6)
                if code == 200:
                    status[n["id"]] = {"ok": True, "data": d, "seen": time.time(), "error": None}
                else:
                    status[n["id"]] = {"ok": False, "data": None, "seen": time.time(),
                                       "error": d.get("error", f"HTTP {code}")}
            except Exception as e:
                status[n["id"]] = {"ok": False, "data": None, "seen": time.time(),
                                   "error": f"{type(e).__name__}: {e}"}
        with concurrent.futures.ThreadPoolExecutor(max_workers=16) as ex:
            list(ex.map(one, snap))
        time.sleep(POLL_S)


def node_view(n):
    s = status.get(n["id"], {})
    return {
        "id": n["id"], "name": n["name"], "url": n["url"], "kind": n.get("kind", "lan"),
        "has_token": bool(n.get("token")), "weight": n.get("weight"),
        "online": bool(s.get("ok")), "error": s.get("error"),
        "info": s.get("data"), "gateway_inflight": inflight.get(n["id"], 0),
    }


def cluster_worker_action(action, body):
    endpoints = {
        "install": ("/api/service/install", 30),
        "uninstall": ("/api/service/uninstall", 30),
        "restart": ("/api/service/restart", 30),
        "update": ("/api/update", 360),
    }
    if action not in endpoints:
        raise ValueError("unknown worker action")
    endpoint, timeout = endpoints[action]
    token = str(body.get("token") or "")
    if action == "install" and not re.fullmatch(r"[A-Za-z0-9._~+/=-]{12,256}", token):
        raise ValueError("worker token must be 12-256 characters using letters, numbers, . _ ~ + / = or -")
    controller_node = str(body.get("controller_node") or "")
    controller_is_worker = body.get("controller_is_worker") is True
    with lock:
        snapshot = [dict(node) for node in nodes.values()]
        host_status = {nid: status.get(nid, {}).get("data") or {} for nid in nodes}

    def apply(node):
        if node.get("kind") == "browser":
            return {"node": node["name"], "status": "skipped", "message": "browser nodes have no worker service"}
        if controller_node == node["id"] and not controller_is_worker:
            return {"node": node["name"], "status": "skipped",
                    "message": "controller host excluded (not configured as a worker)"}
        if action in ("install", "uninstall"):
            os_name = host_status.get(node["id"], {}).get("os")
            if os_name != "Linux":
                return {"node": node["name"], "status": "skipped",
                        "message": "Linux could not be verified; refresh node status before managing its service"}
        request = {"token": token} if action == "install" else {}
        try:
            code, result = call_node(node, "POST", endpoint, request, timeout=timeout)
            ok = 200 <= code < 300 and result.get("ok", True)
            if ok and action == "install":
                with lock:
                    current = nodes.get(node["id"])
                    if current:
                        current["token"] = token
            return {"node": node["name"], "status": "success" if ok else "failed",
                    "http_status": code, "message": result.get("message") or result.get("error") or
                    ("worker action accepted" if ok else "worker rejected the request")}
        except Exception as e:
            return {"node": node["name"], "status": "failed",
                    "message": f"{type(e).__name__}: {e}"}

    with concurrent.futures.ThreadPoolExecutor(max_workers=min(16, max(1, len(snapshot)))) as pool:
        results = list(pool.map(apply, snapshot))
    if action == "install" and any(result["status"] == "success" for result in results):
        with lock:
            save()
    return {"results": results}


# ---------------------------------------------------------- LAN discovery
def discover(port=7860, timeout=0.35):
    ips = set()
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(("10.255.255.255", 1))
        ips.add(s.getsockname()[0])
        s.close()
    except Exception:
        return []
    found = []
    def probe(ip):
        try:
            with socket.create_connection((ip, port), timeout=timeout):
                pass
            c = http.client.HTTPConnection(ip, port, timeout=2)
            c.request("GET", "/ping")
            r = c.getresponse()
            d = json.loads(r.read() or b"{}")
            c.close()
            if d.get("ok"):
                found.append({"url": f"http://{ip}:{port}", "name": d.get("name", ip)})
        except Exception:
            pass
    targets = []
    for ip in ips:
        base = ".".join(ip.split(".")[:3])
        targets += [f"{base}.{i}" for i in range(1, 255)]
    with concurrent.futures.ThreadPoolExecutor(max_workers=128) as ex:
        list(ex.map(probe, targets))
    return found


# ------------------------------------------------- browser nodes (WebGPU)
# A browser tab can't accept connections, so a "browser node" works the other way round: the tab (llamacluster-web,
# src/webgpu/node.js) registers itself, long-polls /api/browser-nodes/<id>/poll for chat requests, runs them on the
# GPU with WebLLM and posts the streamed OpenAI chunks back. To the rest of the controller (status, balancer, gateway,
# chat runs) it looks like any other node of kind "browser". They are never saved: they live as long as the tab.
BROWSER_TTL = 15.0         # no poll / heartbeat for this long -> the node counts as offline
BROWSER_PICKUP_S = 25.0    # a queued request the tab didn't pick up in this time fails, so the gateway can try another node
BROWSER_FORGET_S = 600.0   # an offline browser node is dropped after this long (the tab re-registers when it wakes)
BROWSER_MAX_CHUNKS = 4000  # chunks accepted per job post
bnodes = {}                # node id -> BrowserNode
bnodes_removed = set()     # ids removed on the controller; their tab is told (HTTP 410) to stop sharing


class BrowserNodeError(Exception):
    def __init__(self, message, retryable=False):
        super().__init__(message)
        self.retryable = retryable      # nothing was produced yet, so another node may take the request


class BrowserJob:
    def __init__(self, body):
        self.id = uuid.uuid4().hex[:12]
        self.body = body
        self.created = time.time()
        self.taken = False
        self.chunks = []          # OpenAI chat.completion.chunk dicts not yet consumed
        self.done = False
        self.error = None
        self.cancelled = False
        self.cancel_sent = False


class BrowserNode:
    def __init__(self, nid, name, client_id):
        self.id = nid
        self.name = name
        self.client_id = client_id
        self.created = self.seen = time.time()
        self.info = {}            # last heartbeat: state, model, progress, text, gpu, ctx, vision, cores, ...
        self.queue = []           # jobs waiting for the tab
        self.jobs = {}            # id -> BrowserJob (queued, running, or cancelled but not yet told to the tab)
        self.removed = False
        self.cond = threading.Condition()


def bnode_alive(bn):
    return not bn.removed and time.time() - bn.seen < BROWSER_TTL


_BINFO_STR = ("state", "model", "text", "error", "label")
_BINFO_NUM = ("progress", "ctx", "cores", "size_mb", "memory_gb")


def bnode_clean_info(raw):
    """Whitelist what a tab may report about itself (it is shown in the UI and read by the balancer)."""
    out = {}
    if not isinstance(raw, dict):
        return out
    for k in _BINFO_STR:
        if isinstance(raw.get(k), str):
            out[k] = raw[k][:300]
    for k in _BINFO_NUM:
        if isinstance(raw.get(k), (int, float)) and not isinstance(raw.get(k), bool) and math.isfinite(raw[k]):
            out[k] = raw[k]
    for k in ("vision", "tools", "busy"):
        if isinstance(raw.get(k), bool):
            out[k] = raw[k]
    if isinstance(raw.get("gpu"), dict):
        out["gpu"] = {k: str(v)[:120] for k, v in raw["gpu"].items() if k in ("name", "vendor", "architecture") and v}
    return out


def bnode_status(bn):
    """The same shape a worker's /api/status has, as far as the UI and the balancer read it."""
    i = bn.info
    state = {"ready": "ready", "loading": "loading"}.get(i.get("state"), "stopped")
    model = i.get("model") or ""
    gpu = i.get("gpu") or {}
    cfg = {"model": model, "ctx_size": int(i.get("ctx") or 4096), "parallel": 1, "gpu_layers": 99} if model and state != "stopped" else None
    return {"ok": True, "seen": bn.seen, "error": None, "data": {
        "name": bn.name, "version": "browser", "os": "Browser",
        "hardware": {"cpu_count": int(i.get("cores") or 0), "ram_total_mb": 0, "ram_free_mb": 0,
                     "gpus": [{"name": gpu.get("name") or "WebGPU", "vram_total_mb": 0, "vram_used_mb": 0}]},
        "ips": [], "llama_server_found": False, "rpc_server_found": False,
        "server": {"state": state, "config": cfg, "uptime_s": 0, "inflight": 0,   # gateway in-flight is counted by `inflight`
                   "vision": bool(i.get("vision")) and state == "ready"},
        "rpc": {"running": False, "port": None},
        "models": [{"name": model, "size_mb": int(i.get("size_mb") or 0)}] if model and state != "stopped" else [],
        "mmprojs": [], "bench": {}, "bench_job": {}, "downloads": [],
        "browser": {"client_id": bn.client_id, "state": i.get("state") or "idle", "progress": i.get("progress"),
                    "text": i.get("text") or "", "error": i.get("error") or "", "label": i.get("label") or "",
                    "tools": bool(i.get("tools")), "memory_gb": i.get("memory_gb"), "queued": len(bn.queue),
                    "busy": bool(i.get("busy"))}}}


def bnode_register(name, client_id, info):
    client_id = str(client_id or "")[:64]
    with lock:
        node = next((n for n in nodes.values() if n.get("kind") == "browser" and client_id and n.get("client_id") == client_id), None)
        if node is None:
            nid = uuid.uuid4().hex[:8]
            taken = {n["name"] for n in nodes.values()}
            base = (str(name or "").strip() or "This device")[:60]
            unique, k = base, 2
            while unique in taken:
                unique, k = f"{base} ({k})", k + 1
            node = {"id": nid, "name": unique, "url": "browser://" + nid, "token": "", "kind": "browser", "client_id": client_id}
            nodes[nid] = node
        bn = bnodes.get(node["id"])
        if bn is None:
            bn = bnodes[node["id"]] = BrowserNode(node["id"], node["name"], client_id)
        bnodes_removed.discard(node["id"])
        with bn.cond:
            bn.seen = time.time()
            bn.info = bnode_clean_info(info)
        status[node["id"]] = bnode_status(bn)
    return node


def bnode_remove(nid):
    with lock:
        nodes.pop(nid, None)
        status.pop(nid, None)
        bn = bnodes.pop(nid, None)
        bnodes_removed.add(nid)
        if len(bnodes_removed) > 200:
            bnodes_removed.clear()
            bnodes_removed.add(nid)
    if bn:
        with bn.cond:
            bn.removed = True
            bn.cond.notify_all()


def bnode_heartbeat(bn, info):
    with bn.cond:
        bn.seen = time.time()
        if info is not None:
            bn.info = bnode_clean_info(info)
        cancel = _bnode_take_cancels(bn)
        bn.cond.notify_all()
    status[bn.id] = bnode_status(bn)
    return cancel


def _bnode_take_cancels(bn):
    """Ids of cancelled jobs the tab hasn't been told about yet (call with bn.cond held)."""
    now = time.time()
    out = []
    for j in list(bn.jobs.values()):
        if j.cancelled and j.taken and not j.cancel_sent:
            j.cancel_sent = True
            out.append(j.id)
            bn.jobs.pop(j.id, None)
        elif j.cancelled and not j.taken:
            bn.jobs.pop(j.id, None)
        elif j.cancelled and now - j.created > 300:
            bn.jobs.pop(j.id, None)
    return out


def bnode_poll(bn, wait):
    """Long poll from the tab: hands out the next queued job (the tab runs them one at a time) and tells it which
    jobs to abort. Polling is also the tab's liveness signal, so it keeps `seen` fresh while it waits."""
    deadline = time.monotonic() + max(0.0, min(20.0, wait))
    with bn.cond:
        while True:
            bn.seen = time.time()
            cancel = _bnode_take_cancels(bn)
            job = None
            while bn.queue and job is None:
                cand = bn.queue.pop(0)
                if not cand.cancelled:
                    cand.taken = True
                    job = cand
            remaining = deadline - time.monotonic()
            if cancel or job or bn.removed or remaining <= 0:
                break
            bn.cond.wait(min(1.0, remaining))
        return {"jobs": [{"id": job.id, "body": job.body}] if job else [], "cancel": cancel, "removed": bn.removed}


def bnode_job_update(bn, job_id, chunks, done, error):
    with bn.cond:
        job = bn.jobs.get(job_id)
        if job is None or job.cancelled:
            return False
        bn.seen = time.time()
        for c in (chunks or [])[:BROWSER_MAX_CHUNKS]:
            if isinstance(c, dict):
                job.chunks.append(c)
        if done:
            job.done = True
            job.error = (str(error)[:500] if error else None)
        bn.cond.notify_all()
        return True


def bnode_stream(bn, body, cancelled=lambda: False):
    """Run one chat request on a browser node and yield its OpenAI chunk dicts. Raises BrowserNodeError;
    `retryable` is set while nothing has been produced, so the caller may hand the request to another node."""
    job = BrowserJob(body)
    with bn.cond:
        if not bnode_alive(bn):
            raise BrowserNodeError("browser tab is not connected", True)
        if bn.info.get("state") != "ready":
            raise BrowserNodeError("no model is loaded in the browser tab", True)
        bn.jobs[job.id] = job
        bn.queue.append(job)
        bn.cond.notify_all()
    produced = False
    try:
        while True:
            if cancelled():
                return
            with bn.cond:
                while not job.chunks and not job.done:
                    if cancelled():
                        return
                    if not bnode_alive(bn):
                        raise BrowserNodeError("browser tab went offline", not produced)
                    if not job.taken and time.time() - job.created > BROWSER_PICKUP_S:
                        raise BrowserNodeError("browser tab did not pick up the request (asleep?)", True)
                    bn.cond.wait(1.0)
                chunks, job.chunks = job.chunks, []
                done, error = job.done, job.error
            for c in chunks:
                produced = True
                yield c
            if done:
                if error:
                    raise BrowserNodeError(error, not produced)
                return
    finally:
        with bn.cond:
            if not job.done:
                job.cancelled = True       # the tab hears about it on its next poll / heartbeat
                if job in bn.queue:
                    bn.queue.remove(job)
            else:
                bn.jobs.pop(job.id, None)
            bn.cond.notify_all()


def bnode_collect(chunks, model):
    """Fold streamed chunks into one non-streaming chat completion."""
    content, reasoning, finish, usage, cid = [], [], None, None, None
    for c in chunks:
        cid = cid or c.get("id")
        for ch in c.get("choices") or []:
            d = ch.get("delta") or {}
            if d.get("content"):
                content.append(d["content"])
            if d.get("reasoning_content"):
                reasoning.append(d["reasoning_content"])
            if ch.get("finish_reason"):
                finish = ch["finish_reason"]
        if c.get("usage"):
            usage = c["usage"]
    msg = {"role": "assistant", "content": "".join(content)}
    if reasoning:
        msg["reasoning_content"] = "".join(reasoning)
    return {"id": cid or "chatcmpl-" + uuid.uuid4().hex[:12], "object": "chat.completion", "created": int(time.time()),
            "model": model, "choices": [{"index": 0, "message": msg, "finish_reason": finish or "stop"}], "usage": usage or {}}


def _chat_run_browser(run, node, body):
    """Feed a browser node's output into a chat run. Returns None when the run is finished (ok, cancelled or failed
    for good) or an error string when the next candidate node should be tried."""
    bn = bnodes.get(node["id"])
    if bn is None:
        return f"{node['name']}: browser node is gone"
    gen = bnode_stream(bn, body, cancelled=lambda: run.cancelled)
    try:
        for chunk in gen:
            if not run.node:
                run.node = node["name"]
            if not run.append("data: " + json.dumps(chunk) + "\n") or not run.append("\n"):
                return None
        if not run.cancelled:
            run.node = run.node or node["name"]
            run.append("data: [DONE]\n")
            run.append("\n")
        return None
    except BrowserNodeError as e:
        if e.retryable and not run.node:
            return f"{node['name']}: {e}"
        run.error = f"{node['name']}: {e}"
        return None
    finally:
        gen.close()


# --------------------------------------------------------------- gateway
def ready_nodes(model_hint=None):
    out = []
    for n in list(nodes.values()):
        s = status.get(n["id"])
        if not (s and s.get("ok") and s["data"]["server"]["state"] == "ready"):
            continue
        if n.get("kind") == "browser" and not (n["id"] in bnodes and bnode_alive(bnodes[n["id"]])):
            continue        # status is refreshed every POLL_S; a tab that just went quiet must not be picked meanwhile
        cfg = s["data"]["server"].get("config") or {}
        out.append((n, cfg.get("model", "")))
    if model_hint:
        mh = model_hint.lower()
        matched = [x for x in out if mh in x[1].lower() or x[1].lower().rsplit("/", 1)[-1].rsplit(".gguf", 1)[0] == mh]
        if matched:
            out = matched
    return [n for n, _ in out]


def capacity(n):
    """Relative capacity of a node: its 'weight' (set by Maximise cluster) or its parallel slots."""
    try:
        w = float(n.get("weight") or 0)
        if w > 0:
            return w
    except (TypeError, ValueError):
        pass
    cfg = (status[n["id"]]["data"]["server"].get("config") or {})
    try:
        return max(1.0, float(cfg.get("parallel") or 1))
    except (TypeError, ValueError):
        return 1.0


def pick_order(cands):
    """Weighted least-connections: lowest (in-flight + 1) / capacity first, so idle
    big nodes win and load spreads in proportion to capacity. Ties -> least recently used."""
    def load(n):
        d = status[n["id"]]["data"]["server"]
        return inflight.get(n["id"], 0) + d.get("inflight", 0)
    ordered = sorted(cands, key=lambda n: ((load(n) + 1) / capacity(n), last_used.get(n["id"], 0.0)))
    if ordered:
        last_used[ordered[0]["id"]] = time.time()
    return ordered


# --------------------------------------------------------- LAN addresses / token
def lan_ips():
    """IPv4 addresses other devices on the network can use to reach this computer (best first)."""
    ips = []
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(("10.255.255.255", 1))        # no packet is sent; this just picks the outgoing interface
        ips.append(s.getsockname()[0])
        s.close()
    except Exception:
        pass
    try:
        ips += socket.gethostbyname_ex(socket.gethostname())[2]
    except Exception:
        pass
    out = []
    for ip in ips:
        if ip and not ip.startswith(("127.", "169.254.", "0.")) and ip not in out:
            out.append(ip)
    return out


def own_hostnames():
    names = {"localhost"}
    try:
        h = socket.gethostname()
        names |= {h.lower(), h.lower() + ".local", socket.getfqdn().lower()}
    except Exception:
        pass
    return names


def is_loopback(addr):
    try:
        return ipaddress.ip_address(str(addr).split("%")[0]).is_loopback
    except ValueError:
        return str(addr).lower() == "localhost"


def host_only(hostport):
    hostport = hostport or ""
    return hostport[1:hostport.index("]")] if hostport.startswith("[") else hostport.rsplit(":", 1)[0] if ":" in hostport else hostport


def load_or_make_token(path):
    """A random access token kept in ~/.config/llamacluster so it survives restarts (mode 600)."""
    try:
        with open(path) as f:
            t = f.read().strip()
        if len(t) >= 12:
            return t
    except OSError:
        pass
    t = secrets.token_urlsafe(18)
    try:
        os.makedirs(os.path.dirname(path), exist_ok=True)
        fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        with os.fdopen(fd, "w") as f:
            f.write(t + "\n")
    except OSError as e:
        print("[controller] could not save the token to", path, "-", e, "(it will change on restart)")
    return t


class Server(ThreadingHTTPServer):
    daemon_threads = True

    def __init__(self, addr, handler):
        if ":" in addr[0]:                       # --host :: (IPv6)
            self.address_family = socket.AF_INET6
        super().__init__(addr, handler)


# ------------------------------------------------------------------ HTTP
class H(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, *a):
        pass

    def _json(self, code, obj):
        data = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        if self.path.startswith("/v1/"):
            self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def _body(self):
        n = int(self.headers.get("Content-Length") or 0)
        return json.loads(self.rfile.read(n) or b"{}") if n else {}

    def _attachment(self, filename, content_type, fileobj, size):
        self.send_response(200)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Disposition", "attachment; filename*=UTF-8''" + urllib.parse.quote(filename, safe=""))
        self.send_header("Content-Length", str(size))
        self.send_header("X-Content-Type-Options", "nosniff")
        self.end_headers()
        while True:
            chunk = fileobj.read(65536)
            if not chunk:
                break
            self.wfile.write(chunk)

    def _workspace_download(self, rel):
        _, path = tools.ws_path(rel)
        if not os.path.isfile(path):
            raise tools.ToolError("no such file: " + str(rel))
        with open(path, "rb") as f:
            self._attachment(os.path.basename(path), mimetypes.guess_type(path)[0] or "application/octet-stream", f, os.path.getsize(path))

    def _workspace_zip(self):
        with tempfile.TemporaryFile() as f:
            tools.write_workspace_zip(f)
            size = f.tell()
            f.seek(0)
            self._attachment("llamacluster-workspace.zip", "application/zip", f, size)

    def _static(self, fp, ctype, cache):
        with open(fp, "rb") as f:
            data = f.read()
        self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Cache-Control", cache)
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def _serve_ui(self, path):
        """The page itself and its files are public (the API behind them still needs the token). Returns True if handled.
        New UI (llamacluster-web/dist) answers at / and on its own routes (/chat); the old ui.html redirects there
        unless the controller was started with --classic (or the new UI hasn't been built)."""
        old_ui = os.path.join(HERE, "ui.html")
        if path in ("/ui.html", "/classic"):
            if new_ui_available():
                self.send_response(302)
                self.send_header("Location", "/")
                self.send_header("Content-Length", "0")
                self.end_headers()
                return True
            self._static(old_ui, "text/html; charset=utf-8", "no-cache")
            return True
        if not new_ui_available():
            if path in ("/", "/index.html"):
                self._static(old_ui, "text/html; charset=utf-8", "no-cache")
                return True
            return False
        if path.startswith(("/api/", "/v1/", "/vendor/")):
            return False
        dist = os.path.realpath(WEB_DIST)
        fp = os.path.realpath(os.path.join(dist, urllib.parse.unquote(path).lstrip("/")))
        if path not in ("/", "/index.html") and fp.startswith(dist + os.sep) and os.path.isfile(fp):
            ext = os.path.splitext(fp)[1].lower()
            cache = "public, max-age=31536000, immutable" if path.startswith("/assets/") else "no-cache"
            self._static(fp, _WEB_TYPES.get(ext) or mimetypes.guess_type(fp)[0] or "application/octet-stream", cache)
            return True
        if os.path.splitext(path)[1]:      # a missing file (e.g. /assets/old.js): a real 404, not the app shell
            return False
        self._static(os.path.join(dist, "index.html"), _WEB_TYPES[".html"], "no-cache")   # client-side routes: /chat, ...
        return True

    def _authed(self):
        if not CTRL_TOKEN:
            return True
        h = self.headers.get("Authorization", "")
        if secrets.compare_digest(h.encode(), ("Bearer " + CTRL_TOKEN).encode()):
            return True
        # a generated token only guards the network: a browser on this very computer (loopback peer AND a loopback
        # Host name - so DNS-rebinding pages and reverse proxies don't qualify) doesn't have to type it
        return TOKEN_AUTO and is_loopback(self.client_address[0]) and is_loopback(host_only(self.headers.get("Host")))

    def _origin_ok(self):
        """CSRF / DNS-rebinding guard for endpoints that touch files or the web."""
        host = self.headers.get("Host") or ""
        origin = self.headers.get("Origin")
        if origin and urllib.parse.urlparse(origin).netloc != host:
            return False
        if not CTRL_TOKEN:   # without a token only literal IPs, localhost and this computer's own name may address us
            hn = host_only(host).lower()
            if hn not in own_hostnames():
                try:
                    ipaddress.ip_address(hn)
                except ValueError:
                    return False
        return True

    def do_GET(self): self._route("GET")
    def do_POST(self): self._route("POST")
    def do_DELETE(self): self._route("DELETE")

    def do_OPTIONS(self):
        # CORS preflight for apps on other devices calling /v1 from a browser. A bare "*" does not cover the
        # Authorization header, so echo back whatever the browser asked for.
        self.send_response(204)
        want = self.headers.get("Access-Control-Request-Headers") or "Authorization, Content-Type"
        for k, v in (("Access-Control-Allow-Origin", "*"), ("Access-Control-Allow-Headers", want + ", Authorization, Content-Type"),
                     ("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS"), ("Access-Control-Max-Age", "600"),
                     ("Content-Length", "0")):
            self.send_header(k, v)
        self.end_headers()

    def _route(self, method):
        path = urllib.parse.urlparse(self.path).path
        try:
            if method == "GET" and self._serve_ui(path):
                return
            if path.startswith("/vendor/") and method == "GET":      # bundled xterm.js (public library files)
                name = path[len("/vendor/"):]
                ctype = {"xterm.js": "text/javascript", "addon-fit.js": "text/javascript", "xterm.css": "text/css"}.get(name)
                fp = os.path.join(HERE, "vendor", name)
                if not ctype or not os.path.isfile(fp):
                    return self._json(404, {"error": "not found"})
                with open(fp, "rb") as f:
                    data = f.read()
                self.send_response(200)
                self.send_header("Content-Type", ctype + "; charset=utf-8")
                self.send_header("Cache-Control", "max-age=86400")
                self.send_header("Content-Length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)
                return
            if not self._authed():
                return self._json(401, {"error": "unauthorized"})
            if path.startswith("/v1/"):
                return self._gateway(method, path)
            if path == "/api/chat/runs" and method == "POST":
                b = self._body()
                request_id = str(b.get("request_id") or "")
                if not request_id or len(request_id) > 100:
                    return self._json(400, {"error": "request_id is required and must be at most 100 characters"})
                try:
                    run = create_chat_run(request_id, b.get("body"), str(b.get("target") or "").strip())
                    return self._json(200, {"id": run.id, "node": run.node, "done": run.done})
                except ValueError as e:
                    return self._json(400, {"error": str(e)})
                except LookupError as e:
                    return self._json(503, {"error": str(e)})
                except RuntimeError as e:
                    return self._json(503, {"error": str(e)})
            if path.startswith("/api/chat/runs/"):
                run_id = path[len("/api/chat/runs/"):]
                run = get_chat_run(run_id)
                if not run:
                    return self._json(404, {"error": "chat stream not found or expired"})
                if method == "GET":
                    query = urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query)
                    try:
                        after = max(0, int((query.get("after") or ["0"])[0]))
                        wait = min(20, max(0, float((query.get("wait") or ["15"])[0])))
                    except ValueError:
                        return self._json(400, {"error": "after and wait must be numbers"})
                    return self._json(200, run.snapshot(after, wait))
                if method == "DELETE":
                    run.cancel()
                    return self._json(200, {"ok": True})
                return self._json(405, {"error": "method not allowed"})
            if path == "/api/scheduled-tasks" and method == "GET":
                return self._json(200, {"tasks": list_scheduled_tasks()})
            if path == "/api/scheduled-tasks" and method == "POST":
                b = self._body()
                try:
                    task = create_scheduled_task(b.get("prompt"), b.get("due_at"), b.get("model", ""),
                                                 b.get("target", ""), b.get("system_prompt", ""))
                    return self._json(201, task)
                except ValueError as e:
                    return self._json(400, {"error": str(e)})
                except RuntimeError as e:
                    return self._json(503, {"error": str(e)})
            if path.startswith("/api/scheduled-tasks/") and method == "DELETE":
                task_id = path[len("/api/scheduled-tasks/"):]
                if not cancel_scheduled_task(task_id):
                    return self._json(404, {"error": "scheduled task not found"})
                return self._json(200, {"ok": True})
            if path == "/api/host" and method == "GET":
                return self._json(200, {"port": PORT, "lan_urls": ["http://%s:%d" % (ip, PORT) for ip in lan_ips()],
                                        "hostnames": sorted(n for n in own_hostnames() if n != "localhost"),
                                        "token_required": bool(CTRL_TOKEN)})
            if path == "/api/models/send" and method == "POST":
                return self._send_model(self._body())
            if path == "/api/tools" and method == "GET":
                return self._json(200, {"workspace": os.path.realpath(tools.WORKSPACE), "tools": tools.available(),
                                        "search": "searxng+web" if tools.SEARXNG else "web",
                                        "exec": tools.EXEC_ENABLED, "permissions": list(tools.PERMISSIONS)})
            if path == "/api/tools/run" and method == "POST":
                if not self._origin_ok():
                    return self._json(403, {"error": "cross-origin request refused"})
                b = self._body()
                args = b.get("arguments") or {}
                if isinstance(args, str):
                    try:
                        args = json.loads(args or "{}")
                    except ValueError:
                        args = None
                # approval policy lives here, not in the page: under 'manual' / 'semi' a call that needs the
                # user's OK is answered with needs_approval and only runs when the page re-sends it approved.
                reason = tools.approval_reason(b.get("name", ""), args, b.get("permission") or "manual")
                if reason and not b.get("approved"):
                    return self._json(200, {"needs_approval": True, "reason": reason})
                return self._json(200, {"result": tools.run(b.get("name", ""), args)})
            if path.startswith("/api/term/"):
                return self._terminal(method, path)
            if path.startswith("/api/workspace"):
                if not self._origin_ok():
                    return self._json(403, {"error": "cross-origin request refused"})
                q = urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query)
                rel = (q.get("path") or [""])[0]
                try:
                    if path == "/api/workspace" and method == "GET":
                        return self._json(200, tools.workspace_listing())
                    if path == "/api/workspace/download" and method == "GET":
                        return self._workspace_download(rel)
                    if path == "/api/workspace/download.zip" and method == "GET":
                        return self._workspace_zip()
                    if path == "/api/workspace/file" and method == "GET":
                        r = tools.read_file(rel)
                        if r["truncated"]:
                            raise tools.ToolError("file too large to edit here")
                        return self._json(200, r)
                    if path == "/api/workspace/file" and method == "POST":
                        b = self._body()
                        return self._json(200, tools.write_file(b.get("path", ""), b.get("content", "")))
                    if path == "/api/workspace/file" and method == "DELETE":
                        return self._json(200, tools.delete_file(rel))
                    if path == "/api/workspace/clear" and method == "POST":
                        if self._body().get("confirm") is not True:
                            raise tools.ToolError("clearing the workspace needs confirm=true")
                        return self._json(200, tools.clear_workspace())
                except tools.ToolError as e:
                    return self._json(400, {"error": str(e)})
            if path == "/api/browser-nodes" or path.startswith("/api/browser-nodes/"):
                return self._browser_nodes(method, path)
            if path == "/api/nodes" and method == "GET":
                return self._json(200, [node_view(n) for n in list(nodes.values())])
            if path == "/api/nodes" and method == "POST":
                return self._add_node(self._body())
            if path == "/api/discover" and method == "POST":
                known = {n["url"] for n in nodes.values()}
                return self._json(200, [d for d in discover() if d["url"] not in known])
            if path.startswith("/api/cluster/workers/") and method == "POST":
                action = path[len("/api/cluster/workers/"):]
                try:
                    return self._json(200, cluster_worker_action(action, self._body()))
                except ValueError as e:
                    return self._json(400, {"error": str(e)})
            if path == "/api/cluster/launch" and method == "POST":
                return self._launch_distributed(self._body())
            if path == "/api/cluster/stop" and method == "POST":
                return self._stop_all()
            if path == "/api/gateway" and method == "GET":
                ready = ready_nodes()
                return self._json(200, {"ready_nodes": [n["name"] for n in ready]})
            if path.startswith("/api/nodes/"):
                parts = path[len("/api/nodes/"):].split("/", 1)
                nid, rest = parts[0], (parts[1] if len(parts) > 1 else "")
                node = nodes.get(nid)
                if not node:
                    return self._json(404, {"error": "no such node"})
                if rest == "" and method == "DELETE":
                    if node.get("kind") == "browser":
                        bnode_remove(nid)       # the tab hears about it on its next poll and stops sharing
                        return self._json(200, {"ok": True})
                    with lock:
                        nodes.pop(nid, None); status.pop(nid, None); save()
                    return self._json(200, {"ok": True})
                if node.get("kind") == "browser" and rest != "update":
                    return self._json(400, {"error": "this node is a browser tab: change its model or stop sharing in that tab"})
                if rest == "logs":
                    code, d = call_node(node, "GET", "/api/logs")
                    return self._json(code, d)
                if rest == "models/storage" and method == "GET":
                    code, d = call_node(node, "GET", "/api/models/storage")
                    return self._json(code, d)
                if rest == "update" and method == "POST":
                    b = self._body()
                    for k in ("name", "url", "token", "kind"):
                        if b.get(k) not in (None, ""):
                            node[k] = b[k].rstrip("/") if k == "url" else b[k]
                    if "weight" in b:
                        try:
                            w = float(b["weight"])
                            node["weight"] = w if w > 0 else None
                        except (TypeError, ValueError):
                            node["weight"] = None
                    with lock:
                        save()
                    return self._json(200, {"ok": True})
                if rest == "models/move" and method == "POST":
                    code, d = call_node(node, "POST", "/api/models/move", self._body(), timeout=3600)
                    return self._json(code, d)
                if rest in ("start", "stop", "rpc/start", "rpc/stop", "models/install",
                            "models/delete", "models/cancel", "bench/start",
                            "bench/cancel") and method == "POST":
                    code, d = call_node(node, "POST", "/api/" + rest, self._body(), timeout=30)
                    return self._json(code, d)
            return self._json(404, {"error": "not found"})
        except Exception as e:
            return self._json(500, {"error": f"{type(e).__name__}: {e}"})

    # -- browser nodes (this device, WebGPU) - see "browser nodes" above
    def _browser_nodes(self, method, path):
        if not self._origin_ok():
            return self._json(403, {"error": "cross-origin request refused"})
        parts = [p for p in path[len("/api/browser-nodes"):].split("/") if p]
        b = self._body() if method == "POST" else {}     # always read the body: keep-alive connections must stay in sync
        if not parts:
            if method != "POST":
                return self._json(405, {"error": "method not allowed"})
            node = bnode_register(b.get("name"), b.get("client_id"), b.get("info"))
            return self._json(200, {"id": node["id"], "name": node["name"]})
        nid, rest = parts[0], parts[1:]
        bn = bnodes.get(nid)
        if bn is None:
            if nid in bnodes_removed:
                return self._json(410, {"error": "this node was removed", "removed": True})
            return self._json(404, {"error": "unknown browser node (the controller restarted?): register again"})
        if not rest and method == "DELETE":
            bnode_remove(nid)
            return self._json(200, {"ok": True})
        if rest == ["hb"] and method == "POST":
            return self._json(200, {"ok": True, "cancel": bnode_heartbeat(bn, b.get("info"))})
        if rest == ["poll"] and method == "GET":
            q = urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query)
            try:
                wait = float((q.get("wait") or ["15"])[0])
            except ValueError:
                return self._json(400, {"error": "wait must be a number"})
            res = bnode_poll(bn, wait)
            if res["removed"]:
                return self._json(410, {"error": "this node was removed", "removed": True})
            return self._json(200, res)
        if len(rest) == 2 and rest[0] == "jobs" and method == "POST":
            ok = bnode_job_update(bn, rest[1], b.get("chunks"), b.get("done") is True, b.get("error"))
            return self._json(200 if ok else 404, {"ok": ok})
        return self._json(404, {"error": "not found"})

    # -- browser terminal (xterm.js) - see term.py
    def _terminal(self, method, path):
        if not self._origin_ok():
            return self._json(403, {"error": "cross-origin request refused"})
        if not tools.EXEC_ENABLED:
            return self._json(403, {"error": "the terminal is disabled (controller started with --no-exec)"})
        parts = path[len("/api/term/"):].split("/")
        try:
            if parts == ["status"] and method == "GET":
                ok, msg = term.available(os.path.realpath(tools.WORKSPACE))
                return self._json(200, {"available": ok, "message": msg, "network": term.ALLOW_NET})
            if parts == ["open"] and method == "POST":
                b = self._body()
                sid = term.open_session(os.path.realpath(tools.WORKSPACE), b.get("rows") or 24, b.get("cols") or 80)
                return self._json(200, {"id": sid, "network": term.ALLOW_NET})
            if len(parts) == 2:
                sid, act = parts
                if act == "out" and method == "GET":
                    q = urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query)
                    pos = int((q.get("pos") or ["0"])[0])
                    data, npos, closed = term.get(sid).read(pos, min(25, float((q.get("wait") or ["20"])[0])))
                    return self._json(200, {"data": base64.b64encode(data).decode(), "pos": npos, "closed": closed})
                if act == "in" and method == "POST":
                    term.get(sid).write(base64.b64decode(self._body().get("data", "")))
                    return self._json(200, {"ok": True})
                if act == "resize" and method == "POST":
                    b = self._body()
                    term.get(sid).resize(b.get("rows") or 24, b.get("cols") or 80)
                    return self._json(200, {"ok": True})
                if act == "close" and method == "POST":
                    term.close_session(sid)
                    return self._json(200, {"ok": True})
        except KeyError as e:
            return self._json(404, {"error": str(e).strip("'\"")})
        except (RuntimeError, ValueError) as e:
            return self._json(400, {"error": str(e)})
        return self._json(404, {"error": "not found"})

    def _send_model(self, b):
        """Copy one installed model from a source node to several target nodes (node -> node over the LAN)."""
        with lock:
            src = nodes.get(b.get("source"))
            targets = [nodes[i] for i in (b.get("targets") or []) if i in nodes and i != b.get("source")
                       and nodes[i].get("kind") != "browser"]
        if src and src.get("kind") == "browser":
            return self._json(400, {"error": "a browser node has no model files to send"})
        name = b.get("name") or ""
        if not src or not name or not targets:
            return self._json(400, {"error": "source, name and at least one other target node are required"})
        sdata = (status.get(src["id"]) or {}).get("data") or {}
        if name not in [m["name"] for m in sdata.get("models", []) + sdata.get("mmprojs", [])]:
            return self._json(400, {"error": "source node does not have that model"})
        url = src["url"].rstrip("/") + "/api/models/file?name=" + urllib.parse.quote(name)
        loop = lambda u: (urllib.parse.urlparse(u).hostname or "") in ("localhost", "127.0.0.1", "::1")
        results = []
        for t in targets:
            if loop(src["url"]) and not loop(t["url"]):
                results.append({"id": t["id"], "name": t["name"], "ok": False, "error":
                                "the source node is registered as localhost, which other machines can't reach - "
                                "re-add it using its LAN address"})
                continue
            code, d = call_node(t, "POST", "/api/models/install",
                                {"url": url, "filename": os.path.basename(name), "auth": src.get("token", "")}, timeout=30)
            results.append({"id": t["id"], "name": t["name"], "ok": code == 200, "error": None if code == 200 else d.get("error")})
        return self._json(200, {"results": results})

    # -- nodes
    def _add_node(self, b):
        url = (b.get("url") or "").strip().rstrip("/")
        if not url.startswith(("http://", "https://")):
            url = "http://" + url
        if not b.get("url"):
            return self._json(400, {"error": "url required"})
        kind = b.get("kind") or ("lan" if any(url.startswith("http://" + p) for p in ("192.", "10.", "172.", "127.", "localhost")) else "cloud")
        nid = uuid.uuid4().hex[:8]
        node = {"id": nid, "name": b.get("name") or url, "url": url, "token": b.get("token", ""), "kind": kind}
        try:
            code, d = call_node(node, "GET", "/api/status", timeout=8)
            if code == 401:
                return self._json(400, {"error": "node rejected the token"})
            if code != 200:
                return self._json(400, {"error": f"node answered HTTP {code}"})
            if not b.get("name"):
                node["name"] = d.get("name", url)
        except Exception as e:
            return self._json(400, {"error": f"cannot reach node: {e}"})
        with lock:
            nodes[nid] = node
            save()
        return self._json(200, node_view(node))

    # -- distributed launch (llama.cpp RPC)
    def _launch_distributed(self, b):
        head = nodes.get(b.get("head"))
        helpers = [nodes[i] for i in b.get("helpers", []) if i in nodes and i != b.get("head")]
        cfg = b.get("config") or {}
        if not head or not cfg.get("model"):
            return self._json(400, {"error": "head node and model required"})
        if head.get("kind") == "browser" or any(h.get("kind") == "browser" for h in helpers):
            return self._json(400, {"error": "browser (WebGPU) nodes can't take part in a distributed RPC model"})
        rpc_addrs = []
        for h in helpers:
            s = status.get(h["id"], {})
            if not (s.get("ok") and s["data"].get("rpc_server_found")):
                return self._json(400, {"error": f"{h['name']}: rpc-server not installed (build with -DGGML_RPC=ON)"})
            ht = (b.get("helper_threads") or {}).get(h["id"])     # per-helper CPU threads (phones, CPU-only boxes)
            code, d = call_node(h, "POST", "/api/rpc/start", {"threads": ht})
            if code != 200 and "already running" not in str(d.get("error", "")):
                return self._json(400, {"error": f"{h['name']}: {d.get('error')}"})
            host = urllib.parse.urlparse(h["url"]).hostname
            rpc_addrs.append(f"{host}:{s['data']['rpc']['port']}")
        cfg["rpc"] = rpc_addrs
        code, d = call_node(head, "POST", "/api/start", cfg, timeout=30)
        return self._json(code, {**d, "rpc": rpc_addrs})

    def _stop_all(self):
        for n in list(nodes.values()):
            if n.get("kind") == "browser":
                continue
            try:
                call_node(n, "POST", "/api/stop")
                call_node(n, "POST", "/api/rpc/stop")
            except Exception:
                pass
        return self._json(200, {"ok": True})

    def _gateway_browser(self, node, raw):
        """Serve one /v1/chat/completions request on a browser node. True when the reply was written (success or a
        final error), else an error string so _gateway tries the next node."""
        bn = bnodes.get(node["id"])
        if bn is None:
            return f"{node['name']}: browser node is gone"
        try:
            req = json.loads(raw or b"{}")
            if not isinstance(req, dict):
                raise ValueError("body must be a JSON object")
        except ValueError as e:
            self._json(400, {"error": {"message": "invalid JSON body: " + str(e)}})
            return True
        stream = bool(req.get("stream"))
        gen = bnode_stream(bn, req)
        started = False
        try:
            def begin(ctype):
                self.send_response(200)
                self.send_header("Content-Type", ctype)
                self.send_header("X-LlamaCluster-Node", node["name"])
                self.send_header("Access-Control-Allow-Origin", "*")
                self.send_header("Connection", "close")
                self.end_headers()
                self.close_connection = True
            if stream:
                for chunk in gen:
                    if not started:
                        begin("text/event-stream")
                        started = True
                    self.wfile.write(b"data: " + json.dumps(chunk).encode("utf8") + b"\n\n")
                    self.wfile.flush()
                if not started:
                    begin("text/event-stream")
                    started = True
                self.wfile.write(b"data: [DONE]\n\n")
                self.wfile.flush()
                return True
            data = json.dumps(bnode_collect(gen, str(req.get("model") or ""))).encode("utf8")
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(data)))
            self.send_header("X-LlamaCluster-Node", node["name"])
            self.send_header("Access-Control-Allow-Origin", "*")
            self.end_headers()
            self.wfile.write(data)
            return True
        except BrowserNodeError as e:
            if started:      # bytes already sent: end the stream with an error event instead of failing over
                try:
                    self.wfile.write(b"data: " + json.dumps({"error": {"message": f"{node['name']}: {e}"}}).encode("utf8") + b"\n\n")
                    self.wfile.flush()
                except OSError:
                    pass
                return True
            if e.retryable:
                return f"{node['name']}: {e}"
            self._json(502, {"error": {"message": f"{node['name']}: {e}"}})
            return True
        finally:
            gen.close()

    # -- OpenAI-compatible gateway
    def _gateway(self, method, path):
        body = b""
        n = int(self.headers.get("Content-Length") or 0)
        if n:
            body = self.rfile.read(n)
        if path == "/v1/models" and method == "GET":
            seen = {}
            for node in ready_nodes():
                m = (status[node["id"]]["data"]["server"].get("config") or {}).get("model", "")
                seen[m] = {"id": m, "object": "model", "owned_by": node["name"]}
            return self._json(200, {"object": "list", "data": list(seen.values())})
        hint = None
        try:
            hint = json.loads(body).get("model") if body else None
        except ValueError:
            pass
        target = (self.headers.get("X-LlamaCluster-Target") or "").strip()
        if target:   # pin the request to one node (by name or id) - used by the chat's route picker
            pool = [n for n in ready_nodes() if target in (n["id"], n["name"])]
        else:
            pool = ready_nodes(hint)
        if not (method == "POST" and path == "/v1/chat/completions"):   # browser nodes only serve chat completions
            pool = [n for n in pool if n.get("kind") != "browser"]
        cands = pick_order(pool) if pool else []
        if not cands:
            return self._json(503, {"error": {"message": "no ready node" + (" named " + target if target else "") + " - start a model on at least one node"}})
        last_err = "unknown"
        for node in cands[:3]:
            inflight[node["id"]] = inflight.get(node["id"], 0) + 1
            started = False
            try:
                if node.get("kind") == "browser":
                    res = self._gateway_browser(node, body)
                    if res is True:
                        return
                    last_err = res
                    continue
                c, prefix = conn_for(node["url"], 600)
                hdrs = {"Content-Type": self.headers.get("Content-Type", "application/json")}
                if node.get("token"):
                    hdrs["Authorization"] = "Bearer " + node["token"]
                c.request(method, prefix + path, body=body or None, headers=hdrs)
                r = c.getresponse()
                if r.status >= 500:
                    last_err = f"{node['name']}: HTTP {r.status} " + r.read()[:300].decode("utf8", "replace")
                    c.close()
                    continue
                ct = r.getheader("Content-Type", "application/json")
                self.send_response(r.status)
                self.send_header("Content-Type", ct)
                self.send_header("X-LlamaCluster-Node", node["name"])
                self.send_header("Access-Control-Allow-Origin", "*")
                self.send_header("Connection", "close")
                self.end_headers()
                self.close_connection = True
                started = True
                stream = "event-stream" in ct
                while True:
                    chunk = r.read(1024) if stream else r.read(65536)
                    if not chunk:
                        break
                    self.wfile.write(chunk)
                    self.wfile.flush()
                c.close()
                return
            except (BrokenPipeError, ConnectionResetError):
                return
            except Exception as e:
                last_err = f"{node['name']}: {e}"
                if started:
                    return  # can't retry once bytes were sent
            finally:
                inflight[node["id"]] = max(0, inflight.get(node["id"], 1) - 1)
        return self._json(502, {"error": {"message": "all nodes failed: " + last_err}})


def main():
    global CTRL_TOKEN, STATE_FILE, TOKEN_AUTO, PORT, CLASSIC
    ap = argparse.ArgumentParser(description="LlamaCluster controller + gateway")
    ap.add_argument("--host", default="0.0.0.0",
                    help="address to listen on. Default 0.0.0.0 = reachable from other devices on your network; "
                         "use 127.0.0.1 to keep it to this computer only")
    ap.add_argument("--port", type=int, default=7870)
    ap.add_argument("--token", default=os.environ.get("LLAMACLUSTER_CTRL_TOKEN", ""),
                    help="access token for the UI/API/gateway. If you listen beyond localhost and don't give one, a random "
                         "token is generated and kept in ~/.config/llamacluster/controller.token")
    ap.add_argument("--no-token", action="store_true",
                    help="serve on the network WITHOUT a token (anyone who can reach this port can use the chat tools, "
                         "including shell commands unless --no-exec). Only for networks you fully trust.")
    ap.add_argument("--local-only", action="store_true", help="same as --host 127.0.0.1")
    ap.add_argument("--state", default=STATE_FILE)
    ap.add_argument("--term-net", action="store_true",
                    help="let the browser terminal (sandboxed to the workspace) use the network. Off by default, because a shell "
                         "with network access on this computer could call the controller's own API")
    ap.add_argument("--workspace", default=os.environ.get("LLAMACLUSTER_WORKSPACE", "~/llamacluster-workspace"),
                    help="folder the chat's file tools may read/write (default ~/llamacluster-workspace)")
    ap.add_argument("--searxng", default=os.environ.get("LLAMACLUSTER_SEARXNG", ""),
                    help="URL of a SearXNG instance for web_search (recommended; else DuckDuckGo/Bing scraping)")
    ap.add_argument("--allow-private-fetch", action="store_true",
                    help="let the chat's fetch_url reach LAN/localhost addresses (off by default)")
    ap.add_argument("--classic", action="store_true",
                    help="serve the old single-file UI (ui.html) at / instead of the new React UI "
                         "(without it the old UI URL redirects to the new one)")
    ap.add_argument("--no-exec", action="store_true",
                    help="disable the chat's exec_command tool entirely (the model can't run shell commands at all)")
    ap.add_argument("--safe-commands", default=os.environ.get("LLAMACLUSTER_SAFE_COMMANDS", ""),
                    help="comma-separated extra commands that 'semi' permission may run without asking, e.g. "
                         "'python3,make,pytest' (only while all their paths stay inside the workspace)")
    a = ap.parse_args()
    if a.local_only:
        a.host = "127.0.0.1"
    STATE_FILE = a.state
    PORT = a.port
    CLASSIC = a.classic
    CTRL_TOKEN = a.token
    exposed = not is_loopback(a.host)
    if exposed and not CTRL_TOKEN and not a.no_token:
        CTRL_TOKEN = load_or_make_token(os.path.join(os.path.dirname(STATE_FILE), "controller.token"))
        TOKEN_AUTO = True
    term.configure(allow_net=a.term_net)
    tools.configure(a.workspace, a.searxng, a.allow_private_fetch, exec_enabled=not a.no_exec,
                    safe_commands=a.safe_commands.split(","))
    if CLASSIC:
        print("[controller] UI: classic (ui.html)")
    elif new_ui_available():
        print("[controller] UI: new (llamacluster-web/dist); the old UI redirects to it. Use --classic to keep the old one.")
    else:
        print("[controller] UI: new UI not built yet (cd llamacluster-web && npm install && npm run build) - serving classic ui.html")
    print(f"[controller] chat workspace: {tools.WORKSPACE}  (shell commands {'OFF' if a.no_exec else 'on'})")
    load()
    load_scheduled_tasks()
    threading.Thread(target=poll_loop, daemon=True).start()
    threading.Thread(target=scheduled_task_loop, daemon=True, name="scheduled-task-loop").start()
    try:
        srv = Server((a.host, a.port), H)
    except OSError as e:
        raise SystemExit("[controller] cannot listen on %s:%d - %s" % (a.host, a.port, e))
    print(f"[controller] listening on {a.host}:{a.port}")
    print(f"[controller]   this computer :  http://127.0.0.1:{a.port}")
    if not exposed:
        print("[controller]   other devices : not reachable (local-only). Start without --host/--local-only to allow your LAN.")
    else:
        tok = ("#token=" + CTRL_TOKEN) if CTRL_TOKEN else ""
        ips = lan_ips()
        for ip in ips or ["<this computer's IP>"]:
            print(f"[controller]   other devices :  http://{ip}:{a.port}/{tok}")
        ip0 = ips[0] if ips else "<ip>"
        print(f"[controller]   OpenAI base URL:  http://{ip0}:{a.port}/v1" + ("   (API key = the token)" if CTRL_TOKEN else ""))
        if CTRL_TOKEN:
            print(f"[controller]   access token  :  {CTRL_TOKEN}   ({'generated; saved in ' + os.path.join(os.path.dirname(STATE_FILE), 'controller.token') if TOKEN_AUTO else 'from --token'})")
            if TOKEN_AUTO:
                print("[controller]   (this computer doesn't need it; other devices are asked once and remember it. "
                      "Opening the link above fills it in for you.)")
        else:
            print("[controller] WARNING: --no-token - anyone on your network can use the chat tools" +
                  ("" if a.no_exec else " (including running shell commands: add --no-exec)") + ".")
        print("[controller]   if other devices can't connect, allow TCP port %d through this computer's firewall." % a.port)
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
