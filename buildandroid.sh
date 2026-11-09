#!/usr/bin/env bash
# Sets up everything needed and builds the Android worker app:   dist/llamacluster-worker.apk
#
#   ./buildandroid.sh                 full build (first run downloads ~2.5 GB: JDK, Android SDK + NDK, Gradle)
#   ./buildandroid.sh --install       ...and `adb install` it on a connected phone (USB debugging on)
#   ./buildandroid.sh --vulkan        EXPERIMENTAL: build llama.cpp with the Vulkan GPU backend
#   ./buildandroid.sh --arch ARCH     CPU target for llama.cpp (default armv8.2-a+dotprod+fp16, see below)
#   ./buildandroid.sh --skip-llama    reuse the llama-server / rpc-server already built (rebuild only the APK)
#   ./buildandroid.sh --clean         wipe the llama.cpp Android build dir first
#
# Environment: LLC_ANDROID_HOME (toolchain cache, default ~/.cache/llamacluster-android),
#              LLAMA_DIR (llama.cpp checkout, default ~/llama.cpp; cloned if missing)
#
# What it does:
#   1. JDK 17, Android SDK (platform 34, build-tools, NDK r26d, cmake/ninja) and Gradle - only what is missing
#   2. cross-compiles llama.cpp's llama-server and rpc-server for arm64-v8a (static, CPU, RPC enabled)
#   3. puts them in the app as lib*.so (the only place Android lets an app execute files from)
#   4. copies worker.py into the app (it runs inside the app with Chaquopy) and builds + signs the APK
#
# Needs Linux x86_64 (WSL2 is fine), curl, unzip, tar, git, python3 (3.8+), ~6 GB free disk.
# ARCH: phones from ~2018 on (Snapdragon 845+, Tensor, Exynos 9810+) have dotprod+fp16. Very old phones crash with
# "illegal instruction": use  --arch armv8-a . Newer phones (Snapdragon 8 Gen 1+, Tensor G2+) are faster with
# --arch armv8.6-a+i8mm+dotprod+fp16 (if it crashes with "illegal instruction", go back to the default).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WORK="${LLC_ANDROID_HOME:-$HOME/.cache/llamacluster-android}"
LLAMA_DIR="${LLAMA_DIR:-$HOME/llama.cpp}"
ARCH="armv8.2-a+dotprod+fp16"
VULKAN=OFF; SKIP_LLAMA=0; INSTALL=0; CLEAN=0

JDK_MAJOR=17
CMDLINE_TOOLS_URL="https://dl.google.com/android/repository/commandlinetools-linux-11076708_latest.zip"
NDK_VERSION="26.3.11579264"
CMAKE_VERSION="3.22.1"
BUILD_TOOLS="34.0.0"
PLATFORM="android-34"
GRADLE_VERSION="8.7"
ANDROID_API_MIN=28          # NDK platform level for llama.cpp (the app itself supports Android 8+)

while [ $# -gt 0 ]; do
  case "$1" in
    --vulkan) VULKAN=ON ;;
    --arch) ARCH="${2:?--arch needs a value}"; shift ;;
    --skip-llama) SKIP_LLAMA=1 ;;
    --install) INSTALL=1 ;;
    --clean) CLEAN=1 ;;
    -h|--help) sed -n '2,25p' "$0"; exit 0 ;;
    *) echo "unknown option: $1 (try --help)"; exit 2 ;;
  esac
  shift
done

say() { printf '\n\033[1;36m>> %s\033[0m\n' "$*"; }
die() { printf '\033[1;31mERROR: %s\033[0m\n' "$*" >&2; exit 1; }

[ "$(uname -s)" = Linux ] || die "run this on Linux (on Windows use WSL2 Ubuntu)"
[ "$(uname -m)" = x86_64 ] || die "the Android NDK only ships for x86_64 Linux hosts (this is $(uname -m))"
for t in curl unzip tar git python3; do command -v "$t" >/dev/null 2>&1 || die "'$t' is required (sudo apt install $t)"; done
python3 -c 'import sys; sys.exit(0 if sys.version_info >= (3, 8) else 1)' || die "python3 3.8+ required"
mkdir -p "$WORK" "$ROOT/dist"

