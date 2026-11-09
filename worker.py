#!/usr/bin/env python3
"""LlamaCluster worker agent.

Runs on every machine (LAN box, Modal container, Colab VM...). It:
  * reports hardware / status
  * lists, downloads and deletes GGUF models
  * starts / stops llama-server (or llama.cpp's rpc-server) with chosen settings
  * proxies /v1/* to the local llama-server so one URL per node is enough

Pure standard library. Python 3.8+.
"""
import argparse
import http.client
import json
import os
import platform
import re
import shutil
import signal
import socket
import struct
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

VERSION = "0.1.0"

# --- download robustness (power cuts / flaky network) ---
DL_SYNC_EVERY = 32 << 20      # fsync the .part file + journal every 32 MiB
DL_ORPHAN_TRIM = 64 << 20     # .part with no journal info: drop its last 64 MiB (unsynced tail may be garbage)
DL_MAX_STALLS = 120           # consecutive attempts without any progress before giving up
DL_BACKOFF_MAX = 60           # seconds


class _Fatal(Exception):
    """Download error that retrying won't fix (404, 401, not a GGUF...)."""


class _Cancelled(Exception):
    pass


# ----------------------------------------------------------------- helpers
def find_binary(name, hint=None):
    if hint and os.path.isfile(hint):
        return hint
    native = os.environ.get("LLAMACLUSTER_NATIVE_DIR")     # Android app: binaries ship as lib<name>.so
    if native:
        c = os.path.join(native, "lib%s.so" % name)
        if os.path.isfile(c):
            return c
    p = shutil.which(name)
    if p:
        return p
    for base in (
        os.path.expanduser("~/llama.cpp/build/bin"),
        os.path.expanduser("~/.local/share/llamacluster/llama.cpp/build/bin"),
        "/opt/llama.cpp/build/bin",
        "/usr/local/bin",
    ):
        c = os.path.join(base, name)
        if os.path.isfile(c):
            return c
    return None


def hardware_info():
    info = {
        "hostname": socket.gethostname(),
        "os": platform.platform(),
        "cpu_count": os.cpu_count(),
        "ram_total_mb": None,
        "ram_free_mb": None,
        "gpus": [],
    }
    if os.environ.get("LLAMACLUSTER_DEVICE"):
        info["device"] = os.environ["LLAMACLUSTER_DEVICE"]     # e.g. "Google Pixel 8" (Android app)
        info["android"] = True
    try:
        mem = {}
        with open("/proc/meminfo") as f:
            for line in f:
                k, v = line.split(":", 1)
                mem[k] = int(v.strip().split()[0])
        info["ram_total_mb"] = mem.get("MemTotal", 0) // 1024
        info["ram_free_mb"] = mem.get("MemAvailable", 0) // 1024
    except Exception:
        pass
    if shutil.which("nvidia-smi"):
        try:
            out = subprocess.check_output(
                ["nvidia-smi", "--query-gpu=name,memory.total,memory.used",
                 "--format=csv,noheader,nounits"], timeout=5, text=True)
            for line in out.strip().splitlines():
                n, t, u = [x.strip() for x in line.split(",")]
                info["gpus"].append({"name": n, "vram_total_mb": int(t), "vram_used_mb": int(u)})
        except Exception:
            pass
    return info


def local_ips():
    ips = set()
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(("10.255.255.255", 1))
        ips.add(s.getsockname()[0])
        s.close()
    except Exception:
        pass
    return sorted(ips)


# ------------------------------------------------------- GGUF header reader
# Reads just enough of a .gguf header (layer count, KV-head layout, trained
# context) for the controller to size context / GPU layers accurately.
_GGUF_FIXED = {0: "<B", 1: "<b", 2: "<H", 3: "<h", 4: "<I", 5: "<i", 6: "<f", 7: "<?",
               10: "<Q", 11: "<q", 12: "<d"}
_gguf_cache = {}


