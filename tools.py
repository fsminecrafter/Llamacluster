"""LlamaCluster chat tools - everything here runs on the machine that runs controller.py.

* web_search   - searches from this computer (SearXNG if configured, else DuckDuckGo HTML, else Bing HTML)
* fetch_url    - downloads a page and returns readable text (public hosts only unless allowed)
* list_files / read_file / search_files / write_file / edit_file / delete_file - confined to the workspace folder
* exec_command  - runs a shell command (cwd = workspace by default); disabled with --no-exec
* calculate / convert_units / date_time - optional computation tools; each is a checkbox in Workspace -> Tools.
* spawn - an optional page-side tool that delegates work to ready model nodes.
* runweb - an optional Playwright-backed browser runner for workspace HTML files.
* approval_reason() decides, for the chat's permission level (manual / semi / uncontrolled), whether a call needs
  the user's OK first.

Pure standard library.
"""
import base64
import http.client
import glob as _glob
import ipaddress
import json
import os
import re
import shlex
import shutil
import signal
import socket
import subprocess
import threading
import urllib.error
import urllib.parse
import urllib.request
import zipfile
from html.parser import HTMLParser

import calc
import extra_tools

WORKSPACE = os.path.expanduser("~/llamacluster-workspace")
SEARXNG = ""            # e.g. http://127.0.0.1:8888  (JSON output must be enabled in SearXNG)
ALLOW_PRIVATE = False   # allow fetch_url to reach LAN / localhost addresses
MAX_READ = 200_000
MAX_WRITE = 1_000_000
EXEC_ENABLED = True
EXEC_HEAD = 30_000      # characters of command output kept from the start ...
EXEC_TAIL = 10_000      # ... and from the end
UA = "Mozilla/5.0 (X11; Linux x86_64; rv:128.0) Gecko/20100101 Firefox/128.0 LlamaCluster/0.2"


class ToolError(Exception):
    pass


def configure(workspace=None, searxng=None, allow_private=None, exec_enabled=None, safe_commands=None):
    global WORKSPACE, SEARXNG, ALLOW_PRIVATE, EXEC_ENABLED
    if exec_enabled is not None:
        EXEC_ENABLED = bool(exec_enabled)
    if safe_commands:
        SAFE_COMMANDS.update(c.strip() for c in safe_commands if c.strip())
    if workspace:
        WORKSPACE = os.path.abspath(os.path.expanduser(workspace))
    if searxng is not None:
        SEARXNG = searxng.rstrip("/")
    if allow_private is not None:
        ALLOW_PRIVATE = allow_private
    os.makedirs(WORKSPACE, exist_ok=True)


# ------------------------------------------------------------ workspace files
def ws_path(rel):
    """Resolve a workspace-relative path; refuses anything that escapes the root (incl. via symlinks)."""
    root = os.path.realpath(WORKSPACE)
    rel = (rel or ".").replace("\\", "/").strip().lstrip("/")
    p = os.path.realpath(os.path.join(root, rel))
    if p != root and not p.startswith(root + os.sep):
        raise ToolError("path is outside the workspace")
    return root, p


def _rel(root, p):
    return os.path.relpath(p, root).replace(os.sep, "/")


def list_files(path=".", recursive=False):
    root, p = ws_path(path)
    if not os.path.isdir(p):
        raise ToolError("not a directory: " + str(path))
    out = []
    if recursive:
        for d, dirs, files in os.walk(p):
            dirs[:] = sorted(x for x in dirs if not x.startswith("."))
            for f in sorted(files):
                fp = os.path.join(d, f)
                out.append({"path": _rel(root, fp), "type": "file", "size": os.path.getsize(fp)})
                if len(out) >= 500:
                    return {"entries": out, "truncated": True}
    else:
        for f in sorted(os.listdir(p)):
            fp = os.path.join(p, f)
            isd = os.path.isdir(fp)
            out.append({"path": _rel(root, fp), "type": "dir" if isd else "file",
                        "size": None if isd else os.path.getsize(fp)})
    return {"entries": out}


def read_file(path, start_line=1, end_line=None):
    _, p = ws_path(path)
    if not os.path.isfile(p):
        raise ToolError("no such file: " + str(path))
    if os.path.getsize(p) > 20 * MAX_READ:
        raise ToolError("file too large to read")
    with open(p, "rb") as f:
        raw = f.read()
    if b"\x00" in raw[:4096]:
        raise ToolError("binary file")
    text = raw.decode("utf8", "replace")
    lines = text.split("\n")
    total = len(lines)
    s = max(1, int(start_line or 1))
    e = min(total, int(end_line)) if end_line else total
    chunk = "\n".join(lines[s - 1:e])
    truncated = False
    if len(chunk) > MAX_READ:
        chunk, truncated = chunk[:MAX_READ], True
    return {"path": path, "total_lines": total, "start_line": s, "content": chunk, "truncated": truncated}