fetch() {   # fetch URL DEST  (resumable)
  curl -fL --retry 5 --retry-delay 3 -C - -o "$2" "$1" || die "download failed: $1 (is the network / a proxy blocking it?)"
}

# ------------------------------------------------------------------ 1. JDK
java_ok() {
  local j="$1/bin/java"; [ -x "$j" ] && [ -x "$1/bin/javac" ] || return 1
  local v; v="$("$j" -version 2>&1 | sed -n '1s/.*version "\([0-9]*\).*/\1/p')"
  [ -n "$v" ] && [ "$v" -ge "$JDK_MAJOR" ]
}
if [ -n "${JAVA_HOME:-}" ] && java_ok "$JAVA_HOME"; then :
elif command -v javac >/dev/null 2>&1 && java_ok "$(dirname "$(dirname "$(readlink -f "$(command -v javac)")")")"; then
  JAVA_HOME="$(dirname "$(dirname "$(readlink -f "$(command -v javac)")")")"
elif java_ok "$WORK/jdk"; then JAVA_HOME="$WORK/jdk"
else
  say "downloading JDK $JDK_MAJOR (Temurin)"
  fetch "https://api.adoptium.net/v3/binary/latest/$JDK_MAJOR/ga/linux/x64/jdk/hotspot/normal/eclipse" "$WORK/jdk.tar.gz"
  rm -rf "$WORK/jdk" "$WORK/jdk-tmp"; mkdir -p "$WORK/jdk-tmp"
  tar -xzf "$WORK/jdk.tar.gz" -C "$WORK/jdk-tmp" --strip-components=1
  mv "$WORK/jdk-tmp" "$WORK/jdk"; rm -f "$WORK/jdk.tar.gz"
  java_ok "$WORK/jdk" || die "downloaded JDK does not work"
  JAVA_HOME="$WORK/jdk"
fi
export JAVA_HOME; export PATH="$JAVA_HOME/bin:$PATH"
say "JDK: $JAVA_HOME"

# ------------------------------------------------------------------ 2. Android SDK + NDK
export ANDROID_HOME="${ANDROID_HOME:-$WORK/sdk}"; export ANDROID_SDK_ROOT="$ANDROID_HOME"
SDKMGR="$ANDROID_HOME/cmdline-tools/latest/bin/sdkmanager"
if [ ! -x "$SDKMGR" ]; then
  say "downloading Android command-line tools"
  mkdir -p "$ANDROID_HOME/cmdline-tools"
  fetch "$CMDLINE_TOOLS_URL" "$WORK/cmdline-tools.zip"
  rm -rf "$ANDROID_HOME/cmdline-tools/latest" "$WORK/cmdtmp"; mkdir -p "$WORK/cmdtmp"
  unzip -q "$WORK/cmdline-tools.zip" -d "$WORK/cmdtmp"
  mv "$WORK/cmdtmp/cmdline-tools" "$ANDROID_HOME/cmdline-tools/latest"; rm -rf "$WORK/cmdtmp" "$WORK/cmdline-tools.zip"
