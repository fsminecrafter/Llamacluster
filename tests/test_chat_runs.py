import json
import os
import sys
import tempfile
import threading
import time
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from unittest.mock import patch

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
import controller


class ModelHandler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def do_POST(self):
        size = int(self.headers.get("Content-Length", "0"))
        self.rfile.read(size)
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Connection", "close")
        self.end_headers()
        try:
            for text in ("first", "second", "third"):
                self.wfile.write(("data: " + json.dumps({"choices": [{"delta": {"content": text}}]}) + "\n\n").encode())
                self.wfile.flush()
                time.sleep(0.03)
            self.wfile.write(b"data: [DONE]\n\n")
            self.wfile.flush()
        except (BrokenPipeError, ConnectionResetError):
            pass

    def log_message(self, *_):
        pass


class ChatRuns(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.model_server = ThreadingHTTPServer(("127.0.0.1", 0), ModelHandler)
        cls.model_thread = threading.Thread(target=cls.model_server.serve_forever, daemon=True)
        cls.model_thread.start()

    @classmethod
    def tearDownClass(cls):
        cls.model_server.shutdown()
        cls.model_server.server_close()

    def setUp(self):
        self.old_state_file = controller.STATE_FILE
        self.temp_dir = tempfile.TemporaryDirectory()
        controller.STATE_FILE = os.path.join(self.temp_dir.name, "nodes.json")
        self.old_nodes = controller.nodes.copy()
        self.old_status = controller.status.copy()
        self.old_runs = controller.chat_runs.copy()
        self.old_keys = controller.chat_run_keys.copy()
        self.old_scheduled_tasks = controller.scheduled_tasks.copy()
        controller.nodes.clear()
        controller.status.clear()
        controller.chat_runs.clear()
        controller.chat_run_keys.clear()
        controller.scheduled_tasks.clear()
        node_id = "test-node"
        controller.nodes[node_id] = {
            "id": node_id, "name": "Test node",
            "url": f"http://127.0.0.1:{self.model_server.server_port}",
        }
        controller.status[node_id] = {
            "ok": True, "data": {"server": {"state": "ready", "config": {"model": "test-model"}}}
        }

    def tearDown(self):
        controller.nodes.clear()
        controller.nodes.update(self.old_nodes)
        controller.status.clear()
        controller.status.update(self.old_status)
        controller.chat_runs.clear()
        controller.chat_runs.update(self.old_runs)
        controller.chat_run_keys.clear()
        controller.chat_run_keys.update(self.old_keys)
        controller.scheduled_tasks.clear()
        controller.scheduled_tasks.update(self.old_scheduled_tasks)
        controller.STATE_FILE = self.old_state_file
        self.temp_dir.cleanup()

    def test_stream_is_buffered_even_when_nobody_reads_until_completion(self):
        body = {"stream": True, "model": "test-model", "messages": [{"role": "user", "content": "hello"}]}
        run = controller.create_chat_run("request-1", body)
        with run.condition:
            self.assertTrue(run.condition.wait_for(lambda: run.done, timeout=3))

        snapshot = run.snapshot(0, 0)
        self.assertTrue(snapshot["done"])
        self.assertIsNone(snapshot["error"])
        self.assertIn('"first"', "".join(snapshot["lines"]))
        self.assertIn('"third"', "".join(snapshot["lines"]))
        self.assertEqual(snapshot["node"], "Test node")

    def test_retries_with_same_request_id_reuse_the_existing_stream(self):
        body = {"stream": True, "model": "test-model", "messages": []}
        first = controller.create_chat_run("request-retry", body)
        second = controller.create_chat_run("request-retry", body)
        self.assertIs(first, second)
        with first.condition:
            self.assertTrue(first.condition.wait_for(lambda: first.done, timeout=3))
        self.assertIn("[DONE]", "".join(first.snapshot(0, 0)["lines"]))

    def test_snapshot_cursor_returns_only_new_lines(self):
        run = controller.ChatRun("run-cursor", "request-cursor")
        for index in range(2050):
            run.append(f"data: {index}\n")
        first = run.snapshot(0, 0)
        next_page = run.snapshot(first["next"], 0)
        self.assertEqual(len(first["lines"]), 2048)
        self.assertEqual(next_page["lines"], ["data: 2048\n", "data: 2049\n"])

    def test_scheduled_tasks_are_validated_persisted_listed_and_cancelled(self):
        task = controller.create_scheduled_task("Check the report", time.time() + 60,
                                                 "test-model", "Test node", "Be concise.")
        self.assertEqual(controller.list_scheduled_tasks()[0]["id"], task["id"])
        self.assertTrue(os.path.isfile(controller._scheduled_tasks_file()))
        controller.scheduled_tasks.clear()
        controller.load_scheduled_tasks()
        self.assertEqual(controller.list_scheduled_tasks()[0]["id"], task["id"])
        self.assertTrue(controller.cancel_scheduled_task(task["id"]))
        self.assertEqual(controller.list_scheduled_tasks()[0]["status"], "cancelled")
        with self.assertRaises(ValueError):
            controller.create_scheduled_task("", time.time() + 60)
        with self.assertRaises(ValueError):
            controller.create_scheduled_task("past", time.time() - 1)

    def test_scheduled_worker_runs_prompt_without_a_browser_reader(self):
        task = controller.create_scheduled_task("Say hello", time.time() + 60,
                                                 "test-model", "Test node", "Be concise.")
        with controller.scheduled_tasks_lock:
            controller.scheduled_tasks[task["id"]]["status"] = "running"
        controller._scheduled_task_worker(task["id"])
        result = controller.list_scheduled_tasks()[0]
        self.assertEqual(result["status"], "completed")
        self.assertIn("first", result["result"])
        self.assertIn("third", result["result"])

    def test_bulk_install_checks_linux_and_updates_only_successful_node_tokens(self):
        controller.nodes["linux-node"] = {
            "id": "linux-node", "name": "Linux worker", "url": "http://linux.invalid",
            "token": "old-token",
        }
        controller.nodes["other-node"] = {
            "id": "other-node", "name": "Other OS", "url": "http://other.invalid",
            "token": "old-token",
        }
        controller.status["test-node"]["data"]["os"] = "Linux"
        controller.status["linux-node"] = {"data": {"os": "Linux"}}
        controller.status["other-node"] = {"data": {"os": "Darwin"}}
        def fake_call(node, method, path, body, timeout):
            return 202, {"ok": True, "message": "service enabled"}
        with patch.object(controller, "call_node", side_effect=fake_call) as call:
            result = controller.cluster_worker_action("install", {
                "token": "shared-worker-token-123", "controller_node": "test-node",
                "controller_is_worker": False,
            })
        self.assertEqual(call.call_count, 1)
        self.assertEqual(controller.nodes["linux-node"]["token"], "shared-worker-token-123")
        self.assertEqual(controller.nodes["other-node"]["token"], "old-token")
        statuses = {row["node"]: row["status"] for row in result["results"]}
        self.assertEqual(statuses["Linux worker"], "success")
        self.assertEqual(statuses["Other OS"], "skipped")
        self.assertEqual(statuses["Test node"], "skipped")

    def test_bulk_restart_includes_controller_only_when_configured_as_worker(self):
        with patch.object(controller, "call_node", return_value=(202, {"ok": True})) as call:
            result = controller.cluster_worker_action("restart", {
                "controller_node": "test-node", "controller_is_worker": False,
            })
        self.assertEqual(call.call_count, 0)
        self.assertEqual(result["results"][0]["status"], "skipped")
        with patch.object(controller, "call_node", return_value=(202, {"ok": True})) as call:
            result = controller.cluster_worker_action("restart", {
                "controller_node": "test-node", "controller_is_worker": True,
            })
        self.assertEqual(call.call_count, 1)
        self.assertEqual(result["results"][0]["status"], "success")


if __name__ == "__main__":
    unittest.main()