def write_file(path, content):
    if not isinstance(content, str):
        raise ToolError("content must be a string")
    if len(content.encode("utf8")) > MAX_WRITE:
        raise ToolError("content too large")
    root, p = ws_path(path)
    if p == root or os.path.isdir(p):
        raise ToolError("path is a directory")
    existed = os.path.exists(p)
    os.makedirs(os.path.dirname(p), exist_ok=True)
    with open(p, "w", encoding="utf8", newline="") as f:
        f.write(content)
    return {"path": _rel(root, p), "bytes": len(content.encode("utf8")), "created": not existed}


def edit_file(path, old_str, new_str, replace_all=False):
    _, p = ws_path(path)
    if not os.path.isfile(p):
        raise ToolError("no such file: " + str(path))
    with open(p, encoding="utf8", newline="") as f:
        text = f.read()
    n = text.count(old_str) if old_str else 0
    if n == 0:
        raise ToolError("old_str not found (it must match the file exactly, including whitespace)")
    if n > 1 and not replace_all:
        raise ToolError("old_str matches %d places; add more context or set replace_all" % n)
    text = text.replace(old_str, new_str) if replace_all else text.replace(old_str, new_str, 1)
    with open(p, "w", encoding="utf8", newline="") as f:
        f.write(text)
    return {"path": path, "replaced": n if replace_all else 1}


def delete_file(path):
    root, p = ws_path(path)
    if p == root:
        raise ToolError("cannot delete the workspace root")
    if not os.path.isfile(p):
        raise ToolError("no such file (only files can be deleted): " + str(path))
    os.remove(p)
    return {"deleted": _rel(root, p)}


def search_files(pattern, path=".", glob="", ignore_case=False, max_results=100):
    """Regex search through the text files under a workspace folder (like grep -rn)."""
    if not pattern:
        raise ToolError("empty pattern")
    try:
        rx = re.compile(pattern, re.I if ignore_case else 0)
    except re.error as e:
        raise ToolError("bad regex: %s" % e)
    root, p = ws_path(path)
    limit = max(1, min(int(max_results or 100), 300))
    if os.path.isfile(p):
        walk = [(os.path.dirname(p), [], [os.path.basename(p)])]
    elif os.path.isdir(p):
        walk = os.walk(p)
    else:
        raise ToolError("no such path: " + str(path))
    import fnmatch
    out, scanned, truncated = [], 0, False
    for d, dirs, files in walk:
        dirs[:] = sorted(x for x in dirs if not x.startswith("."))
        for f in sorted(files):
            if glob and not fnmatch.fnmatch(f, glob):
                continue
            fp = os.path.join(d, f)
            try:
                if os.path.getsize(fp) > 2_000_000:
                    continue
                with open(fp, "rb") as fh:
                    raw = fh.read()
            except OSError:
                continue
            if b"\x00" in raw[:4096]:
                continue
            scanned += 1
            for n, line in enumerate(raw.decode("utf8", "replace").split("\n"), 1):
                if rx.search(line):
                    out.append({"path": _rel(root, fp), "line": n, "text": line.strip()[:300]})
                    if len(out) >= limit:
                        truncated = True
                        break
            if truncated:
                break
        if truncated:
            break
    return {"matches": out, "files_searched": scanned, "truncated": truncated}


# ------------------------------------------------------------- exec_command
class _Capture:
    """Reads a process' output without ever holding more than head+tail in memory."""

    def __init__(self, stream):
        self.head, self.tail, self.total, self.lost = bytearray(), bytearray(), 0, 0
        self.t = threading.Thread(target=self._run, args=(stream,), daemon=True)
        self.t.start()

    def _run(self, stream):
        try:
            while True:
                b = stream.read1(65536) if hasattr(stream, "read1") else stream.read(65536)
                if not b:
                    break
                self.total += len(b)
                room = EXEC_HEAD - len(self.head)
                if room > 0:
                    self.head += b[:room]
                    b = b[room:]
                self.tail += b
                if len(self.tail) > EXEC_TAIL:
                    self.lost += len(self.tail) - EXEC_TAIL
                    del self.tail[:len(self.tail) - EXEC_TAIL]
        except (OSError, ValueError):
            pass

    def text(self):
        self.t.join(2)
        t = self.head.decode("utf8", "replace")
        if self.lost:
            t += "\n[... %d bytes omitted ...]\n" % self.lost
        return t + self.tail.decode("utf8", "replace")


def exec_command(command, cwd=".", timeout=30):
    if not EXEC_ENABLED:
        raise ToolError("command execution is disabled (controller started with --no-exec)")
    if not isinstance(command, str) or not command.strip():
        raise ToolError("empty command")
    root = os.path.realpath(WORKSPACE)
    c = os.path.realpath(os.path.join(root, os.path.expanduser(cwd or ".")))
    if not os.path.isdir(c):
        raise ToolError("cwd is not a directory: " + str(cwd))
    timeout = max(1, min(int(timeout or 30), 600))
    env = dict(os.environ, TERM="dumb", PAGER="cat", GIT_PAGER="cat", GIT_TERMINAL_PROMPT="0")
    env.pop("LLAMACLUSTER_CTRL_TOKEN", None)      # don't hand the controller's secret to the model's commands
    sh = shutil.which("bash") or "/bin/sh"
    try:
        p = subprocess.Popen([sh, "-c", command], cwd=c, env=env, stdin=subprocess.DEVNULL,
                             stdout=subprocess.PIPE, stderr=subprocess.STDOUT, start_new_session=True)
    except OSError as e:
        raise ToolError("could not start the command: %s" % e)
    cap = _Capture(p.stdout)
    timed_out = False
    try:
        p.wait(timeout=timeout)
    except subprocess.TimeoutExpired:
        timed_out = True
        try:
            os.killpg(p.pid, signal.SIGKILL)
        except OSError:
            p.kill()
        p.wait()
    out = cap.text()
    res = {"exit_code": p.returncode, "output": out, "cwd": c if c != root else ".", "timed_out": timed_out}
    if cap.lost:
        res["truncated"] = True
    if timed_out:
        res["note"] = "killed after %d s; raise 'timeout' (max 600) if it needs longer" % timeout
    return res


