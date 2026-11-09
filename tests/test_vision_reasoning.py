import os, struct, sys, tempfile, unittest
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
