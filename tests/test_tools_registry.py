"""Chat interaction and live-agent tools are registered for browser-side execution."""
import io, json, os, sys, tempfile, unittest, zipfile
from unittest.mock import patch
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
import tools


class Registry(unittest.TestCase):
    def tool(self, name):
        return next(t for t in tools.available() if t["function"]["name"] == name)

    def test_registered_as_optional_default_on(self):
        for name, group in (("question", "question"), ("task", "tasks")):
            t = self.tool(name)
            self.assertEqual(t["group"], group)
            self.assertTrue(t["optional"] and t["default_on"])
            self.assertTrue(t["title"] and t["blurb"])
        for name, group in (("spawn", "spawn"), ("tell", "tell"), ("interrupt", "interrupt"),
                            ("status", "status"), ("despawn", "despawn"), ("agent_done", "agent_done")):
            t = self.tool(name)
            self.assertEqual(t["group"], group)
            self.assertTrue(t["optional"] and t["default_on"])
            self.assertTrue(t["title"] and t["blurb"])
            self.assertEqual(t["section"], "Other tools")
        for name, group in (("runweb", "runweb"), ("playwright", "playwright")):
            t = self.tool(name)
            self.assertEqual(t["group"], group)
            self.assertTrue(t["optional"] and not t["default_on"])
            self.assertTrue(t["title"] and t["blurb"])
        image_tool = self.tool("view_image")
        self.assertEqual(image_tool["group"], "view_image")
        self.assertTrue(image_tool["optional"] and image_tool["default_on"])

    def test_schemas(self):
        q = self.tool("question")["function"]["parameters"]
        self.assertEqual(q["required"], ["question"])
        self.assertEqual(q["properties"]["options"]["type"], "array")
        t = self.tool("task")["function"]["parameters"]
        self.assertEqual(t["properties"]["action"]["enum"], ["add", "set", "remove", "list"])
        self.assertEqual(t["properties"]["status"]["enum"], ["todo", "doing", "done"])
        spawn = self.tool("spawn")["function"]["parameters"]
        self.assertEqual(spawn["properties"]["mode"]["enum"], ["agent", "parallel", "debate"])
        self.assertEqual(spawn["required"], ["model", "mode"])
        self.assertEqual(self.tool("tell")["function"]["parameters"]["required"], ["target", "message"])
        self.assertEqual(self.tool("interrupt")["function"]["parameters"]["required"], ["target", "message"])
        self.assertEqual(self.tool("status")["function"]["parameters"]["required"], [])
        self.assertEqual(self.tool("runweb")["function"]["parameters"]["required"], ["path"])
        self.assertEqual(self.tool("playwright")["function"]["parameters"]["required"], ["path"])
        view_image = self.tool("view_image")["function"]["parameters"]
        self.assertEqual(view_image["required"], [])
        self.assertEqual(view_image["properties"]["path"]["type"], "string")
        self.assertEqual(view_image["properties"]["attachment"]["type"], "integer")

    def test_api_run_explains_instead_of_crashing(self):
        for name in ("question", "task", "spawn", "tell", "interrupt", "status", "despawn", "agent_done"):
            r = json.loads(tools.run(name, {"question": "x", "action": "list"}))
            self.assertIn("chat page", r["error"])

    def test_runweb_confines_paths_and_requires_approval_in_semi(self):
        with tempfile.TemporaryDirectory() as workspace, patch.object(tools, "WORKSPACE", workspace):
            r = json.loads(tools.run("runweb", {"path": "missing.html"}))
            outside = json.loads(tools.run("runweb", {"path": "../outside.html"}))
        self.assertIn("no such file", r["error"])
        self.assertIn("outside the workspace", outside["error"])
        self.assertIn("browser", tools.approval_reason("runweb", {"path": "index.html"}, "semi"))
        self.assertIn("browser", tools.approval_reason("playwright", {"path": "index.html"}, "semi"))

    def test_workspace_zip_includes_hidden_and_nested_files_only(self):
        with tempfile.TemporaryDirectory() as workspace, tempfile.TemporaryDirectory() as outside:
            os.makedirs(os.path.join(workspace, "nested"))
            with open(os.path.join(workspace, "nested", "file.txt"), "w") as f:
                f.write("nested")
            with open(os.path.join(workspace, ".hidden"), "w") as f:
                f.write("hidden")
            with open(os.path.join(outside, "secret.txt"), "w") as f:
                f.write("outside")
            try:
                os.symlink(os.path.join(outside, "secret.txt"), os.path.join(workspace, "link"))
            except OSError:
                pass
            data = io.BytesIO()
            with patch.object(tools, "WORKSPACE", workspace):
                tools.write_workspace_zip(data)
            with zipfile.ZipFile(data) as archive:
                names = set(archive.namelist())
            self.assertIn("nested/file.txt", names)
            self.assertIn(".hidden", names)
            self.assertNotIn("link", names)

    def test_no_approval_needed_under_semi(self):
        for name in ("question", "task", "view_image"):
            self.assertIsNone(tools.approval_reason(name, {}, "semi"))

    def test_view_image_returns_only_supported_workspace_images(self):
        with tempfile.TemporaryDirectory() as workspace, tempfile.TemporaryDirectory() as outside:
            image = os.path.join(workspace, "sample.png")
            with open(image, "wb") as f:
                f.write(b"png test data")
            with open(os.path.join(workspace, "notes.txt"), "wb") as f:
                f.write(b"text")
            with open(os.path.join(outside, "outside.png"), "wb") as f:
                f.write(b"outside")
            with patch.object(tools, "WORKSPACE", workspace):
                result = json.loads(tools.run("view_image", {"path": "sample.png"}))
                unsupported = json.loads(tools.run("view_image", {"path": "notes.txt"}))
                escaped = json.loads(tools.run("view_image", {"path": "../outside/outside.png"}))
                missing = json.loads(tools.run("view_image", {}))
            self.assertEqual(result["path"], "sample.png")
            self.assertEqual(result["mime_type"], "image/png")
            self.assertEqual(result["image_base64"], "cG5nIHRlc3QgZGF0YQ==")
            self.assertIn("supports JPEG", unsupported["error"])
            self.assertIn("outside the workspace", escaped["error"])
            self.assertIn("no such file", missing["error"])


if __name__ == "__main__":
    unittest.main()