def _read_gguf(path):
    kv = {}
    with open(path, "rb", buffering=1 << 16) as f:
        if f.read(4) != b"GGUF":
            return {}
        ver, = struct.unpack("<I", f.read(4))
        if ver < 2:
            return {}
        _, n_kv = struct.unpack("<QQ", f.read(16))

        def rstr():
            n, = struct.unpack("<Q", f.read(8))
            if n > 1 << 24:
                raise ValueError("string too long")
            return f.read(n)

        def rval(t):
            if t == 8:
                return rstr().decode("utf8", "replace")
            if t == 9:
                et, n = struct.unpack("<IQ", f.read(12))
                if et in _GGUF_FIXED:
                    f.seek(n * struct.calcsize(_GGUF_FIXED[et]), 1)
                    return None
                if et == 8:
                    for _ in range(n):
                        rstr()
                    return None
                raise ValueError("nested array")
            fmt = _GGUF_FIXED[t]
            return struct.unpack(fmt, f.read(struct.calcsize(fmt)))[0]

        arch = None
        template = None
        in_tok = False
        for _ in range(n_kv):
            k = rstr().decode("utf8", "replace")
            if k.startswith("tokenizer."):
                in_tok = True    # architecture keys always precede the (huge) tokenizer arrays
            t, = struct.unpack("<I", f.read(4))
            if in_tok:
                try:             # only the chat template matters here; a parse problem must not lose the rest
                    v = rval(t)
                except Exception:
                    break
                if k == "tokenizer.chat_template" and isinstance(v, str):
                    template = v
                    break
                continue
            v = rval(t)
            if v is None:
                continue
            kv[k] = v
            if k == "general.architecture":
                arch = v
    if not arch:
        return {}
    g = lambda s: kv.get("%s.%s" % (arch, s))
    layers, n_embd, n_head = g("block_count"), g("embedding_length"), g("attention.head_count")
    n_kv_h = g("attention.head_count_kv") or n_head
    meta = {"arch": arch, "layers": layers, "n_embd": n_embd, "n_head": n_head,
            "n_head_kv": n_kv_h, "ctx_train": g("context_length")}
    if layers and n_embd and n_head and n_kv_h:
        klen = g("attention.key_length") or n_embd // n_head
        vlen = g("attention.value_length") or klen
        meta["kv_bytes_per_token"] = int(layers * n_kv_h * (klen + vlen) * 2)  # f16 cache
    r = reasoning_support(template)
    if r:
        meta["reasoning"] = r
    return {k: v for k, v in meta.items() if v}


def reasoning_support(template):
    """What the model's own chat template lets a request control about thinking.
    'effort' = template reads reasoning_effort (gpt-oss style: low / medium / high);
    'toggle' = template reads enable_thinking (Qwen3 style: on / off)."""
    if not template:
        return None
    if "reasoning_effort" in template:
        return {"kind": "effort", "levels": ["low", "medium", "high"]}
    if "enable_thinking" in template:
        return {"kind": "toggle"}
    return None


def is_mmproj(name, meta):
    """Vision projector files are .gguf too, but they are not models you can load on their own."""
    return (meta or {}).get("arch") == "clip" or "mmproj" in os.path.basename(name).lower()


_QUANT_RE = re.compile(r"[-_.](?:mmproj|q\d|iq\d|f16|bf16|f32|fp16|ud)", re.I)


def _model_base(name):
    """'Qwen2.5-VL-7B-Instruct-Q4_K_M.gguf' and 'Qwen2.5-VL-7B-Instruct-mmproj-F16.gguf' -> 'qwen2.5-vl-7b-instruct'"""
    n = os.path.basename(name)
    n = re.sub(r"\.gguf$", "", n, flags=re.I)
    return _QUANT_RE.split(n, 1)[0].lower()


def gguf_meta(path):
    try:
        st = os.stat(path)
        sig = (st.st_mtime, st.st_size)
        hit = _gguf_cache.get(path)
        if hit and hit[0] == sig:
            return hit[1]
        try:
            meta = _read_gguf(path)
        except Exception:
            meta = {}
        _gguf_cache[path] = (sig, meta)
        return meta
    except OSError:
        return {}


