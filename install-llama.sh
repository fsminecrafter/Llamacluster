#!/usr/bin/env bash
# Builds llama.cpp (llama-server + rpc-server) into ~/llama.cpp/build/bin
# Usage: ./install-llama.sh [cuda|vulkan|cpu]    (default: auto-detect)
set -euo pipefail

BACKEND="${1:-auto}"
DIR="$HOME/llama.cpp"

if [ "$BACKEND" = auto ]; then
  if command -v nvcc >/dev/null 2>&1; then BACKEND=cuda
  elif command -v glslc >/dev/null 2>&1 || command -v vulkaninfo >/dev/null 2>&1; then BACKEND=vulkan
  else BACKEND=cpu; fi
fi
echo ">> backend: $BACKEND"

if command -v apt-get >/dev/null 2>&1; then
  echo ">> installing build deps (sudo needed)"
  sudo apt-get update -qq
  sudo apt-get install -y git cmake build-essential libcurl4-openssl-dev
elif command -v dnf >/dev/null 2>&1; then
  sudo dnf install -y git cmake gcc-c++ libcurl-devel
elif command -v pacman >/dev/null 2>&1; then
  sudo pacman -S --needed --noconfirm git cmake base-devel curl
fi

[ -d "$DIR/.git" ] && git -C "$DIR" pull --ff-only || git clone --depth 1 https://github.com/ggml-org/llama.cpp "$DIR"

# Set every backend explicitly: CMake caches flags in build/CMakeCache.txt, so a
# previous run (e.g. a failed Vulkan attempt) would otherwise stay enabled.
CUDA=OFF; VULKAN=OFF
case "$BACKEND" in
  cuda)   CUDA=ON ;;
  vulkan) VULKAN=ON ;;
esac
FLAGS="-DGGML_RPC=ON -DGGML_CUDA=$CUDA -DGGML_VULKAN=$VULKAN"

cmake -S "$DIR" -B "$DIR/build" $FLAGS -DCMAKE_BUILD_TYPE=Release
# llama.cpp renames targets now and then: find what the RPC server is called in this checkout
RPC_TARGET=""
for t in rpc-server ggml-rpc-server llama-rpc-server; do
  if cmake --build "$DIR/build" --target help 2>/dev/null | grep -qE "\\.\\.\\. $t\\b"; then RPC_TARGET="$t"; break; fi
done
[ -n "$RPC_TARGET" ] || { echo "no RPC server target found; candidates:"; cmake --build "$DIR/build" --target help | grep -i rpc; exit 1; }
cmake --build "$DIR/build" --config Release -j"$(nproc)" --target llama-server "$RPC_TARGET"
# worker.py looks for a binary called rpc-server
[ "$RPC_TARGET" = rpc-server ] || ln -sf "$RPC_TARGET" "$DIR/build/bin/rpc-server"

echo ">> done: $DIR/build/bin/llama-server and rpc-server"
