"""Entry point used by the Android app (Chaquopy). worker.py itself is copied next to this file by
buildandroid.sh, so the phone runs exactly the same worker code as every other node."""
import argparse
import os

import worker


def run(name, token, models_dir, native_dir, port, device, hf_token=""):
    """Blocks until stop() is called."""
    os.environ["LLAMACLUSTER_NATIVE_DIR"] = native_dir      # where lib llama-server / rpc-server live
    os.environ["LLAMACLUSTER_DEVICE"] = device
    if hf_token:
        os.environ["HF_TOKEN"] = hf_token
    os.makedirs(models_dir, exist_ok=True)
    worker.kill_orphans(native_dir)                         # leftovers from a previous crash of the app
    args = argparse.Namespace(host="0.0.0.0", port=int(port), token=token, name=name,
                              models_dir=models_dir, llama_server="", rpc_server="",
                              llama_port=8080, rpc_port=50052)
    worker.serve(args, install_signals=False)               # signal handlers only work on the main thread


def stop():
    worker.stop()


def info(native_dir):
    """What the app shows on its main screen."""
    return {"llama_server": os.path.isfile(os.path.join(native_dir, "libllama-server.so")),
            "rpc_server": os.path.isfile(os.path.join(native_dir, "librpc-server.so"))}
