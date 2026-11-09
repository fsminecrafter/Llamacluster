# LlamaCluster

Run llama.cpp models across several machines — your LAN, Modal, Google Colab — from one web UI,
with a single OpenAI-compatible endpoint in front of all of them.

```
 your apps ──► controller :7870  ──┬─► worker (LAN PC)      ─► llama-server
 (OpenAI API)  UI + load balancer  ├─► worker (LAN laptop)  ─► llama-server
                                   ├─► worker (Modal, HTTPS)─► llama-server
                                   └─► worker (Colab, tunnel)► llama-server
```

No dependencies beyond Python 3.8+ (standard library only).

## 1. On every machine that will run models (the "worker")

```bash
./install-llama.sh            # builds llama.cpp (CUDA / Vulkan / CPU auto-detected)
python3 worker.py --token <shared-secret> --name my-pc
```

Models go in `~/llamacluster-models` (change with `--models-dir`). Port 7860.
Use a token on anything reachable by other people. Set `HF_TOKEN` in the environment for gated models.

## 2. On the machine you sit at (the "controller")

```bash
python3 controller.py        # UI + API on your whole network, port 7870 (see "Hosting on your LAN" below)
```

Open the UI → **Add node** (or **Scan LAN**) → give the worker URL + token.
Per node you can: pick a model, change settings (context, GPU layers, threads, parallel slots,
batch sizes, any extra `llama-server` flags), start/stop, view logs, and **install models**
(Hugging Face search, or a direct `.gguf` URL — downloaded straight onto that node).

**Workspace → Tools → Worker services** can install or uninstall a Linux systemd user autostart service on configured worker nodes, restart all workers, or update each worker with `git pull --ff-only origin main` and restart it. Installation asks for a shared worker token and whether the selected controller node also runs a worker. Only nodes whose reported OS is Linux are sent an install request; the worker also checks for a usable systemd user manager before writing its service. User services start on login; boot before login may require enabling systemd lingering for that account. Updates refuse dirty git checkouts and require a Linux worker with a clean LlamaCluster clone and Git access to `origin/main`. Restarts preserve and relaunch the active model with its current settings.

**Downloads survive power cuts and network drops.** A dropped connection is retried automatically with backoff and
resumes from the `.part` file (HTTP Range). Progress is journaled in `<models-dir>/.downloads.json` (fsynced every 32 MiB,
mode 0600 because it can hold a node-copy token); when a worker starts it resumes any interrupted download, trimming the
`.part` back to the last fsynced byte first, and re-downloads any finished model whose size or GGUF header no longer
matches what was downloaded. Node-to-node *Send to…* copies resume too (the source worker serves Range requests).
A `.part` from before this feature has no recorded source: start the same download again and it resumes from there.

Point any OpenAI client at `http://<controller>:7870/v1`. Requests go to the least-busy ready node (weighted by node capacity),
failing over to another if one errors. If the request's `model` matches a node's loaded model
(e.g. `"model": "qwen2.5-7b"`), only those nodes are used.

### Hosting on your LAN

`controller.py` now listens on `0.0.0.0` by default, so phones, laptops and other apps on your network can use it.
On start it prints the addresses to use, for example:

```
other devices :  http://192.168.1.23:7870/#token=AbC...      <- open this on another device
OpenAI base URL:  http://192.168.1.23:7870/v1   (API key = the token)
```

* **Access token** - because the chat tools can write files and run commands, a random token is generated on first
  start (kept in `~/.config/llamacluster/controller.token`, mode 600). The computer running the controller doesn't need it;
  other devices are asked once (or open the printed link, which fills it in) and remember it. Use `--token` to pick your own,
  `--no-exec` to remove shell access altogether, `--local-only` (or `--host 127.0.0.1`) to keep it on this computer, and
  `--no-token` only on a network you fully trust.
* **Firewall** - if another device can't connect, allow TCP port 7870 (Windows: "Allow an app through firewall" / `netsh advfirewall`;
  Linux: `sudo ufw allow 7870/tcp`). Workers need port 7860 reachable from the controller.
* The page works over plain `http://` on the LAN (copy buttons fall back to a manual method where browsers only allow
  the clipboard API on https). Keep the tab open while Software mode runs; phones that sleep stop the loop.
* Browser apps on other origins can call `/v1` (CORS preflight now allows `Authorization`).

## 3. Cloud nodes

