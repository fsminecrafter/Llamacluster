import io
import os
import sys
import tempfile
import threading
import unittest
import urllib.request
import zipfile
from http.server import ThreadingHTTPServer
from unittest.mock import patch

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
import controller
import tools


class WorkspaceDownloads(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.workspace = self.tmp.name
        os.makedirs(os.path.join(self.workspace, "nested"))
        with open(os.path.join(self.workspace, "nested", "hello.txt"), "w") as f:
            f.write("hello download")
        with open(os.path.join(self.workspace, ".hidden"), "w") as f:
            f.write("hidden")
        self.workspace_patch = patch.object(tools, "WORKSPACE", self.workspace)
        self.workspace_patch.start()
        self.server = ThreadingHTTPServer(("127.0.0.1", 0), controller.H)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.base = "http://127.0.0.1:%s" % self.server.server_port

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join()
        self.workspace_patch.stop()
        self.tmp.cleanup()

    def test_file_download(self):
        with urllib.request.urlopen(self.base + "/api/workspace/download?path=nested%2Fhello.txt") as r:
            self.assertEqual(r.read(), b"hello download")
            self.assertIn("attachment", r.headers.get("Content-Disposition", ""))

    def test_workspace_zip_download(self):
        with urllib.request.urlopen(self.base + "/api/workspace/download.zip") as r:
            self.assertEqual(r.headers.get("Content-Type"), "application/zip")
            archive = zipfile.ZipFile(io.BytesIO(r.read()))
            self.assertEqual(set(archive.namelist()), {"nested/hello.txt", ".hidden"})


if __name__ == "__main__":
    unittest.main()
