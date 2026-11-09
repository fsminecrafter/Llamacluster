"""Run a LlamaCluster worker on Modal (GPU), reachable over HTTPS.

Setup (once):
    pip install modal && modal setup
    modal secret create llamacluster-token LLAMACLUSTER_TOKEN=<pick-a-long-random-string>

Deploy:
    modal deploy cloud/modal_worker.py

Modal prints a URL like https://<you>--llamacluster-worker.modal.run
Add it in the LlamaCluster UI with that same token (type: Modal).

Models are stored on a Modal Volume so they survive container restarts.
The container scales to zero when idle (cost control); the first request after
idle takes a cold start, then you must press Start for the model again.
"""
import os
import subprocess

import modal

GPU = os.environ.get("LC_MODAL_GPU", "L4")  # e.g. T4, L4, A10G, A100-40GB

here = os.path.dirname(os.path.abspath(__file__))
worker_py = os.path.join(here, "..", "worker.py")

image = (
    modal.Image.from_registry("nvidia/cuda:12.4.1-devel-ubuntu22.04", add_python="3.11")
    .apt_install("git", "cmake", "build-essential", "curl", "libcurl4-openssl-dev")
    .run_commands(
        "git clone --depth 1 https://github.com/ggml-org/llama.cpp /opt/llama.cpp",
        # CUDA stubs let the build link without a GPU present at build time
        "cd /opt/llama.cpp && cmake -B build -DGGML_CUDA=ON -DGGML_RPC=OFF "
        "-DCMAKE_CUDA_ARCHITECTURES='75;80;86;89' "
        "-DCMAKE_EXE_LINKER_FLAGS=-Wl,--allow-shlib-undefined && "
        "cmake --build build --config Release -j --target llama-server",
    )
    .add_local_file(worker_py, "/app/worker.py")
)

app = modal.App("llamacluster")
models = modal.Volume.from_name("llamacluster-models", create_if_missing=True)


@app.function(
    image=image,
    gpu=GPU,
    volumes={"/models": models},
    secrets=[modal.Secret.from_name("llamacluster-token")],
    scaledown_window=600,   # seconds idle before the container (and billing) stops
    timeout=24 * 3600,
    max_containers=1,       # one GPU box per node; add more nodes for more capacity
)
@modal.concurrent(max_inputs=32)
@modal.web_server(7860, startup_timeout=120)
def worker():
    subprocess.Popen(
        ["python", "/app/worker.py", "--host", "0.0.0.0", "--port", "7860",
         "--name", f"modal-{GPU}", "--models-dir", "/models",
         "--llama-server", "/opt/llama.cpp/build/bin/llama-server"],
        env=os.environ.copy(),
    )