**Modal** — `modal deploy cloud/modal_worker.py` (see header of the file for the 2-step setup). Add the printed
`https://…modal.run` URL with your token, type Modal. Scales to zero when idle.

**Colab** — open `cloud/colab_worker.py`, paste its `# %%` blocks into notebook cells, run. It prints a
`trycloudflare.com` URL and a random token. Add them as a Colab node.

## 4. One big model across several machines (RPC)

UI → **Distributed model (RPC)**. Pick a head node (holds the GGUF, runs llama-server) and helper
LAN nodes; helpers run llama.cpp's `rpc-server` and the head offloads layers to them.
Caveats: LAN only (needs raw TCP, not HTTP tunnels), fast network helps a lot, the RPC protocol is
unauthenticated — keep it on a trusted network. This is for models too big for one machine; for
throughput on models that fit, use the normal load-balanced mode. Android phones running the worker app can be helpers.

* **⚡ Maximise RPC model** (in the dialog) — for the selected model it pools the head's GPU memory and the helpers' memory
  (a helper's GPU if it has one, otherwise its RAM), then fills in context, parallel slots, GPU layers and an 8-bit KV cache if that is
  what makes it fit. With *fewest helpers* ticked it adds helpers (largest first) only until the whole model fits on devices with ≥ 4k
  context per slot — every extra helper adds network delay. llama.cpp splits layers between devices in proportion to their free
  memory, so a slow device with lots of RAM (a phone) takes a big share and can slow everything down; the estimate shows this.
* **🎯 Find RPC model** — in 🎯 *Recommend model* choose *Distributed (RPC)*: pick the head and helpers and it looks for the most capable
  model that fits in the **pooled** memory at your target speed (speed estimate includes a network delay per helper, default 3 ms —
  set 1 for wired gigabit, 8+ for Wi-Fi). *Install on head* downloads the file only on the head; *Open in RPC launcher* then
  preselects the nodes and runs Maximise. Estimates only — measure the real speed.

## 4b. Android phone as a worker (APK)

`./buildandroid.sh` sets up everything it needs (JDK 17, Android SDK + NDK, Gradle) under `~/.cache/llamacluster-android`,
cross-compiles `llama-server` and `rpc-server` for arm64, and builds `dist/llamacluster-worker.apk` (Linux x86_64 or WSL2;
first run downloads a few GB). Options: `--install` (adb), `--arch`, `--skip-llama`, `--clean`, `--vulkan` (experimental); see the
header of the script.

On the phone: install the APK, open **LlamaCluster Worker**, press *Start worker*, then add the URL + token it shows as a node
in the controller (Scan LAN also finds it). It is the same `worker.py` as everywhere else, run inside the app with Chaquopy,
so installing models, Send to…, Maximise and Recommend all work. The phone runs on the **CPU** only (no GPU backend by default),
so use small models (1–4B, Q4) for normal serving, or make it an RPC helper to lend its RAM to a bigger model.
Keep it on Wi-Fi and charging, and press *Allow running in background* so Android doesn't kill it.
Models live in the app's storage and are deleted on uninstall. **The build script has not been run in the environment where
it was written** (no access to the Android SDK servers) — expect to fix small things, and report the first error you hit.

## 5. Chat, Maximise node, Maximise cluster

**💬 Chat** (header button) — a streaming chat drawer that talks to the gateway. The assistant is called **Calcium**
(made by XLABS): that identity is in the default system prompt (🗂 Workspace → System prompt; *Reset* restores it), and an
animated Calcium icon (a hexagonal node ring with a light travelling around it) pulses next to the reply and in the chat header while it is thinking, writing or running tools.
Other apps calling the `/v1` endpoint are not affected — they bring their own system prompt. Pick a model, or pin a request to
one node with *Send to* (sent as an `X-LlamaCluster-Target: <node name>` header; leave on Auto for load balancing).
System prompt, temperature and max tokens are under the fold; Stop/↻ interrupt and regenerate. History lives in your browser only.
Press **Ctrl+Enter** to add a message to the send queue; queued messages send in order after the current reply.
Chat generation runs in a controller-managed stream, so a temporary browser disconnect or sleeping tab does not close the model's
request; when the page reconnects it replays the buffered output. Pressing **Stop** still cancels the active generation.

Type `/btw <question>` while Calcium is working to ask a side question in a separate request; it does not stop or enter the active conversation. Under **Workspace → Tools**, **Compact behavior** chooses AI summaries or a deterministic script snapshot (last user message, tool call and AI output, up to 300 characters each). AI compaction falls back to the snapshot if it errors or returns an empty answer. The context gauge separates tool definitions, tool-call overhead and tool outputs.

Slash commands include `/models` (show ready models), `/read <file>` (add a workspace text file to the chat), and `/view <image>` (send a workspace image to the selected vision model). File paths autocomplete from the controller workspace. `/schedule 09:00-11-28 <prompt>` schedules a one-time prompt for 09:00 on November 28 in the browser's local time; you can also provide only `HH:MM` or `MM-DD` (date-only runs at 09:00). Dates without a year use the next future occurrence. Scheduled prompts run on the controller even if the browser is closed, but do not have chat tools; use `/schedule list` to review them and `/schedule cancel <id>` to cancel.

**Layout & saved settings** — drag the chat's left edge to resize it (double-click the edge to reset), or press ⛶ for a fullscreen chat (Esc leaves it); both are remembered. Each node's ⚙ Settings (context, GPU layers, threads, slots, batch, extra args) are saved **per model, per node** in your browser: switching the Model dropdown loads that model's own config, editing or pressing Start saves it, and “reset this model” returns to the defaults. The chat's temperature and max-tokens are also remembered per model. The browser tab uses the Calcium icon.

**Tool calls** show as compact chips instead of raw JSON: *Writing…* (shimmering while the model is still producing it) becomes *Wrote ›*; click it to see the file's code with syntax colours - live while it is being written - plus a Copy button. *Read ›* shows the file that was read, *Edited ›* a red/green before/after, *Ran ›* the command and its output, *Listed ›* / *Searched files ›* the entries and matches. *Searched ↗* and *Fetched ↗* open the search or page in a new tab; “results ▾” next to a search lists what it found. Failed calls turn red and show the error when opened.

**⚡ Maximise** (on each node) — fills the node's settings with what uses the most of that machine for the selected model:
whole model on GPU if it fits (else as many layers as fit, else CPU), leftover VRAM/RAM turned into context and
parallel slots (aiming for ≥ 8k tokens per slot, up to 8 slots on GPU), threads for the CPU path, batch sizes, and an
8-bit KV cache only when that is what makes it fit. Review the plan, then *Apply*.

**⚡ Maximise cluster** (header) — looks at every online node and picks the best setup for the cluster as a whole:
* one primary model by goal — *Balanced* (biggest model that keeps ≥ 50 % of the best possible throughput),
  *Throughput* (most requests/s) or *Quality* (biggest model that runs well somewhere);
* per-node GPU layers / threads / slots, with the **same per-request context on every node** so a request never
  fails just because it landed on a smaller machine;
* a load-balancing **weight** per node, so faster nodes get proportionally more traffic. The gateway now uses
  weighted least-connections (idle requests go to the strongest node, overflow spreads by weight).
Nodes that can't run the main model fall back to the best model they can run (shown, and off by default if they'd
add little); untick any row to leave that node alone.

