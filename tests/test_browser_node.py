"""Browser (WebGPU) nodes: a tab registers over HTTP, long-polls for chat requests and streams chunks back.
These tests drive the real controller HTTP handler with a fake tab (no browser or GPU needed)."""
import http.client
import json
import os
import sys
import tempfile
import threading
import time
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
import controller


def chunk(text=None, finish=None):
    return {"id": "chatcmpl-x", "object": "chat.completion.chunk", "model": "Test-MLC",
            "choices": [{"index": 0, "delta": ({"content": text} if text is not None else {}), "finish_reason": finish}]}


class Http:
    def __init__(self, port):
        self.port = port

    def call(self, method, path, body=None, timeout=15):
        c = http.client.HTTPConnection("127.0.0.1", self.port, timeout=timeout)
        try:
            c.request(method, path, body=json.dumps(body).encode() if body is not None else None,
                      headers={"Content-Type": "application/json"})
            r = c.getresponse()
            raw = r.read()
            return r.status, (json.loads(raw) if raw[:1] in (b"{", b"[") else raw.decode()), r
        finally:
            c.close()


class FakeTab(threading.Thread):
    """What src/webgpu/node.js does: register, heartbeat, poll for one job at a time, stream chunks back."""

    def __init__(self, http_, words=("Hel", "lo"), delay=0.02, state="ready"):
        super().__init__(daemon=True)
        self.h, self.words, self.delay, self.state = http_, words, delay, state
        self.node_id = None
        self.stop = False
        self.jobs_seen, self.cancelled = [], []
        self.info = {"state": state, "model": "Test-MLC", "ctx": 4096, "cores": 8, "gpu": {"name": "Fake GPU"}}

    def register(self):
        code, d, _ = self.h.call("POST", "/api/browser-nodes", {"name": "Test tab", "client_id": "tab-1", "info": self.info})
        assert code == 200, d
        self.node_id = d["id"]
        return d

    def run(self):
        while not self.stop:
            code, d, _ = self.h.call("GET", f"/api/browser-nodes/{self.node_id}/poll?wait=1")
            if code != 200:
                return
            for job in d["jobs"]:
                self.jobs_seen.append(job["body"])
                self.serve(job)

    def serve(self, job):
        base = f"/api/browser-nodes/{self.node_id}"
        for w in self.words:
            if self.stop:
                return
            code, d, _ = self.h.call("POST", f"{base}/jobs/{job['id']}", {"chunks": [chunk(w)]})
            if code != 200:             # 404: the controller dropped the job (stopped) - abort, like the real tab
                self.cancelled.append(job["id"])
                return
            time.sleep(self.delay)
            _, hb, _ = self.h.call("POST", f"{base}/hb", {"info": self.info})
            if job["id"] in hb.get("cancel", []):
                self.cancelled.append(job["id"])
                return
        self.h.call("POST", f"{base}/jobs/{job['id']}", {"chunks": [chunk(finish="stop")], "done": True})


