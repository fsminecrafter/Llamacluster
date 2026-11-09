"""Browser terminal backend (xterm.js talks to this through long-polling HTTP; standard library only).

The shell runs inside a bubblewrap (bwrap) sandbox so that it can only work inside the chat workspace:
  * the workspace is the only writable place that survives (mounted at /workspace); /tmp is a private tmpfs
  * your home folder, /root, /var, /mnt, other users' files... do not exist inside it; /usr, /bin, /lib, /etc are read-only
  * it runs as an unprivileged user in its own user namespace - no root, sudo/su cannot work, nothing is setuid
  * no network by default (so it also can't call the controller's own API); allow with --term-net
  * own PID/IPC namespaces; killed when the controller exits, after 30 min idle, or when closed
If bwrap is missing or unprivileged user namespaces are disabled, the terminal is refused: a plain shell could not be
confined, and a fake "restricted shell" would only give a false sense of safety.
"""
import base64
import fcntl
import os
import pty
import shutil
import signal
import struct
import subprocess
import termios
import queue
import threading
import time

MAX_SESSIONS = 4
BUF_MAX = 1 << 20          # scrollback kept server-side for reconnecting pages
IDLE_SECONDS = 30 * 60
ALLOW_NET = False
UID = 1000                 # what the shell sees itself as (never 0)

_sessions = {}
_lock = threading.Lock()
_probe = {"t": 0, "ok": None, "msg": ""}


def configure(allow_net=None):
    global ALLOW_NET
    if allow_net is not None:
        ALLOW_NET = bool(allow_net)


def _mounts():
    """Read-only system directories (symlinks such as /bin -> usr/bin are recreated as symlinks)."""
    a = []
    for d in ("/usr", "/bin", "/sbin", "/lib", "/lib32", "/lib64", "/libx32", "/etc"):
        if os.path.islink(d):
            a += ["--symlink", os.readlink(d), d]
        elif os.path.isdir(d):
            a += ["--ro-bind", d, d]
    return a


def sandbox_cmd(workspace, inner, allow_net=None):
    bw = shutil.which("bwrap")
    if not bw:
        raise RuntimeError("the terminal needs bubblewrap to stay inside the workspace: sudo apt install bubblewrap")
    net = ALLOW_NET if allow_net is None else allow_net
    c = [bw, "--unshare-user", "--unshare-pid", "--unshare-ipc", "--unshare-uts", "--unshare-cgroup-try"]
    if not net:
        c.append("--unshare-net")
    c += ["--die-with-parent", "--uid", str(UID), "--gid", str(UID), "--clearenv"]
    c += _mounts()
    c += ["--proc", "/proc", "--dev", "/dev", "--tmpfs", "/tmp",
          "--bind", workspace, "/workspace", "--chdir", "/workspace",
          "--setenv", "HOME", "/tmp", "--setenv", "USER", "user", "--setenv", "LOGNAME", "user",
          "--setenv", "PATH", "/usr/local/bin:/usr/bin:/bin", "--setenv", "TERM", "xterm-256color",
          "--setenv", "LANG", "C.UTF-8", "--setenv", "PS1", r"\[\e[36m\]\w\[\e[0m\]\$ ",
          "--"]
    return c + inner


def available(workspace):
    """(ok, message). Runs a tiny probe so we know the sandbox really works - and that it is not root inside."""
    now = time.time()
    if _probe["ok"] is not None and (_probe["ok"] or now - _probe["t"] < 30):
        return _probe["ok"], _probe["msg"]
    try:
        out = subprocess.run(sandbox_cmd(workspace, ["/bin/sh", "-c", "id -u; ls /workspace >/dev/null && echo ws"]),
                             capture_output=True, text=True, timeout=10)
        ok = out.returncode == 0 and out.stdout.split()[:1] == [str(UID)] and "ws" in out.stdout
        msg = "" if ok else ("sandbox probe failed: " + (out.stderr.strip() or out.stdout.strip() or "no output")[:300] +
                              " (unprivileged user namespaces may be disabled on this system)")
    except (RuntimeError, OSError, subprocess.TimeoutExpired) as e:
        ok, msg = False, str(e)
    _probe.update(t=now, ok=ok, msg=msg)
    return ok, msg


# bwrap --die-with-parent uses PR_SET_PDEATHSIG, which fires when the *thread* that started the child exits. The
# controller handles every request on a short-lived thread, so shells are started from one long-lived thread instead.
_spawn_q = queue.Queue()


