"""The question / task tools are registered for the model but run in the chat page."""
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
        for name, group in (("spawn", "spawn"), ("runweb", "runweb"), ("playwright", "playwright")):
            t = self.tool(name)
            self.assertEqual(t["group"], group)
            self.assertTrue(t["optional"] and not t["default_on"])
            self.assertTrue(t["title"] and t["blurb"])

    def test_schemas(self):
        q = self.tool("question")["function"]["parameters"]
        self.assertEqual(q["required"], ["question"])
        self.assertEqual(q["properties"]["options"]["type"], "array")
        t = self.tool("task")["function"]["parameters"]
        self.assertEqual(t["properties"]["action"]["enum"], ["add", "set", "remove", "list"])
        self.assertEqual(t["properties"]["status"]["enum"], ["todo", "doing", "done"])
        spawn = self.tool("spawn")["function"]["parameters"]
        self.assertEqual(spawn["properties"]["mode"]["enum"], ["parallel", "debate"])
        self.assertEqual(spawn["required"], ["model", "mode"])
        self.assertEqual(self.tool("runweb")["function"]["parameters"]["required"], ["path"])
        self.assertEqual(self.tool("playwright")["function"]["parameters"]["required"], ["path"])

    def test_api_run_explains_instead_of_crashing(self):
        for name in ("question", "task", "spawn"):
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
        for name in ("question", "task"):
            self.assertIsNone(tools.approval_reason(name, {}, "semi"))


if __name__ == "__main__":
    unittest.main()
