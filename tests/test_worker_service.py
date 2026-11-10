import os
import stat
import sys
import tempfile
import types
import unittest
from unittest.mock import Mock, patch

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
import worker


class WorkerServiceTests(unittest.TestCase):
    def test_systemd_user_env_discovers_runtime_dir_when_xdg_is_unset(self):
        runtime_stat = types.SimpleNamespace(st_uid=1000, st_mode=stat.S_IFDIR | 0o700)
        bus_stat = types.SimpleNamespace(st_uid=1000, st_mode=stat.S_IFSOCK | 0o600)
        with patch.dict(worker.os.environ, {"XDG_RUNTIME_DIR": "", "DBUS_SESSION_BUS_ADDRESS": ""}, clear=True), \
             patch.object(worker.os, "getuid", return_value=1000), \
             patch.object(worker.os, "stat", side_effect=[runtime_stat, bus_stat]):
            env = worker._systemd_user_env()
        self.assertEqual(env["XDG_RUNTIME_DIR"], "/run/user/1000")
        self.assertEqual(env["DBUS_SESSION_BUS_ADDRESS"], "unix:path=/run/user/1000/bus")

    def test_systemd_user_env_ignores_runtime_dir_owned_by_another_user(self):
        runtime_stat = types.SimpleNamespace(st_uid=0, st_mode=stat.S_IFDIR | 0o700)
        with patch.dict(worker.os.environ, {"XDG_RUNTIME_DIR": ""}, clear=True), \
             patch.object(worker.os, "getuid", return_value=1000), \
             patch.object(worker.os, "stat", return_value=runtime_stat):
            env = worker._systemd_user_env()
        self.assertEqual(env["XDG_RUNTIME_DIR"], "")

    def test_autostart_rejects_non_linux_before_checking_systemctl(self):
        with patch.object(worker.platform, "system", return_value="Windows"), \
             patch.object(worker.shutil, "which") as which:
            with self.assertRaisesRegex(RuntimeError, "only on Linux"):
                worker.install_autostart("shared-worker-token-123")
            which.assert_not_called()

    def test_systemd_quoting_escapes_units_and_specifiers(self):
        self.assertEqual(worker._systemd_quote('/path/a b%$"c'),
                         '"/path/a b%%$$\\"c"')
        with self.assertRaisesRegex(RuntimeError, "control characters"):
            worker._systemd_quote("bad\nvalue")

    def test_install_writes_private_token_env_and_enables_service(self):
        with tempfile.TemporaryDirectory() as home:
            unit_path = os.path.join(home, "systemd", "user", "llamacluster-worker.service")
            env_path = os.path.join(home, "llamacluster", "worker.env")
            args = types.SimpleNamespace(host="0.0.0.0", port=7860, models_dir="/models",
                                         llama_server="", rpc_server="")
            fake_worker = types.SimpleNamespace(
                args=args, token="", name="node-a", models_dir="/models", llama_port=8080,
                rpc_port=50052, server_bin_hint="", rpc_bin_hint="", storage_roots=[],
            )
            with patch.object(worker, "W", fake_worker), \
                 patch.object(worker, "_systemd_user", return_value="/usr/bin/systemctl"), \
                 patch.object(worker, "_service_paths", return_value=(unit_path, env_path)), \
                 patch.object(worker, "_service_active", return_value=True), \
                 patch.object(worker, "_systemctl") as systemctl, \
                 patch.object(worker, "_schedule_worker_handover") as handover:
                result = worker.install_autostart("shared-worker-token-123")
            with open(env_path, encoding="utf8") as f:
                self.assertEqual(f.read(), "LLAMACLUSTER_TOKEN=shared-worker-token-123\n")
            with open(unit_path, encoding="utf8") as f:
                unit = f.read()
            self.assertIn("EnvironmentFile=", unit)
            self.assertIn("ExecStart=", unit)
            self.assertNotIn("shared-worker-token-123", unit)
            self.assertEqual(os.stat(env_path).st_mode & 0o777, 0o600)
            self.assertTrue(result["restart_pending"])
            self.assertEqual(fake_worker.token, "shared-worker-token-123")
            self.assertEqual(systemctl.call_args_list[0].args[1], "daemon-reload")
            self.assertEqual(systemctl.call_args_list[1].args[1], "enable")
            handover.assert_called_once_with(start_service=False)

    def test_autostart_requires_strong_safe_token(self):
        with patch.object(worker, "_systemd_user", return_value="/usr/bin/systemctl"):
            with self.assertRaisesRegex(RuntimeError, "12-256"):
                worker.install_autostart("short")

    def test_update_refuses_non_linux_before_running_git(self):
        with patch.object(worker.platform, "system", return_value="Darwin"), \
             patch.object(worker.shutil, "which") as which:
            with self.assertRaisesRegex(RuntimeError, "only on Linux"):
                worker.update_source()
            which.assert_not_called()

    def test_update_refuses_dirty_checkout_without_pulling(self):
        root = "/tmp/llamacluster-test"
        def fake_run(command, **_kwargs):
            if "rev-parse" in command:
                return types.SimpleNamespace(returncode=0, stdout=root + "\n", stderr="")
            if "status" in command:
                return types.SimpleNamespace(returncode=0, stdout=" M worker.py\n", stderr="")
            self.fail("git pull must not run with a dirty checkout")
        with patch.object(worker.platform, "system", return_value="Linux"), \
             patch.object(worker.shutil, "which", return_value="/usr/bin/git"), \
             patch.object(worker.subprocess, "run", side_effect=fake_run), \
             patch.object(worker.os.path, "isfile", return_value=True):
            with self.assertRaisesRegex(RuntimeError, "local changes"):
                worker.update_source()

    def test_update_pulls_origin_main_then_schedules_worker_restart(self):
        root = "/tmp/llamacluster-test"
        def fake_run(command, **_kwargs):
            if "rev-parse" in command:
                return types.SimpleNamespace(returncode=0, stdout=root + "\n", stderr="")
            if "status" in command:
                return types.SimpleNamespace(returncode=0, stdout="", stderr="")
            if "pull" in command:
                self.assertEqual(command[-3:], ["--ff-only", "origin", "main"])
                return types.SimpleNamespace(returncode=0, stdout="Already up to date.\n", stderr="")
            self.fail("unexpected git command")
        with patch.object(worker.platform, "system", return_value="Linux"), \
             patch.object(worker.shutil, "which", return_value="/usr/bin/git"), \
             patch.object(worker.subprocess, "run", side_effect=fake_run), \
             patch.object(worker.os.path, "isfile", return_value=True), \
             patch.object(worker, "_schedule_worker_handover") as handover:
            result = worker.update_source()
        self.assertIn("origin/main", result["message"])
        handover.assert_called_once_with()

    def test_restart_snapshot_restores_model_and_rpc_config(self):
        with tempfile.TemporaryDirectory() as temp:
            path = os.path.join(temp, "restart.json")
            model = {"model": "model.gguf", "ctx_size": 4096}
            rpc = {"threads": 4}
            active_worker = types.SimpleNamespace(
                proc_cfg=model, rpc_cfg=rpc, rpc_proc=types.SimpleNamespace(poll=lambda: None),
                is_running=lambda: True, log=lambda _message: None,
            )
            with patch.object(worker, "W", active_worker), \
                 patch.object(worker, "_restart_model_path", return_value=path):
                worker._save_restart_model()
            restored_worker = types.SimpleNamespace(
                start_server=Mock(), start_rpc=Mock(),
                log=lambda _message: None,
            )
            with patch.object(worker, "W", restored_worker), \
                 patch.object(worker, "_restart_model_path", return_value=path):
                worker._restore_restart_model()
            restored_worker.start_server.assert_called_once_with(model)
            restored_worker.start_rpc.assert_called_once_with(rpc)
            self.assertFalse(os.path.exists(path))


if __name__ == "__main__":
    unittest.main()