class BrowserNodes(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.srv = controller.Server(("127.0.0.1", 0), controller.H)
        threading.Thread(target=cls.srv.serve_forever, daemon=True).start()
        cls.h = Http(cls.srv.server_address[1])

    @classmethod
    def tearDownClass(cls):
        cls.srv.shutdown()
        cls.srv.server_close()

    def setUp(self):
        self.old_state = controller.STATE_FILE
        self.tmp = tempfile.TemporaryDirectory()
        controller.STATE_FILE = os.path.join(self.tmp.name, "nodes.json")
        for d in (controller.nodes, controller.status, controller.bnodes, controller.inflight, controller.chat_runs, controller.chat_run_keys):
            d.clear()
        controller.bnodes_removed.clear()
        self.tabs = []

    def tearDown(self):
        for t in self.tabs:
            t.stop = True
        controller.STATE_FILE = self.old_state
        self.tmp.cleanup()

    def tab(self, **kw):
        t = FakeTab(self.h, **kw)
        t.register()
        t.start()
        self.tabs.append(t)
        return t

    # -- registration / status
    def test_registers_as_a_ready_node_and_is_not_saved(self):
        t = self.tab()
        _, nodes, _ = self.h.call("GET", "/api/nodes")
        self.assertEqual(len(nodes), 1)
        n = nodes[0]
        self.assertEqual((n["name"], n["kind"], n["online"]), ("Test tab", "browser", True))
        self.assertEqual(n["info"]["server"]["state"], "ready")
        self.assertEqual(n["info"]["server"]["config"]["model"], "Test-MLC")
        self.assertEqual(n["info"]["hardware"]["gpus"][0]["name"], "Fake GPU")
        self.assertEqual([x["id"] for x in controller.ready_nodes()], [t.node_id])
        controller.save()
        with open(controller.STATE_FILE) as f:
            self.assertEqual(json.load(f), [])

    def test_same_client_id_reuses_the_node_and_names_stay_unique(self):
        a = self.tab()
        _, d, _ = self.h.call("POST", "/api/browser-nodes", {"name": "Test tab", "client_id": "tab-1"})
        self.assertEqual(d["id"], a.node_id)
        _, d2, _ = self.h.call("POST", "/api/browser-nodes", {"name": "Test tab", "client_id": "tab-2"})
        self.assertNotEqual(d2["id"], a.node_id)
        self.assertEqual(d2["name"], "Test tab (2)")

    def test_not_ready_until_a_model_is_loaded(self):
        t = self.tab(state="loading")
        t.info = {"state": "loading", "model": "Test-MLC", "progress": 0.4, "text": "Fetching"}
        self.h.call("POST", f"/api/browser-nodes/{t.node_id}/hb", {"info": t.info})
        _, nodes, _ = self.h.call("GET", "/api/nodes")
        self.assertEqual(nodes[0]["info"]["server"]["state"], "loading")
        self.assertEqual(nodes[0]["info"]["browser"]["progress"], 0.4)
        self.assertEqual(controller.ready_nodes(), [])
        code, d, _ = self.h.call("POST", "/v1/chat/completions", {"model": "Test-MLC", "stream": False, "messages": []})
        self.assertEqual(code, 503)

    def test_unknown_node_is_404_and_removed_node_is_410(self):
        self.assertEqual(self.h.call("GET", "/api/browser-nodes/nope/poll?wait=0")[0], 404)
        t = self.tab()
        self.assertEqual(self.h.call("DELETE", f"/api/nodes/{t.node_id}")[0], 200)
        self.assertEqual(self.h.call("GET", f"/api/browser-nodes/{t.node_id}/poll?wait=0")[0], 410)
        self.assertEqual(self.h.call("GET", "/api/nodes")[1], [])

    def test_a_silent_tab_goes_offline(self):
        t = self.tab()
        t.stop = True
        time.sleep(1.3)           # let its last long poll end
        with controller.bnodes[t.node_id].cond:
            controller.bnodes[t.node_id].seen -= controller.BROWSER_TTL + 1
        self.assertFalse(controller.bnode_alive(controller.bnodes[t.node_id]))
        self.assertEqual(controller.ready_nodes(), [])   # not picked even before the poll loop refreshes its status
        with self.assertRaises(controller.BrowserNodeError) as ctx:
            list(controller.bnode_stream(controller.bnodes[t.node_id], {"messages": []}))
        self.assertTrue(ctx.exception.retryable)

    def test_management_calls_are_refused_for_browser_nodes(self):
        t = self.tab()
        code, d, _ = self.h.call("POST", f"/api/nodes/{t.node_id}/start", {"model": "x"})
        self.assertEqual(code, 400)
        self.assertIn("browser tab", d["error"])

    # -- serving
    def test_gateway_streams_and_aggregates(self):
        t = self.tab()
        code, raw, r = self.h.call("POST", "/v1/chat/completions",
                                   {"model": "Test-MLC", "stream": True, "messages": [{"role": "user", "content": "hi"}]})
        self.assertEqual(code, 200)
        self.assertEqual(r.getheader("X-LlamaCluster-Node"), "Test tab")
        events = [l[6:] for l in raw.split("\n") if l.startswith("data: ")]
        self.assertEqual(events[-1], "[DONE]")
        text = "".join(json.loads(e)["choices"][0]["delta"].get("content", "") for e in events[:-1])
        self.assertEqual(text, "Hello")
        self.assertEqual(t.jobs_seen[0]["messages"][0]["content"], "hi")

        code, d, _ = self.h.call("POST", "/v1/chat/completions", {"model": "Test-MLC", "messages": [{"role": "user", "content": "again"}]})
        self.assertEqual(code, 200)
        self.assertEqual(d["choices"][0]["message"]["content"], "Hello")
        self.assertEqual(d["choices"][0]["finish_reason"], "stop")
        _, models, _ = self.h.call("GET", "/v1/models")
        self.assertEqual([m["id"] for m in models["data"]], ["Test-MLC"])

    def test_only_chat_completions_go_to_a_browser_node(self):
        self.tab()
        code, d, _ = self.h.call("POST", "/v1/embeddings", {"input": "x"})
        self.assertEqual(code, 503)

    def test_chat_run_buffers_lines_like_a_worker(self):
        t = self.tab()
        run = controller.create_chat_run("req-b1", {"stream": True, "model": "Test-MLC", "messages": [{"role": "user", "content": "hi"}]})
        with run.condition:
            self.assertTrue(run.condition.wait_for(lambda: run.done, timeout=5))
        snap = run.snapshot(0, 0)
        self.assertIsNone(snap["error"])
        self.assertEqual(snap["node"], "Test tab")
        data = [l for l in snap["lines"] if l.startswith("data:")]
        self.assertEqual(data[-1].strip(), "data: [DONE]")
        self.assertIn('"Hel"', data[0])
        self.assertEqual(controller.inflight[t.node_id], 0)

    def test_stop_reaches_the_tab(self):
        t = self.tab(words=["tok"] * 200, delay=0.03)
        run = controller.create_chat_run("req-b2", {"stream": True, "model": "Test-MLC", "messages": []})
        time.sleep(0.4)
        run.cancel()
        deadline = time.time() + 5
        while not t.cancelled and time.time() < deadline:
            time.sleep(0.05)
        self.assertEqual(len(t.cancelled), 1)

    def test_tab_error_before_output_fails_over_to_another_node(self):
        class Ok(BaseHTTPRequestHandler):
            protocol_version = "HTTP/1.1"

            def do_POST(self):
                self.rfile.read(int(self.headers.get("Content-Length", "0")))
                data = json.dumps({"choices": [{"message": {"role": "assistant", "content": "from worker"}, "finish_reason": "stop"}]}).encode()
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)

            def log_message(self, *a):
                pass
        worker = ThreadingHTTPServer(("127.0.0.1", 0), Ok)
        threading.Thread(target=worker.serve_forever, daemon=True).start()
        self.addCleanup(worker.shutdown)
        controller.nodes["w1"] = {"id": "w1", "name": "worker", "url": f"http://127.0.0.1:{worker.server_port}", "kind": "lan"}
        controller.status["w1"] = {"ok": True, "data": {"server": {"state": "ready", "config": {"model": "Test-MLC", "parallel": 1}, "inflight": 0}}}

        class Failing(FakeTab):
            def serve(self, job):
                self.h.call("POST", f"/api/browser-nodes/{self.node_id}/jobs/{job['id']}", {"done": True, "error": "GPU device lost"})
        t = Failing(self.h)
        t.register()
        t.start()
        self.tabs.append(t)
        # make the tab the balancer's first choice (idle, higher weight), so the failover path is what is under test
        controller.nodes[t.node_id]["weight"] = 10
        code, d, r = self.h.call("POST", "/v1/chat/completions", {"model": "Test-MLC", "messages": []})
        self.assertEqual(code, 200, d)
        self.assertEqual(d["choices"][0]["message"]["content"], "from worker")
        self.assertEqual(r.getheader("X-LlamaCluster-Node"), "worker")
        self.assertEqual(len(t.jobs_seen), 1)    # the tab really was tried first

    def test_unpicked_request_times_out_and_is_retryable(self):
        t = self.tab()
        t.stop = True
        time.sleep(1.2)
        bn = controller.bnodes[t.node_id]
        old = controller.BROWSER_PICKUP_S
        controller.BROWSER_PICKUP_S = 0.3
        self.addCleanup(setattr, controller, "BROWSER_PICKUP_S", old)
        bn.seen = time.time() + 30     # alive (heartbeating) but never polling for work
        with self.assertRaises(controller.BrowserNodeError) as ctx:
            list(controller.bnode_stream(bn, {"messages": []}))
        self.assertTrue(ctx.exception.retryable)
        self.assertIn("pick up", str(ctx.exception))


if __name__ == "__main__":
    unittest.main()