# ------------------------------------------------- permissions (manual / semi / uncontrolled)
PERMISSIONS = ("manual", "semi", "uncontrolled")

# Commands 'semi' runs without asking, as long as every path they touch stays inside the workspace.
# Nothing here can run other programs or code (no sh/python/node/make/xargs/env/sed/awk...).
# Extend with --safe-commands.
SAFE_COMMANDS = {
    "ls", "cat", "head", "tail", "wc", "grep", "egrep", "fgrep", "rg", "find", "sort", "uniq", "diff", "cmp",
    "echo", "printf", "pwd", "tree", "stat", "file", "du", "df", "which", "date", "basename", "dirname",
    "realpath", "readlink", "cut", "tr", "nl", "column", "md5sum", "sha1sum", "sha256sum", "uname", "whoami",
    "true", "false", "mkdir", "touch", "cp", "mv",
}
_BAD_FLAGS = {   # flags that turn an otherwise safe command into something that writes or runs code
    "find": ("-exec", "-execdir", "-ok", "-okdir", "-delete", "-fprint", "-fprint0", "-fprintf", "-fls"),
    "sort": ("-o", "--output", "--compress-program"),
    "tree": ("-o",),
    "date": ("-s", "--set"),
    "rg": ("--pre", "--hostname-bin"),
}
_OPS = {"|", "&&", "||", ";"}


def _inside(root, p):
    return p == root or p.startswith(root + os.sep)


def _path_outside(root, cwd, tok):
    """True if the path-like token could point outside the workspace."""
    if tok.startswith("~"):
        return True
    full = os.path.join(cwd, tok)
    if re.search(r"[*?\[]", tok):
        try:
            hits = _glob.glob(full)[:2000]
        except Exception:
            return True
        parts, pre = full.split(os.sep), []
        for x in parts:
            if re.search(r"[*?\[]", x):
                break
            pre.append(x)
        if not _inside(root, os.path.realpath(os.sep.join(pre) or os.sep)):
            return True
        return any(not _inside(root, os.path.realpath(h)) for h in hits)
    return not _inside(root, os.path.realpath(full))


def assess_command(command, cwd="."):
    """None if 'semi' may run it unasked, else the reason it needs approval."""
    root = os.path.realpath(WORKSPACE)
    c = os.path.realpath(os.path.join(root, os.path.expanduser(cwd or ".")))
    if not _inside(root, c):
        return "runs outside the workspace (" + c + ")"
    if re.search(r"[`$\\\n\r]", command):
        return "uses shell expansion, escapes or several lines"
    try:
        lx = shlex.shlex(command, posix=True, punctuation_chars=True)
        lx.whitespace_split = True
        toks = list(lx)
    except ValueError:
        return "could not parse the command"
    seg = []
    segs = [seg]
    for t in toks:
        if t and set(t) <= set("();<>|&"):
            if t not in _OPS:
                return "uses shell operator '%s' (redirects, background jobs, subshells)" % t
            seg = []
            segs.append(seg)
        else:
            seg.append(t)
    segs = [s for s in segs if s]
    if not segs:
        return "empty command"
    for s in segs:
        name = os.path.basename(s[0]) if "/" not in s[0] else None
        if name not in SAFE_COMMANDS:
            return "runs '%s', which is not on the safe-command list" % s[0]
        for a in s[1:]:
            if a in _BAD_FLAGS.get(name, ()) or any(a.startswith(f + "=") for f in _BAD_FLAGS.get(name, ()) if f.startswith("--")):
                return "'%s %s' can write files or run other programs" % (name, a)
            if a.startswith("-"):
                if "=" in a:
                    a = a.split("=", 1)[1]
                elif "/" in a or "~" in a:
                    return "has an option containing a path"
                else:
                    continue
            if _path_outside(root, c, a):       # every argument may be a path - also catches symlinks pointing out
                return "touches a path outside the workspace (%s)" % a
    return None


def approval_reason(name, args, permission):
    """Why this call needs the user's OK under the given permission level, or None to run it straight away."""
    if permission == "uncontrolled":
        return None
    if permission != "semi":          # 'manual' - and anything unrecognised - asks every time
        return "manual mode: every tool call needs your approval"
    if not isinstance(args, dict):
        return None                   # run() will reject it
    if name in ("runweb", "playwright"):
        return "runs workspace page code in a browser (it may access the network)"
    if name in ("web_search", "fetch_url", "list_files", "read_file", "search_files", "write_file", "edit_file",
                "calculate", "convert_units", "date_time", "question", "task"):     # pure functions / page-only tools
        return None
    if name == "delete_file":
        return "deletes a file"
    if name == "exec_command":
        return assess_command(str(args.get("command", "")), args.get("cwd") or ".")
    return "unknown tool"