def _spawner():
    while True:
        fn, box, ev = _spawn_q.get()
        try:
            box.append(fn())
        except BaseException as e:      # noqa: BLE001 - handed back to the caller
            box.append(e)
        ev.set()


threading.Thread(target=_spawner, daemon=True, name="term-spawner").start()


def _spawn(fn):
    box, ev = [], threading.Event()
    _spawn_q.put((fn, box, ev))
    ev.wait(15)
    if not box:
        raise RuntimeError("could not start the shell (timeout)")
    if isinstance(box[0], BaseException):
        raise box[0]
    return box[0]


class Session:
    def __init__(self, workspace, rows=24, cols=80):
        self.cmd = sandbox_cmd(workspace, ["/bin/bash", "--noprofile", "--norc", "-i"])
        self.master, slave = pty.openpty()
        self._winsz(rows, cols)

        def ctty():                       # make the pty the shell's controlling terminal (job control, Ctrl-C)
            fcntl.ioctl(0, termios.TIOCSCTTY, 0)
        try:
            self.proc = _spawn(lambda: subprocess.Popen(self.cmd, stdin=slave, stdout=slave, stderr=slave, close_fds=True,
                                                        start_new_session=True, preexec_fn=ctty, env={"PATH": "/usr/bin:/bin"}))
        finally:
            os.close(slave)
        self.buf = bytearray()
        self.base = 0                      # absolute offset of buf[0]
        self.cond = threading.Condition()
        self.closed = False
        self.last = time.time()
        threading.Thread(target=self._pump, daemon=True).start()

    def _winsz(self, rows, cols):
        fcntl.ioctl(self.master, termios.TIOCSWINSZ, struct.pack("HHHH", max(2, min(int(rows), 500)), max(2, min(int(cols), 500)), 0, 0))

    def _pump(self):
        while True:
            try:
                b = os.read(self.master, 65536)
            except OSError:
                b = b""
            if not b:
                break
            with self.cond:
                self.buf += b
                if len(self.buf) > BUF_MAX:
                    cut = len(self.buf) - BUF_MAX
                    del self.buf[:cut]
                    self.base += cut
                self.cond.notify_all()
        try:
            self.proc.wait(timeout=2)
        except subprocess.TimeoutExpired:
            self.kill()
        with self.cond:
            self.closed = True
            self.cond.notify_all()

    def read(self, pos, wait=20):
        """Bytes after absolute offset pos (blocks up to `wait` s). Returns (data, new_pos, closed)."""
        self.last = time.time()
        deadline = time.time() + wait
        with self.cond:
            while pos >= self.base + len(self.buf) and not self.closed:
                left = deadline - time.time()
                if left <= 0:
                    break
                self.cond.wait(left)
            pos = max(pos, self.base)
            data = bytes(self.buf[pos - self.base:])
            return data, self.base + len(self.buf), self.closed and not data

    def write(self, data):
        self.last = time.time()
        if not self.closed and data:
            os.write(self.master, data)

    def resize(self, rows, cols):
        if not self.closed:
            self._winsz(rows, cols)

    def kill(self):
        try:
            os.killpg(self.proc.pid, signal.SIGKILL)
        except OSError:
            pass
        try:
            self.proc.kill()
        except OSError:
            pass

    def close(self):
        self.kill()
        try:
            os.close(self.master)
        except OSError:
            pass


def _reaper():
    while True:
        time.sleep(30)
        with _lock:
            for sid, s in list(_sessions.items()):
                if s.closed or time.time() - s.last > IDLE_SECONDS:
                    s.close()
                    _sessions.pop(sid, None)


threading.Thread(target=_reaper, daemon=True).start()


# ---------------------------------------------------------------- API used by controller.py
def open_session(workspace, rows=24, cols=80):
    ok, msg = available(workspace)
    if not ok:
        raise RuntimeError(msg)
    with _lock:
        for sid, s in list(_sessions.items()):
            if s.closed:
                s.close(); _sessions.pop(sid, None)
        if len(_sessions) >= MAX_SESSIONS:
            raise RuntimeError("too many open terminals (max %d) - close one first" % MAX_SESSIONS)
        sid = base64.urlsafe_b64encode(os.urandom(9)).decode()
        _sessions[sid] = Session(workspace, rows, cols)
    return sid


def get(sid):
    s = _sessions.get(sid)
    if not s:
        raise KeyError("no such terminal (it may have timed out)")
    return s


def close_session(sid):
    with _lock:
        s = _sessions.pop(sid, None)
    if s:
        s.close()


def close_all():
    with _lock:
        for s in _sessions.values():
            s.close()
        _sessions.clear()
