import os, struct, sys, tempfile, unittest
from unittest.mock import patch
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
import worker


def _s(x):
    b = x.encode()
    return struct.pack("<Q", len(b)) + b


def make_gguf(path, arch, template=None):
    kv = [_s("general.architecture") + struct.pack("<I", 8) + _s(arch),
          _s(arch + ".block_count") + struct.pack("<II", 4, 4),
          _s("tokenizer.ggml.tokens") + struct.pack("<IIQ", 9, 8, 3) + _s("a") + _s("b") + _s("c")]
    if template:
        kv.append(_s("tokenizer.chat_template") + struct.pack("<I", 8) + _s(template))
    with open(path, "wb") as f:
        f.write(b"GGUF" + struct.pack("<IQQ", 3, 0, len(kv)) + b"".join(kv))


class T(unittest.TestCase):
    def test_move_models_copies_verifies_and_persists_directory(self):
        with tempfile.TemporaryDirectory() as d:
            source = os.path.join(d, "models")
            target_root = os.path.join(d, "disk")
            os.makedirs(source)
            os.makedirs(target_root)
            with open(os.path.join(source, "model.gguf"), "wb") as f:
                f.write(b"model bytes")
            w = worker.Worker.__new__(worker.Worker)
            w.models_dir = source
            w.models_dir_pref = os.path.join(d, "config", "models-dir")
            w.journal_path = os.path.join(source, ".downloads.json")
            w.bench_path = os.path.join(source, ".bench.json")
            w.rpc_proc = None
            w.inflight = 0
            w.bench_job = {"running": False}
            w.downloads = {}
            w.is_running = lambda: False

            target = os.path.join(target_root, "models")
            result = w.move_models(target)
            self.assertTrue(result["ok"])
            self.assertEqual(w.models_dir, target)
            with open(os.path.join(target, "model.gguf"), "rb") as f:
                self.assertEqual(f.read(), b"model bytes")
            self.assertFalse(os.path.exists(source))
            with open(w.models_dir_pref, encoding="utf-8") as f:
                self.assertEqual(f.read().strip(), target)
            self.assertEqual(w.journal_path, os.path.join(target, ".downloads.json"))

    def test_move_models_refuses_active_server_and_existing_destination(self):
        with tempfile.TemporaryDirectory() as d:
            source = os.path.join(d, "models")
            destination = os.path.join(d, "existing")
            os.makedirs(source)
            os.makedirs(destination)
            w = worker.Worker.__new__(worker.Worker)
            w.models_dir = source
            w.models_dir_pref = os.path.join(d, "config", "models-dir")
            w.rpc_proc = None
            w.inflight = 0
            w.bench_job = {"running": False}
            w.downloads = {}
            w.is_running = lambda: True
            with self.assertRaisesRegex(ValueError, "stop the server"):
                w.move_models(os.path.join(d, "new"))
            w.is_running = lambda: False
            with self.assertRaisesRegex(ValueError, "already exists"):
                w.move_models(destination)

    def test_image_capability_setting_controls_auto_projector(self):
        w = worker.Worker.__new__(worker.Worker)
        w.server_bin_hint = "llama-server"
        w.resolve_model = lambda name: "/models/" + name
        w.pick_mmproj = lambda name: "vision-mmproj.gguf"
        base = {"model": "vision-model.gguf"}
        with patch.object(worker, "find_binary", return_value="/bin/llama-server"):
            cmd, mm = w._server_cmd({**base, "supports_images": False}, 8080)
            self.assertEqual(mm, "")
            self.assertNotIn("--mmproj", cmd)
            cmd, mm = w._server_cmd({**base, "supports_images": True}, 8080)
            self.assertEqual(mm, "vision-mmproj.gguf")
            self.assertIn("--mmproj", cmd)
            self.assertNotIn("--no-mmproj-offload", cmd)
            cmd, mm = w._server_cmd({**base, "supports_images": True, "mmproj_offload": False}, 8080)
            self.assertEqual(mm, "vision-mmproj.gguf")
            self.assertIn("--mmproj", cmd)
            self.assertIn("--no-mmproj-offload", cmd)
            cmd, mm = w._server_cmd({**base, "supports_images": False, "mmproj_offload": False}, 8080)
            self.assertEqual(mm, "")
            self.assertNotIn("--no-mmproj-offload", cmd)
            cmd, mm = w._server_cmd({**base, "supports_images": True, "extra_args": "--no-mmproj-offload"}, 8080)
            self.assertEqual(mm, "vision-mmproj.gguf")
            self.assertEqual(cmd.count("--no-mmproj-offload"), 1)
            cmd, mm = w._server_cmd(base, 8080)
            self.assertEqual(mm, "vision-mmproj.gguf")

    def test_reasoning_and_mmproj(self):
        with tempfile.TemporaryDirectory() as d:
            make_gguf(d + "/oss-Q4_K_M.gguf", "llama", "{{ reasoning_effort }}")
            make_gguf(d + "/Qwen3-VL-Q4_K_M.gguf", "qwen3", "{% if enable_thinking %}")
            make_gguf(d + "/Qwen3-VL-mmproj-F16.gguf", "clip")
            make_gguf(d + "/plain-Q4_0.gguf", "llama", "hi")
            w = worker.Worker.__new__(worker.Worker)
            w.models_dir = d
            models, mm = w._scan()
            by = {m["name"]: m["meta"].get("reasoning") for m in models}
            self.assertEqual(by["oss-Q4_K_M.gguf"]["kind"], "effort")
            self.assertEqual(by["Qwen3-VL-Q4_K_M.gguf"]["kind"], "toggle")
            self.assertIsNone(by["plain-Q4_0.gguf"])
            self.assertEqual([m["name"] for m in mm], ["Qwen3-VL-mmproj-F16.gguf"])
            self.assertEqual(w.pick_mmproj("Qwen3-VL-Q4_K_M.gguf"), "Qwen3-VL-mmproj-F16.gguf")
            self.assertIsNone(w.pick_mmproj("plain-Q4_0.gguf"))


if __name__ == "__main__":
    unittest.main()