def clear_workspace():
    """Delete everything inside the workspace folder (the folder itself stays). Symlinks are removed, never followed."""
    root = os.path.realpath(WORKSPACE)
    if root.count(os.sep) < 2 or root == os.path.realpath(os.path.expanduser("~")):
        raise ToolError("refusing to clear %s: it looks like a system or home folder, not a workspace" % root)
    removed, errors = 0, []

    def onerr(fn, p, exc):              # read-only files / folders: make writable and retry once
        try:
            os.chmod(os.path.dirname(p), 0o700)
            os.chmod(p, 0o700)
            fn(p)
        except OSError as e:
            errors.append("%s: %s" % (_rel(root, p), e.strerror or e))

    for name in os.listdir(root):
        p = os.path.join(root, name)
        try:
            if os.path.islink(p) or not os.path.isdir(p):
                os.unlink(p)
            else:
                shutil.rmtree(p, onerror=onerr)
            if not os.path.lexists(p):
                removed += 1
        except OSError as e:
            errors.append("%s: %s" % (name, e.strerror or e))
    return {"removed": removed, "errors": errors[:20]}


def workspace_listing():
    root = os.path.realpath(WORKSPACE)
    files = []
    for d, dirs, fs in os.walk(root):
        dirs[:] = sorted(x for x in dirs if not x.startswith("."))
        for f in sorted(fs):
            fp = os.path.join(d, f)
            try:
                files.append({"path": _rel(root, fp), "size": os.path.getsize(fp)})
            except OSError:
                pass
            if len(files) >= 1000:
                return {"root": root, "files": files, "truncated": True}
    return {"root": root, "files": files}


def write_workspace_zip(target):
    root = os.path.realpath(WORKSPACE)
    with zipfile.ZipFile(target, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=6) as archive:
        for folder, dirs, files in os.walk(root, followlinks=False):
            dirs[:] = sorted(d for d in dirs if not os.path.islink(os.path.join(folder, d)))
            for name in sorted(files):
                path = os.path.join(folder, name)
                if os.path.islink(path) or not os.path.isfile(path):
                    continue
                resolved = os.path.realpath(path)
                if resolved != root and not resolved.startswith(root + os.sep):
                    continue
                archive.write(path, os.path.relpath(path, root).replace(os.sep, "/"))
    return archive.namelist()


def _run_web(path, timeout=15, screenshot=False):
    _, fp = ws_path(path)
    if not os.path.isfile(fp):
        raise ToolError("no such file: " + str(path))
    if os.path.splitext(fp)[1].lower() not in (".html", ".htm"):
        raise ToolError("runweb only runs .html or .htm files")
    try:
        from playwright.sync_api import sync_playwright
    except ImportError:
        raise ToolError("runweb needs Playwright and its Chromium browser; install with: pip install -r requirements-web.txt && python -m playwright install chromium")

    timeout = max(1, min(int(timeout or 15), 30))
    console = []
    result = {"path": _rel(os.path.realpath(WORKSPACE), fp), "console": console}
    try:
        with sync_playwright() as p:
            browser = p.chromium.launch(headless=True)
            page = browser.new_page(viewport={"width": 1280, "height": 800}, device_scale_factor=1)
            page.on("console", lambda msg: console.append("%s: %s" % (msg.type, msg.text)) if len(console) < 200 else None)
            page.on("pageerror", lambda exc: console.append("error: %s" % exc) if len(console) < 200 else None)
            try:
                page.goto("file://" + urllib.parse.quote(fp), wait_until="load", timeout=timeout * 1000)
            except Exception as e:
                result["error"] = "page load: %s: %s" % (type(e).__name__, e)
            page.wait_for_timeout(250)
            result["title"] = page.title()
            if screenshot:
                result["screenshot"] = base64.b64encode(page.screenshot(type="jpeg", quality=65)).decode("ascii")
            browser.close()
    except Exception as e:
        raise ToolError("browser run failed: %s: %s" % (type(e).__name__, e))
    return result


# ------------------------------------------------------------------- web
def _check_public(host):
    if ALLOW_PRIVATE:
        return
    try:
        infos = socket.getaddrinfo(host, None)
    except socket.gaierror as e:
        raise ToolError("cannot resolve %s: %s" % (host, e))
    for info in infos:
        ip = ipaddress.ip_address(info[4][0].split("%")[0])
        if (ip.is_private or ip.is_loopback or ip.is_link_local or ip.is_reserved
                or ip.is_multicast or ip.is_unspecified):
            raise ToolError("refusing to fetch a private/local address (%s); start the controller with "
                            "--allow-private-fetch to permit this" % host)