fi
NDK="$ANDROID_HOME/ndk/$NDK_VERSION"
NEED=()
[ -d "$ANDROID_HOME/platforms/$PLATFORM" ]        || NEED+=("platforms;$PLATFORM")
[ -d "$ANDROID_HOME/build-tools/$BUILD_TOOLS" ]   || NEED+=("build-tools;$BUILD_TOOLS")
[ -d "$ANDROID_HOME/platform-tools" ]             || NEED+=("platform-tools")
[ -d "$NDK" ]                                     || NEED+=("ndk;$NDK_VERSION")
[ -x "$ANDROID_HOME/cmake/$CMAKE_VERSION/bin/cmake" ] || NEED+=("cmake;$CMAKE_VERSION")
if [ ${#NEED[@]} -gt 0 ]; then
  say "installing Android SDK packages: ${NEED[*]}  (NDK is ~1 GB)"
  yes | "$SDKMGR" --sdk_root="$ANDROID_HOME" --licenses >/dev/null 2>&1 || true
  "$SDKMGR" --sdk_root="$ANDROID_HOME" "${NEED[@]}" || die "sdkmanager failed"
fi
[ -d "$NDK" ] || die "NDK not found at $NDK"
CMAKE="$ANDROID_HOME/cmake/$CMAKE_VERSION/bin/cmake"; NINJA="$ANDROID_HOME/cmake/$CMAKE_VERSION/bin/ninja"
STRIP="$NDK/toolchains/llvm/prebuilt/linux-x86_64/bin/llvm-strip"
echo "sdk.dir=$ANDROID_HOME" > "$ROOT/android/local.properties"

# ------------------------------------------------------------------ 3. llama.cpp for Android
JNI="$ROOT/android/app/src/main/jniLibs/arm64-v8a"
mkdir -p "$JNI"
if [ "$SKIP_LLAMA" = 0 ]; then
  if [ ! -d "$LLAMA_DIR/.git" ]; then
    say "cloning llama.cpp into $LLAMA_DIR"
    git clone --depth 1 https://github.com/ggml-org/llama.cpp "$LLAMA_DIR"
  else
    echo "using existing llama.cpp checkout: $LLAMA_DIR (git pull there to update it)"
  fi
  B="$LLAMA_DIR/build-android-arm64"
  [ "$CLEAN" = 1 ] && rm -rf "$B"
  say "cross-compiling llama-server + rpc-server  (arm64, -march=$ARCH, Vulkan=$VULKAN)"
  EXTRA=()
  if [ "$VULKAN" = ON ]; then
    # Experimental. Needs the Vulkan C++ headers (vulkan.hpp) - install `libvulkan-dev` / `vulkan-headers` on the
    # host if the configure step complains. glslc ships inside the NDK.
    GLSLC="$(ls "$NDK"/shader-tools/linux-x86_64/glslc 2>/dev/null || true)"
    [ -n "$GLSLC" ] || die "glslc not found in the NDK"
    EXTRA+=(-DGGML_VULKAN=ON -DVulkan_GLSLC_EXECUTABLE="$GLSLC"
            -DVulkan_LIBRARY="$NDK/toolchains/llvm/prebuilt/linux-x86_64/sysroot/usr/lib/aarch64-linux-android/$ANDROID_API_MIN/libvulkan.so"
            -DVulkan_INCLUDE_DIR="$NDK/toolchains/llvm/prebuilt/linux-x86_64/sysroot/usr/include")
  else
    EXTRA+=(-DGGML_VULKAN=OFF)
  fi
  "$CMAKE" -S "$LLAMA_DIR" -B "$B" -G Ninja -DCMAKE_MAKE_PROGRAM="$NINJA" \
    -DCMAKE_TOOLCHAIN_FILE="$NDK/build/cmake/android.toolchain.cmake" \
    -DANDROID_ABI=arm64-v8a -DANDROID_PLATFORM="android-$ANDROID_API_MIN" \
    -DCMAKE_BUILD_TYPE=Release \
    -DCMAKE_C_FLAGS="-march=$ARCH" -DCMAKE_CXX_FLAGS="-march=$ARCH" \
    -DGGML_CPU_ARM_ARCH="$ARCH" -DGGML_NATIVE=OFF \
    -DBUILD_SHARED_LIBS=OFF -DGGML_OPENMP=OFF -DGGML_RPC=ON \
    -DLLAMA_CURL=OFF -DLLAMA_BUILD_SERVER=ON -DLLAMA_BUILD_TESTS=OFF -DLLAMA_BUILD_EXAMPLES=OFF \
    "${EXTRA[@]}"
  # llama.cpp renames targets now and then: ask the generated build which one is the RPC server
  ALL_TARGETS="$("$NINJA" -C "$B" -t targets all 2>/dev/null | cut -d: -f1)"
  RPC_TARGET=""
  for t in rpc-server ggml-rpc-server llama-rpc-server; do
    if printf '%s\n' "$ALL_TARGETS" | grep -qx "$t"; then RPC_TARGET="$t"; break; fi
  done
  if [ -z "$RPC_TARGET" ]; then
    echo "targets mentioning rpc in this llama.cpp checkout:"
    printf '%s\n' "$ALL_TARGETS" | grep -i rpc || echo "  (none)"
    die "could not find the RPC server target - paste the list above and adjust RPC_TARGET"
  fi
  echo "   RPC server target: $RPC_TARGET"
  "$CMAKE" --build "$B" --config Release -j"$(nproc)" --target llama-server "$RPC_TARGET"
  # the app always expects libllama-server.so + librpc-server.so, whatever the upstream binary is called
  for pair in "llama-server:llama-server" "$RPC_TARGET:rpc-server"; do
    src="${pair%%:*}"; dst="${pair##*:}"
    [ -f "$B/bin/$src" ] || die "$src was not produced ($B/bin/$src)"
    cp "$B/bin/$src" "$JNI/lib$dst.so"
    "$STRIP" "$JNI/lib$dst.so" || true
  done
fi
for bin in llama-server rpc-server; do
  f="$JNI/lib$bin.so"
  [ -f "$f" ] || die "$f missing - run without --skip-llama"
  python3 - "$f" <<'PY' || die "$f is not an arm64 ELF executable"
import sys
h = open(sys.argv[1], "rb").read(20)
sys.exit(0 if h[:4] == b"\x7fELF" and h[18] == 0xB7 else 1)   # e_machine 183 = AArch64
PY
  echo "   $(basename "$f")  $(du -h "$f" | cut -f1)"
done

# ------------------------------------------------------------------ 4. the app
say "preparing the app (worker.py is bundled so the phone runs the same worker as every other node)"
cp "$ROOT/worker.py" "$ROOT/android/app/src/main/python/worker.py"

GRADLE_HOME="$WORK/gradle-$GRADLE_VERSION"
if [ ! -x "$GRADLE_HOME/bin/gradle" ]; then
  say "downloading Gradle $GRADLE_VERSION"
  fetch "https://services.gradle.org/distributions/gradle-$GRADLE_VERSION-bin.zip" "$WORK/gradle.zip"
  unzip -q -o "$WORK/gradle.zip" -d "$WORK"; rm -f "$WORK/gradle.zip"
fi

# one stable signing key, so a rebuilt APK installs over the old one
export LLC_KEYSTORE="$WORK/llamacluster.keystore" LLC_KS_PASS="llamacluster" LLC_KEY_ALIAS="llc"
if [ ! -f "$LLC_KEYSTORE" ]; then
  keytool -genkeypair -keystore "$LLC_KEYSTORE" -storepass "$LLC_KS_PASS" -keypass "$LLC_KS_PASS" -alias "$LLC_KEY_ALIAS" \
    -keyalg RSA -keysize 2048 -validity 10000 -dname "CN=LlamaCluster Worker" >/dev/null 2>&1 || die "keytool failed"
fi
export LLC_BUILD_PYTHON="$(command -v python3)"

say "building the APK with Gradle (first run downloads Chaquopy + Python for Android)"
"$GRADLE_HOME/bin/gradle" -p "$ROOT/android" --no-daemon -q assembleRelease || die "Gradle build failed (scroll up for the reason)"
APK="$ROOT/android/app/build/outputs/apk/release/app-release.apk"
[ -f "$APK" ] || die "APK not found at $APK"
cp "$APK" "$ROOT/dist/llamacluster-worker.apk"
say "done: $ROOT/dist/llamacluster-worker.apk  ($(du -h "$ROOT/dist/llamacluster-worker.apk" | cut -f1))"

if [ "$INSTALL" = 1 ]; then
  ADB="$ANDROID_HOME/platform-tools/adb"
  say "installing on the connected phone"
  "$ADB" install -r "$ROOT/dist/llamacluster-worker.apk" || die "adb install failed (USB debugging on? phone authorised?)"
else
  cat <<MSG

Install: copy dist/llamacluster-worker.apk to the phone and open it (allow "install unknown apps"),
or run  ./buildandroid.sh --skip-llama --install  with the phone connected over USB.
Then open the app, press Start worker, and add the shown URL + token as a node in the controller.
MSG
fi