Sizing uses the model's real layer count and KV-cache size, read from the GGUF header by the worker — **update
`worker.py` on every node** (and redeploy the Modal/Colab ones) or the planner falls back to rough per-GB guesses.
All figures (including "≈ t/s") are estimates; check the node logs after applying and lower context/slots if a
node runs out of memory.


**⏱ Benchmark models** (button on each node card) — tick the installed models to measure. For each one the worker starts a temporary
`llama-server` with that model's saved settings (one slot, so it is single-stream speed), generates 96 tokens after a short warm-up, and
unloads it. The generation speed shows in bold next to the size in *Installed models* (hover for prompt-processing speed and the settings used);
a model that doesn't fit shows “bench failed” with the reason on hover. The node's model server has to be stopped first, and Start is disabled
while a benchmark runs (Cancel is on the card). Results are kept in `<models-dir>/.bench.json` and dropped if the model file changes or is deleted.
Needs the updated `worker.py` on the node.

**Move Models** (button on each node card) copies the complete model directory, verifies the copied files, then persists the new location for the next worker restart. Stop the model server and finish downloads or benchmarks first. Choose a detected storage volume or enter an advanced destination path; enough free space is required.

### Clear, `/compact` and auto-compact

* **Clear** now empties everything the model can see: messages and tool results, any compaction summary, software-mode state and a pending question. If a run was still going (for example a tool call in flight), it is stopped and wiped again when it ends, so late results can't land in the new chat.
* **`/compact [focus]`** (type `/` in the box for the list) asks the model for a summary of the older conversation and replaces it with a 📦 note. The summary goes into the system prompt, so it works with models that need strictly alternating roles. Your latest request and the last few steps stay word for word; long old tool results are shortened. A second `/compact` folds the previous summary into the new one. `/clear` does the same as the Clear button.
* **Auto-compact** runs by itself before a model step when the context is at 97 % or more *and* the conversation (not just the system prompt and tool definitions) fills at least a quarter of the window. At most twice per run. The ring shows the usage.