# ------------------------------------------------------------------ state
class Worker:
    def __init__(self, args):
        self.token = args.token
        self.models_dir = os.path.abspath(os.path.expanduser(args.models_dir))
        os.makedirs(self.models_dir, exist_ok=True)
        self.llama_port = args.llama_port
        self.rpc_port = args.rpc_port
        self.server_bin_hint = args.llama_server
        self.rpc_bin_hint = args.rpc_server
        self.name = args.name or socket.gethostname()
        self.hf_token = os.environ.get("HF_TOKEN") or None

        self.proc = None          # llama-server
        self.proc_cfg = None
        self.rpc_proc = None      # rpc-server
        self.logs = []            # ring buffer
        self.lock = threading.Lock()
        self.downloads = {}       # id -> dict
        self.dl_lock = threading.Lock()
        self.journal_path = os.path.join(self.models_dir, ".downloads.json")
        self.started_at = None
        self.inflight = 0
        self.bench_path = os.path.join(self.models_dir, ".bench.json")
        self.bench_job = {"running": False}
        self.bench_proc = None

    # --- logging
    def log(self, line):
        with self.lock:
            self.logs.append(line.rstrip("\n"))
            if len(self.logs) > 1500:
                del self.logs[:500]

    def _pump(self, proc, tag):
        for line in iter(proc.stdout.readline, ""):
            self.log(f"[{tag}] {line}")
        proc.stdout.close()

    # --- models
    def _scan(self):
        models, mmprojs = [], []
        for root, _, files in os.walk(self.models_dir):
            for f in files:
                if f.lower().endswith(".gguf"):
                    p = os.path.join(root, f)
                    name = os.path.relpath(p, self.models_dir)
                    meta = gguf_meta(p)
                    (mmprojs if is_mmproj(name, meta) else models).append({
                        "name": name,
                        "size_mb": round(os.path.getsize(p) / 1048576, 1),
                        "meta": meta,
                    })
        key = lambda m: m["name"].lower()
        return sorted(models, key=key), sorted(mmprojs, key=key)

    def list_models(self):
        return self._scan()[0]

    def list_mmprojs(self):
        return self._scan()[1]

    def pick_mmproj(self, model_name):
        """Auto-pick the projector that belongs to a model: same folder, same base name."""
        base = _model_base(model_name)
        folder = os.path.dirname(model_name)
        best = None
        for m in self.list_mmprojs():
            if os.path.dirname(m["name"]) != folder:
                continue
            b = _model_base(m["name"])
            if b and (b == base or base.startswith(b) or b.startswith(base)):
                if best is None or len(b) > len(_model_base(best)):
                    best = m["name"]
        return best

    def resolve_model(self, name):
        p = os.path.abspath(os.path.join(self.models_dir, name))
        if not p.startswith(self.models_dir + os.sep) or not os.path.isfile(p):
            raise ValueError(f"model not found: {name}")
        return p

    def delete_model(self, name):
        p = self.resolve_model(name)
        if self.proc_cfg and name in (self.proc_cfg.get("model"), self.proc_cfg.get("mmproj_used")) and self.is_running():
            raise ValueError("model is currently loaded; stop the server first")
        os.remove(p)
        self._jupdate(os.path.basename(p), _remove=True)
        res = self._bench_load()
        if res.pop(name, None) is not None:
            self._bench_save(res)

    # --- download journal: survives power cuts so downloads can resume after a reboot
    def _jload(self):
        try:
            with open(self.journal_path, encoding="utf8") as f:
                j = json.load(f)
            return j if isinstance(j, dict) else {}
        except (OSError, ValueError):
            return {}

    def _jupdate(self, fname, **kw):
        """Atomically merge fields into the journal entry for fname (kw value _DEL removes the entry)."""
        with self.dl_lock:
            j = self._jload()
            if kw.get("_remove"):
                j.pop(fname, None)
            else:
                e = j.setdefault(fname, {})
                e.update(kw)
                e["updated"] = int(time.time())
            tmp = self.journal_path + ".tmp"
            try:
                fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)   # holds node-copy tokens
                with os.fdopen(fd, "w", encoding="utf8") as f:
                    json.dump(j, f)
                    f.flush()
                    os.fsync(f.fileno())
                os.replace(tmp, self.journal_path)
            except OSError as e:
                self.log(f"[install] could not write download journal: {e}")

    @staticmethod
    def _fsync_dir(path):
        try:
            fd = os.open(path, os.O_RDONLY)
            try:
                os.fsync(fd)
            finally:
                os.close(fd)
        except OSError:
            pass          # not supported everywhere (Windows)

    @staticmethod
    def _is_gguf(path):
        try:
            with open(path, "rb") as f:
                return f.read(4) == b"GGUF"
        except OSError:
            return False

    def start_download(self, repo=None, filename=None, url=None, auth=None):
        url_given = bool(url)
        if not url:
            if not repo or not filename:
                raise ValueError("need repo+filename or url")
            url = "https://huggingface.co/%s/resolve/main/%s" % (
                repo.strip("/"), urllib.parse.quote(filename))
        elif not filename:
            filename = os.path.basename(urllib.parse.urlparse(url).path)
        if not filename.lower().endswith(".gguf"):
            raise ValueError("only .gguf files are supported")
        fname = os.path.basename(filename)
        if repo and not url_given and "mmproj" in fname.lower():
            # every vision repo ships a file called mmproj-F16.gguf: prefix the repo name so they don't overwrite each other
            rb = re.sub(r"[-_.]?gguf$", "", repo.strip("/").split("/")[-1], flags=re.I)
            if rb and not fname.lower().startswith(rb.lower()):
                fname = rb + "-" + fname
        dest = os.path.abspath(os.path.join(self.models_dir, fname))
        for d in self.downloads.values():       # already downloading this file: don't start a second writer
            if d["file"] == fname and d["state"] in ("running", "retrying"):
                return d["id"]
        did = "dl%d" % int(time.time() * 1000)
        d = {"id": did, "file": fname, "url": url, "done": 0, "total": 0, "state": "running",
             "error": None, "note": None, "retries": 0, "cancel": False, "auth": auth or None}
        self.downloads[did] = d
        old = self._jload().get(fname) or {}
        if old.get("url") != url:               # a leftover .part from a different source is useless
            try:
                os.remove(dest + ".part")
            except OSError:
                pass
            old = {}
        self._jupdate(fname, url=url, auth=auth or None, state="running",
                      total=old.get("total", 0), etag=old.get("etag"), synced=old.get("synced"))
        threading.Thread(target=self._download, args=(d, dest), daemon=True).start()
        return did

    def _download(self, d, dest):
        fname = d["file"]
        tmp = dest + ".part"
        wait, stalls = 2, 0
        try:
            while True:
                before = d["done"]
                try:
                    self._fetch_once(d, dest, tmp)
                    break
                except _Cancelled:
                    raise
                except _Fatal:
                    raise
                except Exception as e:           # network drop, timeout, 5xx... -> keep the .part and resume
                    if d["cancel"]:
                        raise _Cancelled()
                    if d["done"] > before:
                        stalls, wait = 0, 2
                    else:
                        stalls += 1
                    if stalls >= DL_MAX_STALLS:
                        raise _Fatal("gave up after %d attempts without progress: %s" % (stalls, e))
                    d["state"] = "retrying"
                    d["retries"] += 1
                    d["note"] = "%s - resuming in %ds" % (str(e)[:120], wait)
                    self.log(f"[install] {fname}: {e}; resuming from {d['done']} bytes in {wait}s")
                    for _ in range(wait):
                        if d["cancel"]:
                            raise _Cancelled()
                        time.sleep(1)
                    wait = min(wait * 2, DL_BACKOFF_MAX)
            d["state"] = "done"
            d["note"] = None
            self._jupdate(fname, state="done", total=d["done"], size=d["done"], synced=d["done"], auth=None)
            self.log(f"[install] downloaded {fname}")
        except _Cancelled:
            d["state"] = "error"
            d["error"] = "cancelled"
            self._jupdate(fname, _remove=True)
            try:
                os.remove(tmp)
            except OSError:
                pass
        except Exception as e:                   # fatal: keep nothing that can't be resumed
            d["state"] = "error"
            d["error"] = str(e)
            self.log(f"[install] failed {fname}: {e}")
            self._jupdate(fname, state="error", error=str(e), auth=None)
            try:
                os.remove(tmp)
            except OSError:
                pass

    def _fetch_once(self, d, dest, tmp):
        """One HTTP attempt. Resumes from the .part file with a Range request."""
        fname = d["file"]
        j = self._jload().get(fname) or {}
        have = os.path.getsize(tmp) if os.path.exists(tmp) else 0
        if d["done"] == 0 and have:
            # first attempt this process run (e.g. after a reboot): only trust bytes that were fsynced
            synced = j.get("synced")
            if synced is None:
                synced = max(0, have - DL_ORPHAN_TRIM)
            if have > synced:
                with open(tmp, "r+b") as f:
                    f.truncate(synced)
                have = synced
        headers = {"User-Agent": "llamacluster/" + VERSION}
        if have:
            headers["Range"] = "bytes=%d-" % have
            et = j.get("etag")
            if et and not et.startswith("W/"):
                headers["If-Range"] = et
        req = urllib.request.Request(d["url"], headers=headers)
        if d.get("auth"):          # node-to-node copy: the source worker's token
            req.add_header("Authorization", "Bearer " + d["auth"])
        elif self.hf_token and "huggingface.co" in d["url"]:
            req.add_header("Authorization", "Bearer " + self.hf_token)
        d["state"] = "running"
        d["note"] = None
        try:
            r = urllib.request.urlopen(req, timeout=60)
        except urllib.error.HTTPError as e:
            if e.code == 416 and have:           # our .part is as long as (or longer than) the file
                if j.get("total") and have == j["total"]:
                    d["done"] = have
                    return self._finish(d, dest, tmp)
                os.remove(tmp)                   # can't trust it: start over
                d["done"] = 0
                raise RuntimeError("partial file did not match the server; restarting from 0")
            if 400 <= e.code < 500 and e.code not in (408, 429):
                raise _Fatal("HTTP %d %s" % (e.code, e.reason))
            raise
        with r:
            if r.status == 206:
                cr = r.headers.get("Content-Range") or ""      # bytes START-END/TOTAL
                try:
                    start = int(cr.split()[1].split("-")[0])
                    total = int(cr.rsplit("/", 1)[1])
                except (IndexError, ValueError):
                    start, total = have, have + int(r.headers.get("Content-Length") or 0)
                if start != have:
                    raise RuntimeError("server resumed at %d, expected %d" % (start, have))
                mode = "ab"
            else:                                # 200: no resume support or the file changed -> from the start
                total = int(r.headers.get("Content-Length") or 0)
                have, mode = 0, "wb"
                self._jupdate(fname, etag=r.headers.get("ETag"), synced=0)
            d["total"] = total
            d["done"] = have
            self._jupdate(fname, total=total)
            last_sync = have
            with open(tmp, mode) as f:
                try:
                    while True:
                        if d["cancel"]:
                            raise _Cancelled()
                        chunk = r.read(1 << 20)
                        if not chunk:
                            break
                        f.write(chunk)
                        d["done"] += len(chunk)
                        if d["done"] - last_sync >= DL_SYNC_EVERY:
                            f.flush()
                            os.fsync(f.fileno())
                            last_sync = d["done"]
                            self._jupdate(fname, synced=last_sync)
                finally:
                    f.flush()
        if d["total"] and d["done"] != d["total"]:
            raise RuntimeError("connection dropped at %d of %d bytes" % (d["done"], d["total"]))
        self._finish(d, dest, tmp)

    def _finish(self, d, dest, tmp):
        with open(tmp, "r+b") as f:
            os.fsync(f.fileno())
        if not self._is_gguf(tmp):
            raise _Fatal("downloaded file is not a GGUF model (bad header)")
        os.replace(tmp, dest)
        self._fsync_dir(os.path.dirname(dest))

    def recover_downloads(self):
        """Run at startup: resume downloads cut short by a reboot, re-download finished-but-broken files."""
        j = self._jload()
        for fname, e in list(j.items()):
            dest = os.path.join(self.models_dir, fname)
            try:
                if e.get("state") in ("running", "retrying") and e.get("url"):
                    self.log(f"[install] resuming interrupted download of {fname}")
                    self.start_download(url=e["url"], filename=fname, auth=e.get("auth"))
                elif e.get("state") == "done":
                    if not os.path.exists(dest):
                        self._jupdate(fname, _remove=True)          # user deleted it on purpose
                    elif os.path.getsize(dest) != e.get("size") or not self._is_gguf(dest):
                        self.log(f"[install] {fname} is damaged (size/header mismatch) - downloading it again")
                        os.remove(dest)
                        self.start_download(url=e["url"], filename=fname, auth=e.get("auth"))
            except Exception as ex:
                self.log(f"[install] could not recover {fname}: {ex}")
        # partial files with no journal entry (from before this feature): tell the user
        for f in os.listdir(self.models_dir):
            if f.endswith(".gguf.part") and f[:-5] not in j:
                self.log(f"[install] found {f} with no recorded source - start the same download again to resume it")

    # --- llama-server
    def is_running(self):
        return self.proc is not None and self.proc.poll() is None

    def _server_cmd(self, cfg, port):
        """llama-server command line for a config; returns (cmd, projector name or '')."""
        binp = find_binary("llama-server", self.server_bin_hint)
        if not binp:
            raise ValueError("llama-server not found. Run install-llama.sh or pass --llama-server")
        model = self.resolve_model(cfg["model"])
        cmd = [binp, "-m", model, "--host", "127.0.0.1", "--port", str(port)]
        if cfg.get("ctx_size"):      cmd += ["-c", str(int(cfg["ctx_size"]))]
        if cfg.get("gpu_layers") not in (None, ""): cmd += ["-ngl", str(int(cfg["gpu_layers"]))]
        if cfg.get("threads"):       cmd += ["-t", str(int(cfg["threads"]))]
        if cfg.get("parallel"):      cmd += ["-np", str(int(cfg["parallel"]))]
        if cfg.get("batch_size"):    cmd += ["-b", str(int(cfg["batch_size"]))]
        if cfg.get("ubatch_size"):   cmd += ["-ub", str(int(cfg["ubatch_size"]))]
        rpc = cfg.get("rpc") or []
        if rpc:
            cmd += ["--rpc", ",".join(rpc)]
        extra = (cfg.get("extra_args") or "").strip()
        mm_used = ""
        want = (cfg.get("mmproj") or "").strip()
        if not re.search(r"(^|\s)(--mmproj|-mm|--no-mmproj|-hf|--hf-repo)(\s|=|$)", extra) and want.lower() != "none":
            mm_name = want if want and want.lower() != "auto" else self.pick_mmproj(cfg["model"])
            if mm_name:
                cmd += ["--mmproj", self.resolve_model(mm_name)]
                mm_used = mm_name
            elif want:
                raise ValueError("no vision projector (mmproj) found for this model")
        if "--jinja" not in extra and "--no-jinja" not in extra:
            cmd += ["--jinja"]   # model's own chat template; required for tool calling on older llama.cpp
        if extra:
            import shlex
            cmd += shlex.split(extra)
        return cmd, mm_used

    def start_server(self, cfg):
        if self.is_running():
            raise ValueError("server already running; stop it first")
        if self.bench_job.get("running"):
            raise ValueError("a benchmark is running; wait for it or cancel it")
        cmd, mm_used = self._server_cmd(cfg, self.llama_port)
        if mm_used:
            self.log("[worker] vision: using projector " + mm_used)
        self.log("[worker] exec: " + " ".join(cmd))
        self.proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                                     text=True, bufsize=1, start_new_session=True)
        self.proc_cfg = dict(cfg)
        self.proc_cfg["mmproj_used"] = mm_used
        self.started_at = time.time()
        threading.Thread(target=self._pump, args=(self.proc, "llama"), daemon=True).start()

    # --- benchmark: load each model with its settings, time one generation, unload
    _BENCH_PROMPT = ("The quick brown fox jumps over the lazy dog. " * 12) + "Write a long story about a lighthouse keeper:"

    def _bench_load(self):
        try:
            with open(self.bench_path) as f:
                return json.load(f)
        except (OSError, ValueError):
            return {}

    def _bench_save(self, j):
        tmp = self.bench_path + ".tmp"
        with open(tmp, "w") as f:
            json.dump(j, f)
        os.replace(tmp, self.bench_path)

    def bench_results(self):
        """Saved results, minus models that were deleted or replaced since."""
        out = {}
        for name, e in self._bench_load().items():
            try:
                st = os.stat(self.resolve_model(name))
            except (OSError, ValueError):
                continue
            if e.get("sig") == [st.st_size, int(st.st_mtime)]:
                out[name] = {k: v for k, v in e.items() if k != "sig"}
        return out

    def start_bench(self, jobs):
        if self.is_running():
            raise ValueError("stop the model server first - a benchmark needs the memory and loads each model itself")
        if self.bench_job.get("running"):
            raise ValueError("a benchmark is already running")
        if not find_binary("llama-server", self.server_bin_hint):
            raise ValueError("llama-server not found. Run install-llama.sh or pass --llama-server")
        jobs = [j for j in (jobs or []) if j.get("model")]
        if not jobs:
            raise ValueError("pick at least one model")
        for j in jobs:
            self.resolve_model(j["model"])
        self.bench_job = {"running": True, "cancel": False, "current": None, "done": 0, "total": len(jobs), "error": None}
        threading.Thread(target=self._bench_run, args=(jobs,), daemon=True).start()

    def cancel_bench(self):
        if self.bench_job.get("running"):
            self.bench_job["cancel"] = True
            self._kill(self.bench_proc)

    def _bench_run(self, jobs):
        job = self.bench_job
        try:
            for j in jobs:
                if job["cancel"]:
                    break
                job["current"] = j["model"]
                entry = self._bench_one(j)
                if job["cancel"]:
                    break
                try:
                    st = os.stat(self.resolve_model(j["model"]))
                    entry["sig"] = [st.st_size, int(st.st_mtime)]
                    res = self._bench_load()
                    res[j["model"]] = entry
                    self._bench_save(res)
                except (OSError, ValueError):
                    pass
                job["done"] += 1
        except Exception as e:
            job["error"] = f"{type(e).__name__}: {e}"
        finally:
            self._kill(self.bench_proc)
            self.bench_proc = None
            job["running"] = False
            job["current"] = None

    def _bench_one(self, j):
        cfg = {k: v for k, v in j.items() if k != "rpc"}
        cfg["parallel"] = 1                      # single-stream speed
        with socket.socket() as sk:              # a free port, so it never clashes with the real server
            sk.bind(("127.0.0.1", 0))
            port = sk.getsockname()[1]
        t0 = time.time()
        try:
            cmd, _ = self._server_cmd(cfg, port)
        except ValueError as e:
            return {"error": str(e), "at": int(t0)}
        self.log("[bench] " + " ".join(cmd))
        proc = self.bench_proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                                                  text=True, bufsize=1, start_new_session=True)
        threading.Thread(target=self._pump, args=(proc, "bench"), daemon=True).start()
        base = {"at": int(t0), "ngl": cfg.get("gpu_layers"), "ctx": cfg.get("ctx_size"), "threads": cfg.get("threads")}
        try:
            deadline = t0 + 900
            while True:                          # wait until the model has loaded
                if self.bench_job["cancel"]:
                    return {"error": "cancelled", **base}
                if proc.poll() is not None:
                    tail = [l for l in self.logs[-12:] if "[bench]" in l][-3:]
                    return {"error": "llama-server exited while loading (out of memory? lower GPU layers) " + " | ".join(tail)[-300:], **base}
                if time.time() > deadline:
                    return {"error": "timed out loading the model", **base}
                try:
                    c = http.client.HTTPConnection("127.0.0.1", port, timeout=2)
                    c.request("GET", "/health")
                    ok = c.getresponse().status == 200
                    c.close()
                    if ok:
                        break
                except Exception:
                    pass
                time.sleep(1)

            def gen(n):
                c = http.client.HTTPConnection("127.0.0.1", port, timeout=600)
                body = json.dumps({"prompt": self._BENCH_PROMPT, "n_predict": n, "temperature": 0,
                                   "cache_prompt": False, "ignore_eos": True, "stream": False})
                c.request("POST", "/completion", body=body, headers={"Content-Type": "application/json"})
                r = c.getresponse()
                data = json.loads(r.read() or b"{}")
                c.close()
                if r.status != 200:
                    raise ValueError((data.get("error") or {}).get("message", "HTTP %d" % r.status) if isinstance(data.get("error"), dict) else str(data.get("error") or r.status))
                return data.get("timings") or {}
            gen(8)                               # warm-up (first run compiles kernels / pages the file in)
            tm = gen(96)
            tps = tm.get("predicted_per_second")
            if not tps:
                return {"error": "the server returned no timings", **base}
            return {"tps": round(float(tps), 2), "pp": round(float(tm.get("prompt_per_second") or 0), 1), **base}
        except Exception as e:
            return {"error": f"{type(e).__name__}: {e}"[:300], **base}
        finally:
            self._kill(proc)

    def stop_server(self):
        self._kill(self.proc)
        self.proc = None
        self.started_at = None

    def server_health(self):
        if not self.is_running():
            return "stopped"
        try:
            c = http.client.HTTPConnection("127.0.0.1", self.llama_port, timeout=2)
            c.request("GET", "/health")
            r = c.getresponse()
            body = r.read()
            c.close()
            if r.status == 200:
                return "ready"
            return "loading"
        except Exception:
            return "loading"

    # --- rpc-server (for splitting one model over several machines)
    def start_rpc(self, cfg):
        if self.rpc_proc and self.rpc_proc.poll() is None:
            raise ValueError("rpc-server already running")
        binp = find_binary("rpc-server", self.rpc_bin_hint)
        if not binp:
            raise ValueError("rpc-server not found (build llama.cpp with -DGGML_RPC=ON)")
        cmd = [binp, "-H", "0.0.0.0", "-p", str(self.rpc_port)]
        if cfg.get("threads"):
            cmd += ["-t", str(int(cfg["threads"]))]
        self.log("[worker] exec: " + " ".join(cmd))
        self.rpc_proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                                         text=True, bufsize=1, start_new_session=True)
        threading.Thread(target=self._pump, args=(self.rpc_proc, "rpc"), daemon=True).start()

    def stop_rpc(self):
        self._kill(self.rpc_proc)
        self.rpc_proc = None

    @staticmethod
    def _kill(p):
        if p and p.poll() is None:
            try:
                os.killpg(p.pid, signal.SIGTERM)
                p.wait(timeout=8)
            except Exception:
                try:
                    os.killpg(p.pid, signal.SIGKILL)
                except Exception:
                    pass

    # --- status
    def status(self):
        models, mmprojs = self._scan()
        return {
            "name": self.name,
            "version": VERSION,
            "hardware": hardware_info(),
            "ips": local_ips(),
            "llama_server_found": bool(find_binary("llama-server", self.server_bin_hint)),
            "rpc_server_found": bool(find_binary("rpc-server", self.rpc_bin_hint)),
            "server": {
                "state": self.server_health(),
                "config": self.proc_cfg if self.is_running() else None,
                "uptime_s": int(time.time() - self.started_at) if self.started_at and self.is_running() else 0,
                "inflight": self.inflight,
                "vision": bool(self.is_running() and ((self.proc_cfg or {}).get("mmproj_used")
                               or re.search(r"(^|\s)(--mmproj|-mm)(\s|=)", (self.proc_cfg or {}).get("extra_args") or ""))),
            },
            "rpc": {"running": bool(self.rpc_proc and self.rpc_proc.poll() is None), "port": self.rpc_port},
            "models": models,
            "mmprojs": mmprojs,
            "bench": self.bench_results(),
            "bench_job": {k: v for k, v in self.bench_job.items() if k != "cancel"},
            "downloads": [{k: v for k, v in d.items() if k not in ("cancel", "auth")} for d in self.downloads.values()],
        }