class _SafeRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        u = urllib.parse.urlparse(newurl)
        if u.scheme not in ("http", "https"):
            raise ToolError("redirect to unsupported scheme")
        _check_public(u.hostname or "")
        return super().redirect_request(req, fp, code, msg, headers, newurl)


def _http(url, data=None, headers=None, timeout=15, check=True, limit=2_000_000):
    u = urllib.parse.urlparse(url)
    if u.scheme not in ("http", "https") or not u.hostname:
        raise ToolError("only http(s) URLs are supported")
    if check:
        _check_public(u.hostname)
    h = {"User-Agent": UA, "Accept-Language": "en", "Accept": "text/html,application/json,text/plain;q=0.9,*/*;q=0.5"}
    h.update(headers or {})
    req = urllib.request.Request(url, data=data, headers=h)
    opener = urllib.request.build_opener(_SafeRedirect() if check else urllib.request.HTTPRedirectHandler())
    try:
        with opener.open(req, timeout=timeout) as r:
            body = r.read(limit + 1)
            ct = r.headers.get("Content-Type", "")
            m = re.search(r"charset=([\w-]+)", ct)
            return r.geturl(), ct, body[:limit], (m.group(1) if m else "utf-8")
    except urllib.error.HTTPError as e:
        raise ToolError("HTTP %d from %s" % (e.code, u.hostname))
    except (urllib.error.URLError, socket.timeout, http.client.HTTPException, OSError) as e:
        raise ToolError("request failed: %s" % getattr(e, "reason", e))


class _Text(HTMLParser):
    SKIP = {"script", "style", "noscript", "svg", "head", "template", "iframe"}
    BLOCK = {"p", "div", "br", "li", "tr", "h1", "h2", "h3", "h4", "h5", "h6", "section", "article",
             "header", "footer", "ul", "ol", "table", "pre", "blockquote"}

    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.out, self.skip, self.title, self._in_title = [], 0, "", False

    def handle_starttag(self, tag, attrs):
        if tag == "title":
            self._in_title = True
        if tag in self.SKIP:
            self.skip += 1
        elif tag in self.BLOCK:
            self.out.append("\n")

    def handle_endtag(self, tag):
        if tag == "title":
            self._in_title = False
        if tag in self.SKIP and self.skip:
            self.skip -= 1
        elif tag in self.BLOCK:
            self.out.append("\n")

    def handle_data(self, d):
        if self._in_title:
            self.title += d
        if not self.skip:
            self.out.append(d)


def html_to_text(html):
    p = _Text()
    try:
        p.feed(html)
        p.close()
    except Exception:
        pass
    text = "".join(p.out)
    text = re.sub(r"[ \t\r\f\v]+", " ", text)
    text = re.sub(r" ?\n ?", "\n", text)
    text = re.sub(r"\n{3,}", "\n\n", text).strip()
    return p.title.strip(), text


def fetch_url(url, max_chars=8000):
    max_chars = max(500, min(int(max_chars or 8000), 40000))
    final, ct, body, cs = _http(url)
    try:
        s = body.decode(cs, "replace")
    except LookupError:
        s = body.decode("utf8", "replace")
    if "html" in ct.lower() or s.lstrip()[:15].lower().startswith(("<!doctype", "<html")):
        title, text = html_to_text(s)
    elif ct.lower().startswith("text/") or "json" in ct.lower() or "xml" in ct.lower():
        title, text = "", s
    else:
        raise ToolError("unsupported content type: " + (ct or "unknown"))
    cut = len(text) > max_chars
    return {"url": final, "title": title, "content": text[:max_chars], "truncated": cut, "total_chars": len(text)}


class _DDG(HTMLParser):
    """Parses html.duckduckgo.com result pages."""

    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.results, self._cur, self._mode = [], None, None

    def handle_starttag(self, tag, attrs):
        if tag != "a":
            return
        a = dict(attrs)
        cls = a.get("class") or ""
        if "result__a" in cls:
            self._cur = {"title": "", "url": _ddg_url(a.get("href", "")), "snippet": ""}
            self.results.append(self._cur)
            self._mode = "title"
        elif "result__snippet" in cls and self._cur is not None:
            self._mode = "snippet"

    def handle_endtag(self, tag):
        if tag == "a":
            self._mode = None

    def handle_data(self, d):
        if self._cur is not None and self._mode:
            self._cur[self._mode] += d


def _ddg_url(href):
    if href.startswith("//"):
        href = "https:" + href
    q = urllib.parse.urlparse(href)
    if "uddg" in urllib.parse.parse_qs(q.query):
        return urllib.parse.parse_qs(q.query)["uddg"][0]
    return href