### Reasoning effort and image input

**🧠 Reasoning effort** (chat → *Model & sampling*) — the selector appears only when the selected model supports it. The worker reads
the model's own chat template from the GGUF: a template that uses `reasoning_effort` (gpt-oss) gives **Default / Low / Medium / High**,
one that uses `enable_thinking` (Qwen3 and similar) gives **Default / Off / On**. The choice is sent with each request
(`reasoning_effort` and `chat_template_kwargs`) and remembered per model. Models whose template has no such switch don't show it
(a 🧠 marks supported models in *Installed models*). Needs the **updated `worker.py`** on the node, then restart the model once so the
list refreshes; `llama-server` is already started with `--jinja`.

**🖼 Image input** — a multimodal model needs two files: the model and its **vision projector** (`mmproj-*.gguf`). In a node's per-model settings, enable **Multimodal model (enable image input)** and choose a projector, or leave it on Auto to match by name. Install both
(the Hugging Face file list marks projectors with 👁; they are saved as `<repo>-mmproj-….gguf` so projectors from different repos don't
overwrite each other). Projectors are listed separately from models. The image-input assignment and projector choice are saved per model and node; choose *None* or turn the assignment off for a text-only configuration. When the model is running with a projector the
node shows 👁 vision and the chat's 📎 button works: attach, paste or drag in images (JPEG/PNG/WebP…, up to 6 per message, shrunk to 1280 px
in the browser). Images can be staged before selecting a vision model, but sending them requires a ready multimodal model. Images stay in your browser (IndexedDB), never in the saved chat text, and older pictures in the history are replaced by a short note instead of being sent to a text-only model. Vision models also get the optional **View image** tool: it can inspect a workspace image by path or a previous chat attachment. The context viewer adds a cyan **Image context** segment only when images are sent to the model. Orchestra / Leader / Software modes
are text-only. Pictures cost tokens (roughly 300–1500 each, depending on the model) – the context ring counts them.

### 🎯 Recommend model

Header button (🎯 *Model* on phones). Searches Hugging Face for GGUF models and picks the **most capable one that
should run at your target speed** and fits in memory:

* **Target speed** (default 12 tok/s) with an allowed **±** (default 2): a model is "in range" if its estimated
  speed is within the window. If nothing lands in it you get the closest faster (memory-limited) and slower options.
* **Scope** — *Target speed must be met on* the fastest node, every node, a distributed (RPC) group, or **one chosen node only**: pick the node and only its memory and speed are used, and *Install* downloads the model just there.
* **Memory limits** use the same per-node budgets as *Maximise* (usable VRAM + free RAM, with room for at least the
  chosen minimum context). Models can be split GPU/CPU; MoE models are judged on their *active* parameters.
* **Speed** is estimated as memory bandwidth ÷ bytes read per token, using a built-in GPU bandwidth table (CPU
  bandwidth is a rough guess). If you measure a node, type its real GB/s in the box under *Memory speed* — saved in
  this browser — and re-run.
* **Target must be met on** the fastest node, or on every online node (model must fit everywhere; slowest judged).
* **Allow finetunes** — off by default. Finetunes, merges and unverifiable origins are detected from Hugging Face
  `base_model:` tags and hidden unless ticked.
* **Find the best finetune of a model** — enter a repo, link or plain name. Finetunes with a GGUF are checked against
  the same limits and ranked by community adoption (downloads + likes), with the original shown for comparison.
* *Install on N nodes* downloads the file on the nodes that can run it at that speed; then use ⚡ Maximise cluster.