W = None


# ------------------------------------------------------------------- HTTP
class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, *a):
        pass

    # auth
    def _authed(self):
        if not W.token:
            return True
        h = self.headers.get("Authorization", "")
        return h == "Bearer " + W.token

    def _json(self, code, obj):
        data = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def _body(self):
        n = int(self.headers.get("Content-Length") or 0)
        if not n:
            return {}
        return json.loads(self.rfile.read(n) or b"{}")

    def do_GET(self):
        self._route("GET")

    def do_POST(self):
        self._route("POST")

    def do_DELETE(self):
        self._route("DELETE")

    def _route(self, method):
        path = urllib.parse.urlparse(self.path).path
        if path == "/ping":
            return self._json(200, {"ok": True, "name": W.name})
        if not self._authed():
            return self._json(401, {"error": "bad or missing token"})
        try:
            if path.startswith("/v1/") or path == "/health":
                return self._proxy(method)
            if path == "/api/status" and method == "GET":
                return self._json(200, W.status())
            if path == "/api/logs" and method == "GET":
                return self._json(200, {"lines": W.logs[-400:]})
            if path == "/api/start" and method == "POST":
                W.start_server(self._body())
                return self._json(200, {"ok": True})
            if path == "/api/stop" and method == "POST":
                W.stop_server()
                return self._json(200, {"ok": True})
            if path == "/api/rpc/start" and method == "POST":
                W.start_rpc(self._body())
                return self._json(200, {"ok": True})
            if path == "/api/rpc/stop" and method == "POST":
                W.stop_rpc()
                return self._json(200, {"ok": True})
            if path == "/api/models/file" and method == "GET":   # let other nodes copy a model from here
                name = (urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query).get("name") or [""])[0]
                fp = W.resolve_model(name)
                st = os.stat(fp)
                size = st.st_size
                etag = '"%x-%x"' % (size, int(st.st_mtime))
                start, end, code = 0, size - 1, 200
                rng = self.headers.get("Range") or ""
                ifr = self.headers.get("If-Range")
                if rng.startswith("bytes=") and (not ifr or ifr == etag):
                    try:
                        a, _, b = rng[6:].split(",")[0].partition("-")
                        if a == "":            # suffix range: last N bytes
                            start = max(0, size - int(b))
                        else:
                            start = int(a)
                            if b:
                                end = min(int(b), size - 1)
                        if start >= size or start > end:
                            self.send_response(416)
                            self.send_header("Content-Range", "bytes */%d" % size)
                            self.send_header("Content-Length", "0")
                            self.end_headers()
                            return
                        code = 206
                    except ValueError:
                        start, end = 0, size - 1
                length = end - start + 1
                self.send_response(code)
                self.send_header("Content-Type", "application/octet-stream")
                self.send_header("Accept-Ranges", "bytes")
                self.send_header("ETag", etag)
                if code == 206:
                    self.send_header("Content-Range", "bytes %d-%d/%d" % (start, end, size))
                self.send_header("Content-Length", str(length))
                self.end_headers()
                try:
                    with open(fp, "rb") as f:
                        f.seek(start)
                        left = length
                        while left > 0:
                            chunk = f.read(min(1 << 20, left))
                            if not chunk:
                                break
                            self.wfile.write(chunk)
                            left -= len(chunk)
                except (BrokenPipeError, ConnectionResetError):
                    pass
                return
            if path == "/api/bench/start" and method == "POST":
                W.start_bench(self._body().get("jobs"))
                return self._json(200, {"ok": True})
            if path == "/api/bench/cancel" and method == "POST":
                W.cancel_bench()
                return self._json(200, {"ok": True})
            if path == "/api/models/install" and method == "POST":
                b = self._body()
                did = W.start_download(b.get("repo"), b.get("filename"), b.get("url"), b.get("auth"))
                return self._json(200, {"ok": True, "id": did})
            if path == "/api/models/cancel" and method == "POST":
                d = W.downloads.get(self._body().get("id"))
                if d:
                    d["cancel"] = True
                return self._json(200, {"ok": True})
            if path == "/api/models/delete" and method == "POST":
                W.delete_model(self._body().get("name", ""))
                return self._json(200, {"ok": True})
            return self._json(404, {"error": "not found"})
        except ValueError as e:
            return self._json(400, {"error": str(e)})
        except Exception as e:
            return self._json(500, {"error": f"{type(e).__name__}: {e}"})

    def _proxy(self, method):
        if W.server_health() != "ready":
            return self._json(503, {"error": "llama-server is not ready on this node"})
        body = None
        n = int(self.headers.get("Content-Length") or 0)
        if n:
            body = self.rfile.read(n)
        W.inflight += 1
        try:
            c = http.client.HTTPConnection("127.0.0.1", W.llama_port, timeout=600)
            hdrs = {"Content-Type": self.headers.get("Content-Type", "application/json")}
            c.request(method, self.path, body=body, headers=hdrs)
            r = c.getresponse()
            self.send_response(r.status)
            ct = r.getheader("Content-Type", "application/json")
            self.send_header("Content-Type", ct)
            self.send_header("Cache-Control", "no-cache")
            self.send_header("Connection", "close")
            self.end_headers()
            self.close_connection = True
            while True:
                chunk = r.read(1024) if "event-stream" in ct else r.read(65536)
                if not chunk:
                    break
                self.wfile.write(chunk)
                self.wfile.flush()
            c.close()
        except (BrokenPipeError, ConnectionResetError):
            pass
        finally:
            W.inflight -= 1