class _Bing(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.results, self._cur, self._li, self._h2, self._a, self._p = [], None, False, False, False, False

    def handle_starttag(self, tag, attrs):
        a = dict(attrs)
        if tag == "li" and "b_algo" in (a.get("class") or ""):
            self._li, self._cur = True, {"title": "", "url": "", "snippet": ""}
            self.results.append(self._cur)
        elif self._li and tag == "h2":
            self._h2 = True
        elif self._li and self._h2 and tag == "a" and not self._cur["url"]:
            self._cur["url"] = _bing_url(a.get("href", ""))
            self._a = True
        elif self._li and tag == "p" and not self._cur["snippet"]:
            self._p = True

    def handle_endtag(self, tag):
        if tag == "h2":
            self._h2 = self._a = False
        elif tag == "p":
            self._p = False

    def handle_data(self, d):
        if self._cur is not None:
            if self._a:
                self._cur["title"] += d
            elif self._p:
                self._cur["snippet"] += d


def _bing_url(href):
    q = urllib.parse.parse_qs(urllib.parse.urlparse(href).query)
    u = (q.get("u") or [""])[0]
    if u.startswith("a1"):
        try:
            b = u[2:]
            return base64.urlsafe_b64decode(b + "=" * (-len(b) % 4)).decode("utf8")
        except Exception:
            pass
    return href


def _clean(results, n):
    out = []
    for r in results:
        t = re.sub(r"\s+", " ", r.get("title", "")).strip()
        u = r.get("url", "").strip()
        if t and u.startswith("http"):
            out.append({"title": t, "url": u, "snippet": re.sub(r"\s+", " ", r.get("snippet", "")).strip()[:400]})
        if len(out) >= n:
            break
    return out


def web_search(query, max_results=6):
    query = (query or "").strip()
    if not query:
        raise ToolError("empty query")
    n = max(1, min(int(max_results or 6), 10))
    errors = []
    if SEARXNG:
        try:
            _, _, body, _ = _http(SEARXNG + "/search?" + urllib.parse.urlencode({"q": query, "format": "json"}),
                                  check=False)
            res = [{"title": r.get("title"), "url": r.get("url"), "snippet": r.get("content", "")}
                   for r in json.loads(body).get("results", [])]
            res = _clean(res, n)
            if res:
                return {"engine": "searxng", "query": query, "results": res}
            errors.append("searxng: no results")
        except (ToolError, ValueError) as e:
            errors.append("searxng: %s" % e)
    try:
        _, _, body, cs = _http("https://html.duckduckgo.com/html/",
                               data=urllib.parse.urlencode({"q": query}).encode(),
                               headers={"Content-Type": "application/x-www-form-urlencoded"})
        p = _DDG()
        p.feed(body.decode("utf8", "replace"))
        res = _clean(p.results, n)
        if res:
            return {"engine": "duckduckgo", "query": query, "results": res}
        errors.append("duckduckgo: no results (possibly rate-limited)")
    except ToolError as e:
        errors.append("duckduckgo: %s" % e)
    try:
        _, _, body, cs = _http("https://www.bing.com/search?" + urllib.parse.urlencode({"q": query, "setlang": "en"}))
        p = _Bing()
        p.feed(body.decode("utf8", "replace"))
        res = _clean(p.results, n)
        if res:
            return {"engine": "bing", "query": query, "results": res}
        errors.append("bing: no results")
    except ToolError as e:
        errors.append("bing: %s" % e)
    raise ToolError("search failed (" + "; ".join(errors) + "). Run a local SearXNG and pass --searxng URL for reliable search.")


# --------------------------------------------------------------- registry
def _fn(group, name, desc, props, required, optional=None):
    """optional = {"title": ..., "blurb": ..., "default_on": bool} marks a tool the user can switch on/off
    individually in the UI (its group name is the switch)."""
    t = {"group": group, "type": "function",
         "function": {"name": name, "description": desc,
                      "parameters": {"type": "object", "properties": props, "required": required}}}
    if optional:
        t["optional"] = True
        t.update(optional)
    return t


S, I, B = {"type": "string"}, {"type": "integer"}, {"type": "boolean"}
N, O = {"type": "number"}, {"type": "object"}
TOOLS = [
    _fn("search", "web_search",
        "Search the web (run from the user's computer). Returns titles, URLs and snippets. Use fetch_url to read a result.",
        {"query": S, "max_results": {"type": "integer", "description": "1-10, default 6"}}, ["query"]),
    _fn("fetch", "fetch_url", "Download a web page and return its readable text.",
        {"url": S, "max_chars": {"type": "integer", "description": "default 8000, max 40000"}}, ["url"]),
    _fn("read", "list_files", "List files in the workspace folder (path is relative to the workspace root).",
        {"path": {"type": "string", "description": "directory, default '.'"}, "recursive": B}, []),
    _fn("read", "read_file", "Read a text file from the workspace, optionally a line range.",
        {"path": S, "start_line": I, "end_line": I}, ["path"]),
    _fn("read", "search_files",
        "Search file contents in the workspace with a regular expression (like grep -rn). Returns path, line number and text.",
        {"pattern": S, "path": {"type": "string", "description": "folder or file to search, default '.'"},
         "glob": {"type": "string", "description": "only files whose name matches, e.g. '*.py'"},
         "ignore_case": B, "max_results": {"type": "integer", "description": "default 100, max 300"}}, ["pattern"]),
    _fn("write", "write_file", "Create or overwrite a text file in the workspace (parent folders are created).",
        {"path": S, "content": S}, ["path", "content"]),
    _fn("write", "edit_file", "Replace exact text in a workspace file. old_str must match exactly once unless replace_all.",
        {"path": S, "old_str": S, "new_str": S, "replace_all": B}, ["path", "old_str", "new_str"]),
    _fn("write", "delete_file", "Delete a file from the workspace.", {"path": S}, ["path"]),
    _fn("exec", "exec_command",
        "Run a shell command on the user's computer (bash -c) and return its exit code and combined output. "
        "Runs in the workspace folder unless cwd is given. Not interactive (no stdin). Long-running commands are killed at the timeout. "
        "Prefer the file tools for reading and editing files.",
        {"command": S, "cwd": {"type": "string", "description": "working directory, relative to the workspace (default '.')"},
         "timeout": {"type": "integer", "description": "seconds, default 30, max 600"}}, ["command"]),

    # ---- optional tools
    _fn("calc", "calculate",
        "Advanced, safe calculator - use it for any non-trivial arithmetic or maths instead of working it out yourself. "
        "Syntax: + - * / // % ** (or ^), n!, parentheses, constants pi e tau phi inf, complex numbers like 3+4j, lists [1,2,3], "
        "matrices [[1,2],[3,4]] (use @ for matrix product), list comprehensions [k**2 for k in range(1,10)], and several "
        "statements separated by ';' with assignments (a = 3; a**2 + 1). "
        "Functions: sqrt cbrt exp ln log(x,base) log2 log10 sin cos tan asin acos atan atan2 sinh cosh tanh (radians) sind cosd tand "
        "degrees radians floor ceil round abs gamma erf hypot; sum prod mean median mode stdev variance percentile corr linfit; "
        "factorial comb perm gcd lcm fib isprime nextprime prevprime factor divisors totient pow(a,b,m) modinv isqrt tobase; "
        "dot cross norm det inv rank trace transpose identity solve_linear eigvals polyroots. "
        "Numeric calculus - the expression goes in quotes, default variable x: diff('x**3', 2) | diff('x**3', 2, 2) | "
        "integrate('exp(-x**2)', -inf, inf) | solve('cos(x) - x', 0.5) (Newton) | solve('x**2 - 4', -5, 5) (all roots in range) | "
        "limit('sin(x)/x', 0) | sumto('1/n**2', 'n', 1, inf) | prodto('k', 'k', 1, 10); add var='t' for another variable name. "
        "exact=true gives exact fractions and big integers (1/3 + 1/6 = 1/2); precision sets the number of digits shown.",
        {"expression": {"type": "string", "description": "the expression or ';'-separated statements"},
         "exact": {"type": "boolean", "description": "exact rational arithmetic (default false = floating point)"},
         "precision": {"type": "integer", "description": "significant digits to show (default 15; up to 60 for exact fractions)"},
         "variables": {"type": "object", "description": "optional values, e.g. {\"x\": 2.5, \"v\": [1,2,3]}"}},
        ["expression"],
        optional={"title": "🧮 Calculator", "default_on": True,
                  "blurb": "advanced maths: algebra, big numbers, exact fractions, matrices, statistics, primes, integrals, derivatives, equation solving"}),
    _fn("units", "convert_units",
        "Convert a value between units: length, mass, time, volume, area, speed, energy, power, pressure, angle, force, "
        "frequency, data size (B, kB, MB, GB, KiB, MiB, GiB...) and temperature (C, F, K). Example: value 5, from_unit mi, to_unit km.",
        {"value": N, "from_unit": S, "to_unit": S}, ["value", "from_unit", "to_unit"],
        optional={"title": "📏 Unit converter", "default_on": False,
                  "blurb": "length, mass, volume, speed, temperature, data size, energy ..."}),
    _fn("time", "date_time",
        "Date and time helper. action: 'now' (current time in tz), 'convert' (datetime from tz to to_tz), 'add' (add "
        "days/hours/minutes/weeks/months/years to datetime), 'diff' (time between datetime and end), 'weekday' (what day a date is). "
        "Dates are ISO like 2026-11-08 or 2026-11-08T14:30; time zones are IANA names (Europe/Stockholm), UTC, or +02:00.",
        {"action": {"type": "string", "enum": ["now", "convert", "add", "diff", "weekday"]},
         "datetime": S, "tz": S, "to_tz": S, "end": S,
         "days": N, "hours": N, "minutes": N, "weeks": N, "months": I, "years": I}, ["action"],
        optional={"title": "🕒 Date & time", "default_on": False,
                  "blurb": "current time in any zone, time zone conversion, date arithmetic, days between dates"}),

    # ---- tools that need the user's browser: the chat page runs them itself (here they only describe the tool)
    _fn("question", "question",
        "Ask the user a question and wait for the answer. The user sees the question with your options as buttons and can also "
        "type their own answer (or skip). Use it when you need a decision or information you cannot find out yourself, for "
        "example which approach to take, a name or a preference. Give 2-6 short, distinct options when there are sensible "
        "choices; leave options out for an open question. Ask one question at a time and never ask what you can look up or decide yourself.",
        {"question": S, "options": {"type": "array", "items": S, "description": "2-6 short answers the user can pick (optional)"}},
        ["question"],
        optional={"title": "\u2753 Question", "default_on": True,
                  "blurb": "the AI can ask you a question with answer buttons, and you can type your own answer. Not available in Leader, Orchestra or Ask mode"}),
    _fn("tasks", "task",
        "Keep a visible to-do list for the user while you work on something with several steps. action 'add' (title, or titles "
        "for several; status defaults to todo), 'set' (id, plus a status - todo, doing or done - and/or a new title), 'remove' "
        "(id or ids) or 'list'. Every call returns the whole list. Set a task to doing when you start it and to done when it is "
        "finished; remove tasks that no longer apply.",
        {"action": {"type": "string", "enum": ["add", "set", "remove", "list"]}, "title": S,
         "titles": {"type": "array", "items": S}, "id": I, "ids": {"type": "array", "items": I},
         "status": {"type": "string", "enum": ["todo", "doing", "done"]}},
        ["action"],
        optional={"title": "\u2611 Tasks", "default_on": True,
                  "blurb": "the AI keeps a to-do list you can see: it adds, updates and removes tasks as it works"}),
    _fn("spawn", "spawn",
        "Ask other free nodes to work with you. Choose a ready model from the available list. In parallel mode, give each worker an independent task. In debate mode, give one question and workers critique and improve one another's answers over several rounds; use this when collaboration would help.",
        {"model": S, "mode": {"type": "string", "enum": ["parallel", "debate"]},
         "task": {"type": "string", "description": "Shared question for debate mode"},
         "tasks": {"type": "array", "items": S, "description": "Independent worker tasks for parallel mode"},
         "workers": {"type": "integer", "description": "2-4 debaters; defaults to available slots"},
         "rounds": {"type": "integer", "description": "Debate rounds, 1-3; default 2"}}, ["model", "mode"],
        optional={"title": "Spawn models", "default_on": False,
                  "blurb": "delegate or debate with other ready models; worker tools run concurrently"}),
    _fn("runweb", "runweb",
        "Run a workspace .html or .htm file in headless Chromium and return its browser console output. A screenshot is also returned to vision-capable models. Use this to test a web page after changes.",
        {"path": S, "timeout": {"type": "integer", "description": "seconds, 1-30; default 15"},
         "screenshot": {"type": "boolean", "description": "the chat page sets this automatically for vision models"}}, ["path"],
        optional={"title": "\U0001F310 Run web page", "default_on": False,
                  "blurb": "open a workspace HTML file in Chromium, collect console output and a screenshot for vision models"}),
    _fn("playwright", "playwright",
        "Use Playwright on the currently opened, saved workspace HTML file. The chat page supplies the open file path. Returns browser console output and, for vision-capable models, a screenshot. Save editor changes before calling.",
        {"path": S, "timeout": {"type": "integer", "description": "seconds, 1-30; default 15"},
         "screenshot": {"type": "boolean", "description": "the chat page sets this automatically for vision models"}}, ["path"],
        optional={"title": "Playwright", "default_on": False,
                  "blurb": "run the currently opened saved HTML file with Playwright and inspect console output/screenshot"}),
]


def available():
    """The tool list that is actually usable (exec_command disappears with --no-exec)."""
    return [t for t in TOOLS if EXEC_ENABLED or t["group"] != "exec"]

def _calculate(expression, exact=False, precision=15, variables=None):
    try:
        return calc.calculate(expression, exact=exact, precision=precision, variables=variables)
    except calc.CalcError as e:
        raise ToolError(str(e))


def _convert_units(value, from_unit, to_unit):
    try:
        return extra_tools.convert_units(value, from_unit, to_unit)
    except (extra_tools.ExtraError, calc.CalcError) as e:
        raise ToolError(str(e))


def _date_time(**kw):
    try:
        return extra_tools.date_time(**kw)
    except (extra_tools.ExtraError, calc.CalcError) as e:
        raise ToolError(str(e))


def _browser_only(**_kw):
    raise ToolError("this tool runs inside the chat page (it needs the user's browser) and cannot be run through the API")


_IMPL = {"question": _browser_only, "task": _browser_only, "spawn": _browser_only, "calculate": _calculate, "convert_units": _convert_units, "date_time": _date_time,
         "web_search": web_search, "fetch_url": fetch_url, "list_files": list_files, "read_file": read_file,
         "write_file": write_file, "edit_file": edit_file, "delete_file": delete_file,
         "search_files": search_files, "exec_command": exec_command, "runweb": _run_web, "playwright": _run_web}


def run(name, args):
    """Execute a tool; always returns a JSON string (errors included) so the model can read it."""
    fn = _IMPL.get(name)
    if not fn:
        return json.dumps({"error": "unknown tool: %s" % name})
    if not isinstance(args, dict):
        return json.dumps({"error": "arguments must be an object"})
    allowed = set(TOOLS[[t["function"]["name"] for t in TOOLS].index(name)]["function"]["parameters"]["properties"])
    try:
        return json.dumps(fn(**{k: v for k, v in args.items() if k in allowed}), ensure_ascii=False)
    except ToolError as e:
        return json.dumps({"error": str(e)})
    except TypeError as e:
        return json.dumps({"error": "bad arguments: %s" % e})
    except Exception as e:  # never let a tool crash the controller
        return json.dumps({"error": "%s: %s" % (type(e).__name__, e)})
