# LlamaCluster worker for Google Colab.
#
# 1. Colab: Runtime > Change runtime type > GPU (T4 is fine)
# 2. Upload worker.py to the Colab file panel (left sidebar), or paste it into a cell.
# 3. Paste each "# %%" block below into its own cell and run them in order.
# 4. Copy the printed https://....trycloudflare.com URL + token into LlamaCluster > Add node (type: Colab).
#
# Colab sessions are temporary (~12h max, and idle disconnects). Use Drive for models if you
# want them to survive: set MODELS_DIR to a path under /content/drive/MyDrive.

# %% Cell 1 - build llama.cpp with CUDA (about 6-10 minutes, once per session)
import os, subprocess
if not os.path.exists("/content/llama.cpp/build/bin/llama-server"):
    subprocess.run("git clone --depth 1 https://github.com/ggml-org/llama.cpp /content/llama.cpp", shell=True, check=True)
    subprocess.run("cd /content/llama.cpp && cmake -B build -DGGML_CUDA=ON -DCMAKE_CUDA_ARCHITECTURES=75 "
                   "&& cmake --build build --config Release -j --target llama-server", shell=True, check=True)
print("llama-server ready")

# %% Cell 2 - (optional) keep models on Google Drive
# from google.colab import drive; drive.mount('/content/drive')
MODELS_DIR = "/content/models"   # or "/content/drive/MyDrive/llamacluster-models"

# %% Cell 3 - start worker + public tunnel
import re, secrets, subprocess, time, os
TOKEN = secrets.token_urlsafe(24)
os.makedirs(MODELS_DIR, exist_ok=True)

subprocess.run("wget -q https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64 "
               "-O /content/cloudflared && chmod +x /content/cloudflared", shell=True, check=True)

worker = subprocess.Popen(
    ["python", "/content/worker.py", "--host", "127.0.0.1", "--port", "7860", "--token", TOKEN,
     "--name", "colab", "--models-dir", MODELS_DIR,
     "--llama-server", "/content/llama.cpp/build/bin/llama-server"])
tunnel = subprocess.Popen(["/content/cloudflared", "tunnel", "--url", "http://127.0.0.1:7860", "--no-autoupdate"],
                          stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
url = None
for line in tunnel.stdout:
    m = re.search(r"https://[a-z0-9-]+\.trycloudflare\.com", line)
    if m:
        url = m.group(0); break
print("\nURL:  ", url)
print("TOKEN:", TOKEN)
print("\nKeep this cell running. Add the node in LlamaCluster with the URL and token above.")
while True:
    time.sleep(60)   # keeps the cell (and the tunnel) alive