def kill_orphans(native_dir):
    """Android: if the app was killed, llama-server / rpc-server children can outlive it (they hold GBs of RAM).
    Kill any process running one of our bundled binaries whose parent is no longer this app."""
    if not native_dir or not os.path.isdir("/proc"):
        return
    mine = os.getpid()
    for pid in os.listdir("/proc"):
        if not pid.isdigit() or int(pid) == mine:
            continue
        try:
            with open("/proc/%s/cmdline" % pid, "rb") as f:
                exe = f.read().split(b"\0")[0].decode("utf8", "replace")
            if not exe.startswith(native_dir.rstrip("/") + "/lib"):
                continue
            with open("/proc/%s/stat" % pid) as f:
                ppid = int(f.read().rsplit(")", 1)[1].split()[1])
            if ppid != mine:
                os.kill(int(pid), signal.SIGKILL)
        except (OSError, ValueError, IndexError):
            pass


_SRV = None


def serve(args, install_signals=True):
    """Start the worker HTTP server. Blocks until stop() is called (or forever when run from the shell)."""
    global W, _SRV
    W = Worker(args)
    _SRV = ThreadingHTTPServer((args.host, args.port), Handler)
    _SRV.daemon_threads = True
    print(f"[worker] '{W.name}' listening on {args.host}:{args.port} "
          f"(token {'set' if W.token else 'NOT set'}), models in {W.models_dir}", flush=True)
    if install_signals:
        def bye(*_):
            W.stop_server(); W.stop_rpc(); os._exit(0)
        signal.signal(signal.SIGINT, bye)
        signal.signal(signal.SIGTERM, bye)
    threading.Thread(target=W.recover_downloads, daemon=True).start()
    _SRV.serve_forever()


def stop():
    """Stop the HTTP server and both child processes (used by the Android app)."""
    if W:
        W.stop_server()
        W.stop_rpc()
    if _SRV:
        _SRV.shutdown()
        _SRV.server_close()


def main():
    ap = argparse.ArgumentParser(description="LlamaCluster worker agent")
    ap.add_argument("--host", default="0.0.0.0")
    ap.add_argument("--port", type=int, default=7860)
    ap.add_argument("--token", default=os.environ.get("LLAMACLUSTER_TOKEN", ""),
                    help="shared secret (strongly recommended; required if exposed to the internet)")
    ap.add_argument("--name", default="")
    ap.add_argument("--models-dir", default=os.environ.get("LLAMACLUSTER_MODELS", "~/llamacluster-models"))
    ap.add_argument("--llama-server", default=os.environ.get("LLAMA_SERVER_BIN", ""))
    ap.add_argument("--rpc-server", default=os.environ.get("LLAMA_RPC_BIN", ""))
    ap.add_argument("--llama-port", type=int, default=8080)
    ap.add_argument("--rpc-port", type=int, default=50052)
    args = ap.parse_args()
    serve(args)


if __name__ == "__main__":
    main()