"Capability" is a heuristic (parameter count, MoE active size, quantisation loss, repo age) — there is no benchmark
data behind it, and finetune ranking shows popularity, not quality. Models split into several `.gguf` files are
skipped, and the browser needs access to huggingface.co (nodes don't).

## 6. Chat tools and the Workspace panel

The **🗂 Workspace** button (page header, chat header, and the Workspace tab on a phone) opens its own settings dialog with three tabs:

* **📝 Prompt** — the system prompt, editable, saved in your browser. `{{date}}` and `{{workspace}}` are filled in when you send.
* **🔧 Tools** — what the model may call (tick/untick each), the permission level, max tool steps, max tokens per tool result and Orchestra workers: web search, fetch web pages, read workspace files (list / read /
  `search_files` regex search), write/edit/delete workspace files, and **run shell commands** (`exec_command`).
  Whether a call needs your approval is set by the **permission level** picker under the chat box (section 10).
* **📁 Files** — browse, edit, create and delete the files the model works on.
  **🗑 Clear workspace** deletes everything in the workspace folder (hidden files too; symlinks are removed, never followed) after a confirmation.
* **⌨ Terminal** — a real shell (xterm.js) on the controller computer, confined to the workspace. See below.

**Terminal.** Runs `bash` in a [bubblewrap](https://github.com/containers/bubblewrap) sandbox (`term.py`): it sees only the workspace
(mounted as `/workspace`) plus read-only `/usr /bin /lib /etc`; your home folder and the rest of the disk don't exist inside it.
It runs as an unprivileged user in its own user namespace, so there is no root and `sudo`/`su` can't work. There is **no network**
unless you start the controller with `--term-net` (without that, a shell on this computer could call the controller's own
API and bypass the sandbox). Max 4 sessions, closed after 30 min idle or when the controller exits. `--no-exec` disables it.
Install with `sudo apt install bubblewrap`; if bubblewrap or unprivileged user namespaces are missing the terminal refuses to start
instead of offering a shell that isn't really confined. It is not a defence against kernel exploits. xterm.js is bundled in `vendor/`
(no internet needed). It's separate from the chat's `exec_command` tool, which still runs outside the sandbox under the permission levels.

Everything runs on the **controller computer** (`tools.py`), not in your browser:

```
python controller.py --workspace ~/llamacluster-workspace --searxng http://127.0.0.1:8888
```
* `--workspace` (default `~/llamacluster-workspace`): the only folder the file tools can touch; `..` and symlink escapes are refused.
* `exec_command` runs `bash -c` in the workspace (or a `cwd` you/the model give), no stdin, 30 s default / 600 s max timeout,
  output capped (first 30 KB + last 10 KB), the controller's token is removed from its environment.
  `--no-exec` removes the tool completely. `--safe-commands python3,make,pytest` adds commands that *semi* may run unasked.
* `web_search` uses `--searxng` if given (most reliable; enable its JSON format), otherwise scrapes DuckDuckGo, then Bing.
  Scraping can be rate-limited or change format - a local SearXNG avoids that.
* `fetch_url` refuses private/loopback addresses (and redirects to them) unless you pass `--allow-private-fetch`.
* The tool and file endpoints reject cross-origin requests; set `--token` if the controller is reachable from other machines.

Tool calling needs a model that supports it and `llama-server --jinja`. The worker now adds `--jinja` automatically
(restart each node once to pick it up; add `--no-jinja` to Extra args to opt out). Web pages can contain text that
tries to instruct the model, so use *Manual* or *Semi* permissions unless you trust what it browses.

### Context gauge

The ring next to the message box shows how full the model's context window is: an empty ring is an empty context, half a ring
is 50%. It turns **orange at 75%** and **red at 95%**. Click it for the breakdown, a bar split into **System prompt** (red,
including the tool notes and the mode's note), **Tool** (red, the tool definitions sent with every request), **Tool others**
(orange, tool-call JSON), **Tool outputs** (amber, returned results), **User** (green, your messages and replies), **Image context** (cyan, images sent to a vision model) and **Free space** (blue).
The window is the node's *context size ÷ parallel slots* (one conversation gets one slot); with several nodes and no node
picked it is the smallest of them, with a node (or the Leader) picked it is that node's. The numbers are an estimate (about
3.8 characters per token, 3.2 for JSON), matched to the real prompt size the server reports after each reply. Tests:
`node tests/test_context.js`.

## 7. Phone mode

The UI switches to a phone layout automatically on narrow or touch screens. Force it with **📱 Phone: auto / on / off**
(header on desktop, ☰ More on a phone); the choice is remembered per browser.

* Bottom tab bar: **Nodes**, **Chat**, **Workspace**, **More**.
* Nodes tab: a status line (nodes online / serving, which model) and quick buttons for Add node, Cluster and RPC;
  node cards are single-column with settings behind a ⚙ fold and big Start / Maximise / Stop buttons.
* Chat is full screen and follows the on-screen keyboard. Model, route and sampling fold into one line at the top
  (tap to open) so the conversation gets the space; mode and permission level are pills above a rounded composer
  that grows as you type. **Enter inserts a new line - use Send.**
* Workspace opens full screen with Tools / Prompt / Files tabs; opening a file shows just the editor.
* Dialogs open full screen; inputs are 16 px so iOS doesn't zoom.
* Tip: "Add to Home Screen" gives an app-like full-screen launcher.

## 8. Getting one model onto several nodes

Two ways, both in the UI:

* **Install model…** now has a node picker: tick every node that should have it and each one downloads it
  (from Hugging Face or a direct URL) in parallel.
* **Send to…** (Installed models list on a node card) copies a model **node to node over your network** - the target
  reads the file from the source worker instead of re-downloading it, which saves internet bandwidth when several
  machines need the same multi-GB file. Nodes that already have it are greyed out; progress shows on each node's card.
  *Maximise cluster* also offers "send <model> here" for nodes that lack the cluster's main model.

Notes: the target nodes must be able to reach the source node's address (a source registered as `127.0.0.1` can only
send to nodes on the same machine - re-add it by its LAN IP), and cloud workers (Colab/Modal) usually can't be a
source for LAN nodes. Update `worker.py` on the source *and* target nodes. The copy is authenticated with the
source worker's token and is size-checked on arrival.

## 9. Chat modes: Dev, Ask, Plan, Orchestra

The mode picker sits next to **🗂 Workspace** under the chat box.

* **🛠 Dev** (default) — the normal tool-using chat.
* **❓ Ask** — just ask the model about your workspace. It only gets the read-only file tools (list, read, regex search),
  no web, no writing, no commands, and its prompt includes the workspace file list, so "where is X handled?" or
  "what does this project do?" works out of the box. It's told to quote paths and line numbers and to say so when the
  files don't contain the answer.
* **🧭 Plan** — the model may research with read-only tools (search, fetch, read files) but cannot change anything.
  Its final reply is shown as a plan with **Accept & build**, **Decline**, and **Revise** (type what to change, or just
  type a normal message). *Accept* switches to Dev mode automatically and tells the model to execute the plan; file
  tool calls still follow your permission level.
* **🎼 Orchestra** — a conductor call splits your request into independent subtasks (up to *Max parallel workers*,
  set in the Workspace panel), runs each as its own worker in parallel **on different nodes** (fastest nodes first,
  extra slots after that), then the conductor merges the results into one answer. Each worker has the enabled tools;
  the card shows node, tool calls and result per worker. If the model can't produce valid JSON for the split, the
  job runs as a single task. Works best when two or more nodes are serving.

* **👑 Leader** — like Orchestra, but with dependencies and a hierarchy of models, see section 9b.

## 9b. 👑 Leader mode

Pick **👑 Leader** in the mode picker. Calcium (the chat assistant) then runs the job as a small cluster:

1. **Node selection** — from the nodes that are *ready*, it takes up to **three**, one per distinct model (the fastest node if
   several run the same model). With more than three models it keeps the strongest, the weakest and the one in between. If
   there are fewer than three distinct models, spare nodes running one of those models are added (still at most three nodes).
   **Choosing the leader:** next to the mode picker a **👑 Leader** dropdown appears in this mode. *Auto* means the strongest
   model; or pick any ready node. The chosen node always takes part (it replaces the pick closest in strength, never the
   strongest) and it **plans the job and writes the final answer**. Task difficulty is still matched to model strength, so
   hard tasks, and retries of failed tasks, go to the strongest node. If the chosen node isn't ready, the strongest leads and the
   card says so.
   "Strongest" uses the same heuristic as 🎯 Recommend model (parameters, MoE active size, quantisation quality); the model name
   or, failing that, the file size gives the parameter count. By default the strongest node is the **leader**.
2. **Plan** — the leader returns a task graph as JSON: for each task an id, a self-contained prompt, a difficulty 1-3 and
   `depends_on` (the ids whose results it needs). Unknown ids and self references are dropped and cycles are broken; the
   number of tasks is capped by *Orchestra / Leader: max tasks* in the Workspace panel (default 4 - raise it to 6+ for
   this mode). The reply is parsed tolerantly (`<think>` blocks, text or ``` fences around the JSON, a bare list, a reply cut off mid-list keeps its complete tasks), the leader is asked in JSON mode with at least 4096 tokens, and if it still isn't usable it gets one retry. If that fails too, the request runs as one task on the leader and the card shows the leader's raw reply so you can see why.
3. **Run** — independent tasks run in parallel; a task with dependencies waits (⏸) until all of them are done and then
   receives their results in its prompt. Difficulty picks the model tier: **hard (3) → leader**, **easy (1) → smallest model**,
   **medium (2) → the middle model** (with only two models, medium goes to the smaller one). A task may run on a *stronger*
   tier when its own is busy, never a weaker one, and while a hard task has not started the leader's slots are kept for it.
   Each node runs as many tasks at once as its *parallel slots* setting. Hard tasks that unblock the most work start first.
4. **Failures** — a task that fails on a smaller model is retried once on the leader. If a task still fails, tasks that depend
   on it are skipped (⤼) while independent tasks finish.
5. **Answer** — the leader writes the final reply from all task results and says what is missing if something failed.

The card shows the chosen nodes with their role, and each task with its difficulty (●●○), what it waits for, the node that
ran it, tool calls and result. With a single serving node it is the leader and does everything. Like Orchestra, the loop runs in the
browser tab, workers use the tools enabled under 🗂 Workspace and the permission level you picked, and the *Model* dropdown is
ignored (each node uses the model it has loaded). Tests of the node picking, plan parsing and scheduler: `node tests/test_leader.js`.

## 10. Permission levels: Manual, Semi, Uncontrolled

The picker next to the mode selector (saved per browser; default **Semi**). The controller applies the policy, so the
page can't skip it: a call that needs approval comes back as "needs approval" and only runs after you confirm the box.

| Level | What runs by itself | What asks |
|---|---|---|
| ✋ **Manual** | nothing | every tool call |
| 🛡 **Semi** | web search, page fetch, listing/reading/searching files, writing and editing workspace files, and *safe commands* inside the workspace | deleting files, any other command, anything that touches a path outside the workspace, shell tricks |
| ⚡ **Uncontrolled** | everything (asks once when you switch to it) | nothing |

*Safe commands* (Semi): `ls cat head tail wc grep rg find sort uniq diff cmp echo printf pwd tree stat file du df which date
basename dirname realpath readlink cut tr nl column md5sum sha1sum sha256sum uname whoami true false mkdir touch cp mv`,
optionally chained with `| && || ;`. It asks instead when the command uses redirects (`>`, `<`), `$`, backticks, subshells,
background `&`, a path outside the workspace (including via `..`, `~`, or a symlink), or a flag that writes/executes
(`find -exec/-delete`, `sort -o`, `rg --pre` …). Programs that run code (`python`, `node`, `make`, `sh`, `git`, `rm`) are
deliberately not on the list; add the ones you trust with `--safe-commands`.
Semi is a convenience filter, not a sandbox - a program you allow can do anything it likes. For real isolation, run the
controller in a container or as a separate user.

## 11. Optional tools, calculator

Workspace -> Tools -> **Optional tools** lists extras the model can call. The first three only compute (no files, no network, no approval needed):

* **🧮 Calculator** (`calculate`, on by default) - safe, no `eval`. Arithmetic with big integers, `exact=true` for exact fractions,
  complex numbers, vectors/matrices (`det inv @ solve_linear eigvals rank`), statistics, number theory (`isprime factor gcd modinv`),
  polynomial roots, and numeric calculus written with the expression in quotes:
  `integrate('exp(-x**2)', -inf, inf)`, `diff('x**3', 2)`, `solve('cos(x)-x', 0.5)`, `solve('x**2-4', -5, 5)`, `limit('sin(x)/x', 0)`,
  `sumto('1/n**2','n',1,inf)`. Numeric results are floating point with an estimated error shown in the reply.
  Each call is capped at about 6 s / 800k steps. Tests: `python3 -m unittest discover -s tests`.
* **📏 Unit converter** (`convert_units`) and **🕒 Date & time** (`date_time`, IANA zones need `tzdata` on Windows) - off by default.

Two more optional tools talk to *you*, so the chat page runs them itself (the controller only lists them; both are on by default):

* **❓ Question** (`question`) - the assistant asks you something and waits. The question appears above the message box with its
  options as buttons; you can also type your own answer or **Skip** (the assistant then decides itself). Stop closes it. Not
  available in **Leader**, **Orchestra** (parallel workers run unattended) or **Ask** mode; available in Dev, Plan and Software.
  In Software mode the timer keeps running while a question waits.
* **☑ Tasks** (`task`) - a visible to-do list the assistant keeps while it works: `action` = `add` (one `title` or several
  `titles`), `set` (`id` + `status` todo/doing/done and/or a new `title`), `remove` (`id` or `ids`) or `list`. The list shows
  above the message box (click a circle to change a status, ✕ removes, *Clear done / Clear all*), is saved with the chat and
  cleared with it, and is shown to the assistant in its system prompt so it keeps the ids straight. At most 50 tasks. Not
  available in Ask mode (it only reads files); Orchestra and Leader workers may use it.

Under **Other tools** (on by default), `spawn` can bring a persistent model into the chat as Hydrogen, Indium or Sulfur; Calcium plus these agents is capped at four active agents. Agents keep separate conversation histories and editable system prompts, show individual context rings, and remain available until they call `agent_done` or Calcium removes them with `despawn`. `tell` queues a message without interrupting an agent, `interrupt` stops its current reply and redirects it, and `status` reads the current state without disturbing it. `spawn` also retains its one-shot parallel and debate modes. Agents use the enabled tools and the same permission settings as Calcium.

**🌐 Run web page** (`runweb`, off by default) executes a workspace `.html` / `.htm` file in headless Chromium and returns console output; vision-capable models also receive a screenshot. Since this runs page JavaScript (which can access the network), Semi mode asks for approval. Install the optional runtime with `pip install -r requirements-web.txt` and `python3 -m playwright install chromium`.

**🌐 Playwright** (`playwright`, off by default) is available when a saved `.html` or `.htm` file is open in Workspace → Files. It runs that open file with Playwright, returning console output and a screenshot to vision-capable models. Save editor changes before calling it. Workspace files can be downloaded individually from their rows, or together with **↓ ZIP**; the archive includes hidden files and skips symlinks.

Page-side tests: `node tests/test_tools.js`, `node tests/test_modes.js` and `node tests/test_chat_features.js`; the registry: `python3 -m unittest discover -s tests`.

New optional tools only need an `optional={...}` entry in `tools.py`; the UI picks them up automatically (tools that need the
page, like the two above, also need handling in `runTool` in `ui.html`).

## 12. 💻 Software mode

Pick **💻 Software** in the mode picker, set how many minutes (⏱ box), describe the program, press Send. Calcium then works alone:
it plans in `SOFTWARE_NOTES.md`, and repeats **build -> test -> troubleshoot -> improve** cycles in the workspace until the time is up,
then writes a final report (what was built, how to run it, real test results, known issues). A countdown shows time left, cycle and focus.

* Needs the file-write and/or shell tools switched on, and a model that supports tool calling.
* Starting a session offers to run it as ⚡ Uncontrolled **for that run only** (otherwise it pauses at every approval). Your saved
  permission level is never changed. Alternative: stay on 🛡 Semi and add `--safe-commands python3,pytest,make`.
* Context stays small: only the latest messages are sent and the model re-reads `SOFTWARE_NOTES.md` each cycle.
* Stop with the button; send a message to resume while time remains. It also stops itself after 3 failed cycles or 3 cycles with no tool use.
* The loop runs in the browser tab (it asks the screen to stay awake where the browser allows). Closing the tab pauses it.

## Notes

- The controller stores node URLs/tokens in `~/.config/llamacluster/nodes.json` (mode 600).
- Worker ↔ controller traffic is plain HTTP on the LAN; cloud nodes are HTTPS. Don't expose a worker
  to the internet without a token.
- Tested here with a stand-in `llama-server` (balancing, failover, streaming, installs, auth).
  It has not been run against real llama.cpp, Modal or Colab yet — expect to tweak `modal_worker.py`
  (CUDA arch list, image) and flags that differ between llama.cpp versions.
