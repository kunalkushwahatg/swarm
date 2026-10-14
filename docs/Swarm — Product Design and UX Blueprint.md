# Swarm — Product Design and UX Blueprint

*Design dossier for your review before any implementation work · 11 October 2026*

Basis: your brief, the Milestone 13 audit, DECISIONS.md, DECISIONS\_AND\_LIMITATIONS.md (Milestones 4–12), the single-computer dev guide, and nine screenshots. No code written, no repository touched. Tags used throughout: **\[Confirmed\]** = stated in your documents or visible in a screenshot; **\[Inferred\]** = my reasoning; **\[Open\]** = needs a check or research; **\[New\]** = a capability that does not exist yet and needs engineering.

## 0. Read this first

**On fonts and text:** yes — nothing in the current typography or wording is binding. I treat every typeface, heading, label and sentence in the prototype as replaceable, and propose new ones below.

**The ten-line version**

1. Swarm’s real unit of work is not a chat and not a node. It is a **session**: one model, loaded once, with layers placed across devices at load time. Your own decision log confirms placement cannot change after load, so any change in devices means a reload. The product should be built around that truth, not around hiding it.
2. **Device** should be the primary noun. The prototype uses “node”, “worker”, “backend”, “gateway” and “RPC endpoint” — five words that, in your dev setup, describe one laptop. Users should see *This computer* (with its CPU and GPU inside it) and *helper devices*.
3. **Recommended concept: “The Session.”** A chat-first workspace with a permanent, slim **placement ribbon** (the model’s layers, coloured by which device holds them), plus a Devices view for adding and diagnosing machines.
4. Five screens become three destinations — **Chat, Devices, Session** — with Settings secondary.
5. The most valuable missing piece is a **plan-before-load** step. Your policy engine already predicts placement before the model loads. Exposing that as a dry run lets the UI say “this fits / this will not” instead of the process exiting at startup. **\[New: dry-run endpoint\]**
6. Failure is a first-class design problem. A helper lost mid-reply aborts the coordinator process, so the UI ends up talking to a dead server. A small local supervisor is needed to explain what happened. **\[New\]**
7. Honest numbers are a feature: “READY” is not “participating”, loopback RAM is not additive, and measured / configured / unknown values must look different.
8. Visually: drop the grey cards, numbered uppercase micro-headings and metric tiles; use rows, hairlines and one signature graphic. Palette “oxidised metals on paper”: graphite ink, bone paper, verdigris, brass, rust. Typefaces: Instrument Sans, IBM Plex Mono, and Instrument Serif used sparingly — all self-hosted.
9. Phone = remote chat client and cluster monitor first. Android-as-helper and Android-local inference are separate, later products.
10. P0 is mostly frontend vocabulary, information architecture and honest-state work. Two backend items — dry run and a supervisor — unlock almost everything after it.

### Things in the materials you should know about

- **Screenshots 28–32 are named “chat” but all show Settings.** There is no desktop Chat screenshot at all, so I could not review the Chat screen visually. My chat recommendations rest on your descriptions and the SSE/timing notes. Please send desktop chat (empty, mid-stream, finished) and one mobile chat.
- **Screenshots 35 and 36 are byte-identical** (both 112,179 bytes).
- **A blue haze surrounds every capture** (sampled ≈ #ABCBF6 at the top edge, ≈ #73A1DA at the right edge). It looks like a browser-automation overlay rather than app styling. **\[Inferred\]** — please confirm it is not in your CSS.
- **A likely metric mislabel on Activity.** “Last generation rate 7.3 tok/s” and “Avg token latency 12.68 s” cannot both be per-token figures: 7.3 tok/s is about 137 ms per token. 12.68 s is probably the average duration of a whole reply (3 samples). **\[Inferred\]** — check against `/metrics`.
- **Rendered colours do not match your tokens.** Tokens say canvas #F7F7F3 and surface #FFFFFF. Sampled pixels show canvas ≈ #EBEBE8 and panels ≈ #F3F3F3 — about 1.1 : 1 separation, which is why everything reads as grey on grey. (Sparse pixel sampling; treat as indicative.)
- **The same red RAM bar (7.7 of 7.8 GB) appears on Activity and twice on Nodes**, including under the *RPC worker* card although it is the host’s memory.

---

## 1. Product diagnosis

### 1.1 What Swarm has to communicate

In priority order:

1. **Can I ask a question right now?** (session state)
2. **Where is the model actually running?** (which devices hold how much)
3. **Is anything about to go wrong?** (memory headroom, helper health, stale telemetry)
4. **What should I do next?** (a concrete action, not a number)

Everything else is detail on demand.

### 1.2 Likely users **\[Inferred — no research yet\]**

- **The Builder** (you today): developer with one to three machines proving that distribution works; reads logs; comfortable with PowerShell.
- **The Home-lab owner**: a few spare PCs or laptops, wants a bigger model than any one machine can hold; technical but will not know what “RPC” or “tensor layer” means.
- **The Remote monitor** (a role, not a person): checking on a running cluster from a phone.
- **The Small-team operator** (later): shared coordinator, several clients, cares about who is connected and what is exposed.

Design first for the Builder and Home-lab owner. Do not block the others.

### 1.3 Core jobs to be done

1. Get a working local session without reading documentation.
2. Know, before loading, whether a model will fit and how it will be split.
3. Chat with the loaded model and see how fast it is.
4. Add another computer safely and see what it contributes.
5. Understand why a helper contributes little or nothing.
6. Recover when something disconnects or memory runs out.
7. Shut everything down cleanly.

### 1.4 Confirmed facts that shape the design

| Fact **\[Confirmed\]** | Source | Design consequence |
| --- | --- | --- |
| Layer placement is fixed at model load; changing devices afterwards cannot relocate layers | Decisions & Limitations | Adding or removing a helper is a **new session**. The UI must say “reload”, not imply live change. |
| A helper lost **mid-decode** aborts the coordinator (GGML\_ABORT, Windows exception 0xc0000409); recovery = restart RPC process, then restart Swarm | Decisions & Limitations, M6 | A failure screen must work when the coordinator is dead. Needs a supervisor. |
| A helper lost while **idle** produces HTTP 503 with structured JSON and the process survives | M6 | A recoverable “paused” state exists and is different from a crash. |
| Worker `READY` means reachable, not participating; a zero-layer helper does not affect readiness | Decisions & Limitations, M6 | Show three states: reachable / holds layers / idle (0 layers). |
| Loopback workers share host RAM; memory is deduplicated, never summed | M4, M7, M8 | One memory bar per **physical computer**, never per process. |
| GGML RPC is single-client; no concurrency on one session | M12 | One generation at a time; queue or refuse a second request visibly. |
| Telemetry older than 30 s is stale and the node becomes unavailable | M8 | Show “last seen 41 s ago”; never present stale numbers as current. |
| Resource values carry provenance: measured / configured budget / simulated / unknown; unsupported metrics are null | M7, M8 | “Not measured” must look different from zero. |
| Default headroom: 1024 MiB RAM, 256 MiB VRAM. In the physical test, Computer B at ≈0.93 GB free received **0 layers**; at 1.40 GB free it received **2** | M9, M12 | A headroom marker on every memory bar is the key decision aid. |
| Placement policies: none / profiles / dynamic. Insufficient capacity exits with code 1 and diagnostics; layers are never silently reduced | M5, M9 | A dry run must exist; the UI refuses to start rather than degrade silently. |
| Predicted vs actual placement is compared; mismatch sets `policy_match: false` | M5 | Surface a mismatch warning. |
| RPC is plaintext and unauthenticated; telemetry has a bearer token; production mode requires one; Swarm deliberately refuses remote command execution and remote installation | M8, M10, M11 | Device onboarding must be a guided **handoff**, not remote install. Recommend a private overlay (WireGuard/Tailscale). |
| A browser page cannot start native processes (stated in the Settings screen) | Screenshot 29–32 | Lifecycle controls need a desktop shell or local supervisor. **\[New\]** |
| Real two-computer inference ran once (2 layers on the second computer) | M12 | Distributed *performance* is unproven; never imply it. |
| Dev machine: 7.84 GB RAM with ≈0.18 GB free under load | M13 audit | “Tight” is the normal state for the primary user. Design for it. |

### 1.5 The most consequential UX weaknesses (ranked)

1. **The vocabulary does not match the mental model.** The Nodes screen shows “2/2 Logical Nodes Online”, “1 Physical Host (Loopback Cluster)” and a paragraph called “Physical Topology Notice” explaining that there is only one machine. When a screen must apologise for its taxonomy, the taxonomy is wrong.
2. **Information is organised by endpoint, not by question.** Workers, Nodes, Activity and Settings each show overlapping slices of the same truth. Your own audit demonstrates the cost: CUDA0 showed 0 layers on one screen and 3 on another because screens read different endpoints.
3. **Status without meaning.** A red RAM bar with no verdict. Four near-synonyms for “ready” (Ready, READY, ONLINE, Server: running, Inference Ready) that mean different things.
4. **Dev-tool artefacts shown as product.** PowerShell commands in Settings, `WIN32_GLOBALMEMORYSTATUSEX` in a heading, “Network Isolation: Strict Loopback” as a settings row.
5. **Generic dashboard anatomy.** Uniform panels, numbered uppercase tracked headings (“1. LOCAL COORDINATOR GATEWAY”), four metric tiles, pills on everything, all grey on grey. Verdict: keep the *information density*, drop the *containers*.
6. **No story for change or failure.** Nothing says that adding a device needs a reload or that a lost helper stops the process.
7. **Metrics that do not answer a question** (the four tiles; the likely mislabel above).
8. **Mobile is the desktop IA shrunk.** Five bottom tabs including Nodes and Workers; the mobile example screenshots are the *Settings* page full of commands; long paths break mid-word (“…qwen2.5-3b-in / struct…”).

**What to keep:** monospace for paths and addresses; the status dot; the cluster layer bar on Activity (the best idea in the prototype); the Workers screen’s attempt to separate local hardware from network helpers; copy-to-clipboard on commands; the 37-layer reconciliation discipline from the audit.

### 1.6 Questions that genuinely need research

- Do users want to see “layers” at all, or only “share of model”? **\[Open\]**
- Will target users already run Tailscale or WireGuard, or must Swarm help them set one up? **\[Open\]**
- Does chat history need to persist across sessions? **\[Open\]**
- Can the backend cancel a generation mid-stream, or does closing the stream leave `llama_decode` running? **\[Open — engineering check\]**
- Does the response include prompt-token usage for a context meter, or must it be estimated client-side? **\[Open\]**
- How would an Android device pair, and under what battery and thermal limits could it help? **\[Open\]**

---

## 2. Four product concepts

### Concept A — Chat Plus

**Philosophy.** Swarm is a chat app that happens to be fast on your own hardware. The cluster is plumbing.

**Primary journey.** Open → type → read the answer. Devices appear only once you add one.

**Home.** One conversation column and composer. Empty state: last model and a single readiness line.

**Chat.** ChatGPT / Ollama-app style. A right-hand drawer lists devices.

**Cluster management.** Drawer with a device list and an add-device sheet.

**Visual identity.** Paper-calm, almost no chrome.

**Advantages.** Simplest to build and understand; best fit for phones.

**Disadvantages.** Buries the one thing that makes Swarm different. No natural home for failure or recovery. Risks becoming “another local chat client” in a space LM Studio and the Ollama app already occupy. “Where is my model running?” needs a drawer.

**Easier / harder.** Chat is easier; diagnosing pressure and understanding placement are harder.

### Concept B — The Session (recommended)

**Philosophy.** A session is a model placed across devices. Chat is how you *use* it; the placement is how you *trust* it.

**Primary journey.** Open → see session state and the ribbon → chat. Changing devices is an explicit *plan → apply (reload)*.

**Home.** The chat workspace, topped by a **session bar** (model · context · state) and the **placement ribbon** — one slim line showing every layer coloured by holder. A collapsible right panel shows devices and memory headroom.

**Chat.** Reading column ≈ 720 px, composer with a context meter, one-line reply footers (tokens, speed, time).

**Cluster management.** A Devices destination: rows plus a detail panel; an Add-device flow that ends in a plan and an explicit reload.

**Visual identity.** Instrument-on-paper. The ribbon is the signature element.

**Advantages.** Matches the backend’s truth (the session is the unit of load, failure and change). Makes distribution visible without a dashboard. Scales from one device to many. Gives plan-before-load, failure and recovery a natural home. Gives the phone something meaningful to show.

**Disadvantages.** Introduces the word “session”. “Reload to change” is friction users will feel — honest, but unglamorous. Reaching full value needs two backend additions. The ribbon needs care for very deep models.

**Easier / harder.** Placement, change and recovery become easier. Casual chat carries marginally more chrome than A.

### Concept C — Fleet

**Philosophy.** Swarm is a small fleet; chat is one thing you do with it.

**Home.** A canvas of device cards with live memory; chat opens as a side panel or sheet.

**Advantages.** The strongest expression of “distributed”. Good at three or more devices; exo’s dashboard is the nearest reference.

**Disadvantages.** At one or two devices — your reality — the canvas is nearly empty. It makes people operate infrastructure to ask a question. Topology graphs wrap badly on phones (your own Direction C notes say so). It invites exactly the dashboard look you dislike.

**Easier / harder.** Device health is easier; everyday chat and mobile are harder.

### Concept D — Quiet Service

**Philosophy.** Swarm is infrastructure that lives in the tray or menu bar like Tailscale or Docker Desktop; windows open on demand.

**Home.** A tray popover: session state, ribbon, start/stop. “Open chat” launches a window.

**Advantages.** Solves lifecycle (start at login, start/stop session, safe shutdown). Natural for headless helper devices.

**Disadvantages.** Chat and diagnosis feel secondary. Platform-specific on Windows, Linux and Android. Depends on desktop packaging. Does not by itself fix the information architecture.

### Recommendation

**Build B. Borrow D’s lifecycle layer later. Borrow C’s device canvas as an optional layout inside Devices once someone has three or more devices.** B is the only concept whose central object matches how the system actually behaves, and it is the only one that gives your most distinctive technical asset — layer placement with real buffers — a permanent, understandable home. I am deliberately *not* recommending your current Warm Engineering Workbench direction as the product concept: its information architecture mirrors the API, and its look is the generic part.

---

## 3. The mental model and vocabulary

**One sentence the UI should teach:** *A session is a model split across devices. Each device lends some of its memory and compute.*

```
Device (a physical computer)
 ├─ Role: Host (runs Swarm, you chat here)  or  Helper (lends compute)
 ├─ Processors: CPU, GPU          (what the engine calls “backends”)
 └─ Share of the model: layers L0–L36   (assigned when the session loads)
```

### Vocabulary

| Prototype term | Proposed term | Notes |
| --- | --- | --- |
| Coordinator / Gateway / Swarm Coordinator Process | **Host** (“This computer” when local) | Process names live in Details only. |
| RPC worker / Network RPC / llama-rpc-server | **Helper** | A device that lends compute. Port and process name in Details. |
| Logical node / node record | *(hidden)* → **Device** | “Node” never appears in primary UI. |
| Backend / placement backend | **Processor** (CPU, GPU) | “CUDA0” is a technical suffix in Details. |
| Assigned layers | **Share of model** | “3 of 37 layers (8%)”; ranges `L34–L36` in Details. |
| Loopback worker | **Test helper (this computer)** | Dev-only; hidden unless present. Never counted as extra capacity. |
| Placement policy: none / profiles / dynamic | **Placement: Default · Fixed budgets · Automatic** | Settings → Advanced. |
| READY (worker) | **Reachable**; plus **Holds 3 layers** or **Idle (0 layers)** | Three separate facts. |
| Model Load Status: Active (Loaded) | **Session: Ready** | One word set for session state. |
| Provenance MEASURED / CONFIGURED / SIMULATED / UNKNOWN | **Measured · Set by you · Estimated · Not available** | Shown as a quiet suffix, not a badge. |
| Headroom / reserved | **Reserve** | “Keeps 1.0 GB free for the system.” |

### Progressive disclosure

- **Level 0 — glance:** session bar (state, model, device count) and a headroom verdict.
- **Level 1 — working view:** ribbon and a device list with one-line status.
- **Level 2 — detail panel:** memory breakdown (model / KV / compute buffers), layer ranges, endpoints, last-seen time, provenance.
- **Level 3 — diagnostics:** logs, raw endpoint JSON, process commands.

**Stays in the background until needed:** node IDs, ports, Win32 API names, KV and compute buffer splits, telemetry TTL, policy internals, SSE timing chunks.

**Do not conflate:** a computer can be Host *and* hold a Test helper *and* have both CPU and GPU. The ribbon teaches this visually (hue = device, fill = processor; see section 7).

---

## 4. Recommended information architecture

```
Swarm
├─ Chat            (home)   session bar · placement ribbon · conversation · composer
├─ Devices                  list · detail panel · Add device · optional topology layout
├─ Session                  model · placement (expanded ribbon, why this split) · memory · performance
├─ Setup                    first-run; re-enterable from Settings
└─ Settings  (gear)         Model & runtime · Network & security · Advanced → Diagnostics
```

| Destination | Role | Replaces | Phone |
| --- | --- | --- | --- |
| Chat | Primary, default | Chat | Tab 1 |
| Devices | Primary | Workers + Nodes | Merged into tab 2 “Cluster” |
| Session | Primary | Activity + backend placement + model facts from Settings | Merged into tab 2 “Cluster” |
| Setup | Secondary, first run | Parts of Settings | Full-screen flow |
| Settings | Secondary | Settings | Under “More” |
| Add device, Recover session, Plan & reload | **Contextual flows** (sheets) | — | Full-screen sheets |
| Device detail, Layer detail | **Contextual panels** | — | Push screens |

**What was removed and why**

- The top-bar chips “Connected · Ready · Qwen 2.5 3B · 1/1 RPC worker” collapse into one **session bar**.
- “Nodes” stops being a destination: a topology view becomes an optional layout toggle inside Devices.
- Count badges on nav items (1, 2) are removed: they count processes, not decisions.

**Endpoints are not screens.** `/health` feeds the session bar; `/backends` feeds the ribbon and Session; `/nodes` feeds Devices; `/metrics` feeds performance; `/nodes/report` is invisible plumbing. Do not add a destination because an endpoint exists.

---

## 5. Key user journeys

### 5.0 Lifecycle audit of your eleven steps

| # | Step | Today | Problem | Proposal |
| --- | --- | --- | --- | --- |
| 1 | First launch | Open the UI; coordinator must already be running | If it is not, the UI has nothing useful to say | Setup detects “Swarm is not running”, shows the start action, and auto-detects when it comes up |
| 2 | Understand local hardware | Not shown on one screen (the agent already probes RAM, CPU, GPU VRAM) | Users cannot tell what their machine can do | First Setup card: **This computer** — RAM, GPU, free memory, a plain verdict |
| 3 | Select or verify a model | Path shown in Settings; hash checking happened in scripts | Hidden assumption that the file is valid | Model row with size, layer count, context; “verified” only if a hash is known **\[Open\]** |
| 4 | Start local inference | Copy a PowerShell command | Browser cannot start processes | **Start session** button via a local supervisor **\[New\]**; interim: command plus auto-detect |
| 5 | Add another computer | Edit endpoint config, run worker bundle, restart | Entirely manual; one wrong bind exposes unauthenticated RPC | Guided handoff with a private-network check |
| 6 | Trusted connection | Token via env/file; VPN by hand | Trust is invisible | Per-device token file, reachability check, blocking warning on non-private addresses |
| 7 | Understand allocation | Three screens, three endpoints | Contradictory slices | Ribbon plus “why this split” |
| 8 | Send requests | Works | Single-client RPC: a second client or tab can collide | One generation at a time, visibly |
| 9 | Monitor | Four tiles | No question answered | Reply footer plus a small trend on Session |
| 10 | Diagnose memory or failure | Logs | A mid-reply loss kills the coordinator | Recover flow with live checks |
| 11 | Disconnect and shut down | Stop-LocalDev.ps1 | Swarm cannot stop a remote helper (by design) | Stop session with verified checks; clear instructions for remote helpers |

**Dangerous actions to protect:** binding RPC beyond loopback or a private overlay; reloading while a reply is generating; removing a device that holds layers; stopping the host while a helper still holds a loaded connection.

**Automation opportunities:** hardware detection; model-fit estimate; reachability checks; port-release verification; “auto-detect when it comes up” polling; generating the per-device token file.

### 5.1 First launch and readiness

**Steps.** (1) Open Swarm → Setup. (2) *This computer* card: RAM, GPU/VRAM, free memory, each with a provenance suffix (Measured). One-line verdict, e.g. “Enough for small models. Memory is tight; Swarm will keep 1.0 GB in reserve.” (3) Choose a model from the models folder; see size, layers, context. (4) **Plan**: predicted split and headroom → *Fits / Tight / Won’t fit*. (5) Start session. (6) Chat opens.

**Decisions.** Which model; accept or change the reserve.

**Feedback.** Model loading has no reported progress, so show **elapsed time and a log tail — not a fake percentage**.

**Failure paths.** Model file missing or unreadable. Insufficient capacity (the engine exits with code 1) → “Won’t fit: needs about X GB, Y GB available after reserve.” with options: smaller model, smaller context, free memory, add a helper.

**Friction removed.** No terminal, no typed paths (file picker), no session JSON files.

### 5.2 Starting a local session

**With a supervisor \[New\].** Start → supervisor launches the coordinator (and, in dev only, a test helper) → polls `/health` → *Starting → Loading model → Ready*.

**Without one (P0 interim).** The Not-running state shows the exact command with a copy button, the log folder, and polls until the coordinator answers.

**Failure paths.** Port 8080 or 50052 already in use; missing DLLs; process exits during load → show the last log lines and the likely cause.

### 5.3 Connecting a remote device

1. **Devices → Add device.**
2. **Network check.** If the host listens on loopback only, say so: “This computer only accepts local connections. To add a helper, choose a private network.” (existing bind setting, new UI). Recommend a private overlay (WireGuard or Tailscale) because RPC is plaintext and unauthenticated; llama.cpp’s own RPC documentation describes the feature as fragile and insecure and says never to run it on an open network.
3. **Pair.** Swarm generates a per-device token file and shows the helper-side steps using your existing worker bundle. **\[New: pairing code and per-device tokens\]**
4. **Waiting.** “Waiting for a helper…” → “Seen: STUDIO-PC · 16 GB RAM · 9.1 GB free (Measured 3 s ago).” → **Approve** (the pattern Tailscale uses for devices awaiting approval). **\[New: approval gate\]**
5. **Checks, each with a tick or a cause:** helper reachable on its RPC port; token accepted; memory free after reserve.
6. **Plan.** Predicted share for the helper. Real example from Milestone 12: at about 0.93 GB free the helper would receive **0 layers**; at 1.40 GB free it received **2**. Show that reasoning: “Reachable, but it can’t take any layers yet: 0.93 GB free is below its reserve plus one layer. Close apps on that computer and re-check.”
7. **Apply = reload.** “This stops the current session and reloads the model with the new split.” Confirm.

**Failure paths.** Token rejected (401/403 are distinct and should read differently); unreachable port (firewall on helper?); stale telemetry (no report for 30 s); non-private address (blocking warning, no override in the first release).

**Never** offer an “open to the internet” shortcut.

### 5.4 Selecting and sending an inference request

The model is a property of the session, so “selecting a model” means *Change model → plan → reload*; it is not a dropdown that silently swaps.

**Composer.** Enter sends, Shift+Enter newline, a Stop button replaces Send while generating **\[Open: confirm cancel actually stops decoding\]**. A context meter shows used / window (for example 1,240 / 2,048) and warns near the limit.

**During generation.** Session state reads *Generating*; elapsed time and token count are computed in the client. The backend sends timings only in a final SSE chunk, so speed appears **after** the reply, not live.

**After.** Footer: tokens, tokens/s, time to first token, if the timings object carries them **\[Open\]**.

**Failure paths.** 503 from a lost idle helper → inline error, prompt preserved, Retry. Context full. A second client mid-request → “Another request is running” with a queued indicator.

### 5.5 Understanding how a request is distributed

The honest answer is that **placement is static per session**. Every reply uses all layers, in order, and the same devices every time. The UI should say so once, in a short caption on the ribbon, and not imply per-request routing.

- Hover or tap a ribbon segment: “Layers 34–36 · GPU · This computer · 3 layers · 337.5 MB model buffer.”
- **Why this split?** One sentence plus inputs: policy, free memory at load, reserve, predicted vs actual (and a warning if `policy_match` is false).
- **Do not animate a baton moving between devices.** The backend reports no per-device timing, so that animation would be invented data. Use a single neutral “working” indicator. Per-device timing is a possible future capability. **\[New\]**

### 5.6 Investigating resource pressure

**Trigger.** Free memory falls below the reserve. Your own machine already does: about 0.18 GB free against a default reserve of 1.0 GB.

**Verdict, not a red bar.** Three levels — *Comfortable*, *Tight*, *Below reserve* — with a reserve marker on each memory bar and a plain sentence: “This computer has 0.18 GB free; Swarm wants to keep 1.0 GB. Low free memory can make replies slow or unstable.” (Whether the machine is paging is not measured; do not claim it.)

**Actions, each with an estimated effect from the dry run \[New\]:** lower the context window; pick a smaller model or quantisation; add a helper; close other apps.

### 5.7 Handling a disconnected helper

**Case A — helper lost while idle (process survives).** Banner: “STUDIO-PC stopped responding. Chat is paused.” Actions: *Check again*; *Reload without this helper* (shows the new split and whether it fits).

**Case B — helper lost mid-reply (coordinator aborts).** The UI loses its server. Show *Swarm stopped*, keep the conversation and the last-known placement greyed out, and keep the unsent or interrupted prompt with Retry. If a supervisor can read the log and exit code, say why (“The connection to STUDIO-PC was lost during a reply”); otherwise say “Swarm stopped unexpectedly” and show the log. Do not state a cause without evidence.

**Recover checklist** (your documented sequence, with live ticks): (1) helper process running; (2) helper reachable; (3) restart Swarm and reload. One primary button.

**Case C — a helper holding zero layers is lost.** A quiet note only; inference continues (confirmed in Milestone 6).

### 5.8 Safely ending a session

Menu: **Stop session** (unload the model, free memory, leave helpers running) · **Stop session and local helpers** · **Quit Swarm**. If a reply is generating, confirm first.

**Feedback mirrors your Stop script:** coordinator exited ✓ · port 8080 released ✓ · local helper stopped ✓ · port 50052 released ✓.

**Remote helpers.** “STUDIO-PC is still running its helper. Swarm can’t stop other computers; close it there.” That honesty follows from your decision never to build remote execution.

---

## 6. Screen-by-screen specification

### 6.1 Main workspace (Chat home)

**Purpose.** Chat with a session you can trust. **Primary action.** Send a message. **Layout (desktop, 1440).** Left rail (3 destinations + gear), centre column with a ≈ 720 px reading width, optional right panel ≈ 320 px.

**Hierarchy.**

1. Conversation.
2. **Session bar**: model name · context window · state (dot + one word) · device summary (“2 devices”, opens the panel).
3. **Placement ribbon** under the session bar, with a one-line caption: “This computer · CPU 33 · GPU 3 — Test helper · 1.”
4. Right panel: devices with memory headroom.

**Secondary.** New chat, conversation list (P1, only if persistence is confirmed).

**Essential states.** Not running · Starting · Loading model · Ready · Generating · Paused · Stopped · Won’t fit. Each has a one-line cause and one primary action (section 6.8).

**Empty state.** Not a welcome screen: the composer plus one line — “Qwen 2.5 3B is ready on this computer.”

### 6.2 Chat interaction and composer

- Assistant replies as plain text with markdown, no bubble. User messages in a lightly sunken well. Both left-aligned to the same column.
- Reply footer, one line, small: “53 tokens · 7.3 tok/s · 7.2 s” (illustrative). Details popover links to the Session tab.
- Composer: multi-line, grows to \~6 lines, Send/Stop button, context meter, read-only session chip. No attachments, no web search, no voice — the backend has none, and the composer must not suggest otherwise.
- A failed reply keeps the prompt and offers Retry.

### 6.3 Device onboarding (Add device)

A sheet with a vertical checklist (section 5.3). Primary action: the next incomplete step. Secondary: “I’ll do this later” keeps the pairing token valid for a limited time **\[New\]**. States: waiting, seen, awaiting approval, checks running, plan ready, applying, failed-with-cause.

### 6.4 Devices — list and detail

**Purpose.** See every computer, what it holds, and whether it is healthy. **Primary action.** Add device.

**List (rows, not cards).** Name · role (Host / Helper) · status (dot + word) · share (“3 of 37”) · free memory against reserve · last seen.

**Detail panel.** Headline: “Holds 2 of 37 layers (L33–L34).” Then Memory (RAM, VRAM; measured vs reserve), Processors (CPU, GPU — share each), Connection (address, last seen, token state), and a collapsed **Technical details** section (buffers, endpoint, node ID). Actions: Rename · Disconnect (reloads the session) · Forget device. Danger actions say what they cost.

**States.** Reachable & participating · Reachable & idle (0 layers) · Awaiting approval · Stale (last seen N s ago) · Unreachable · Test helper on this computer.

### 6.5 Cluster topology

An **optional layout** inside Devices, shown only when two or more *physical* devices exist.

- Host at left, helpers stacked at right, one line per link. Link caption states the security reality: *private network*, *this computer only*, or *unprotected*.
- On one computer, draw **one device with its parts inside**. Never draw loopback as a network.
- No latency or bandwidth numbers unless measured **\[New\]**.
- Phone: the schematic becomes the device list; no graph.

### 6.6 Session — activity and allocation

**Purpose.** Understand the loaded model, where it runs and how it is performing.

1. **Model.** File name, size, layer count, context window.
2. **Placement.** Expanded ribbon; a table by processor: share, model buffer, KV cache, compute buffer. **Why this split?** sentence.
3. **Memory.** One bar per *physical computer* with reserve marker.
4. **Performance.** Last reply (tokens/s, time to first token, duration) and a small strip of tokens/s for the last N replies. Replaces the four tiles. Compare before/after a placement change only if session history is stored **\[New\]**.

Every number carries a provenance suffix when it is not measured.

### 6.7 Model and runtime settings

Groups: **Model** (file picker, context length) · **Placement** (Default / Fixed budgets / Automatic; RAM and VRAM reserve) · **Network** (This computer only / Private network; token status) · **Advanced** (diagnostics, commands, raw endpoints, logs).

- One **Apply and reload** bar appears when anything requiring a reload has changed, listing what will change.
- Each setting has **one** visible source of truth. Open WebUI’s docs show how a per-request context setting can silently override a server default; do not let Swarm’s 2,048-token window come from two places.
- Copyable PowerShell commands move to Advanced → Diagnostics.

### 6.8 Error and recovery states

| State | What the user sees | Primary action |
| --- | --- | --- |
| Not running | “Swarm isn’t running on this computer.” + log folder | Start session (or copy command) |
| Starting / Loading model | Elapsed time, log tail | — (Cancel) |
| Won’t fit | Needed vs available after reserve | Change model / context / add helper |
| Ready | Dot + “Ready” | — |
| Generating | “Generating”, Stop button | Stop |
| Paused (idle helper lost) | Banner naming the helper | Check again / Reload without it |
| Stopped unexpectedly | Last-known placement greyed; cause if evidenced | Recover session |
| Awaiting approval | Device name, hardware, “Seen N s ago” | Approve / Reject |
| Helper idle (0 layers) | “Reachable, can’t take layers: free memory below reserve” | Re-check |
| Stale telemetry | “Last seen 41 s ago”; numbers dimmed | Re-check |
| Policy mismatch | “Actual split differs from the plan” | View details |
| Context nearly full | Meter turns amber | New chat |
| Second request | “Another request is running” | Wait / Cancel mine |
| Below reserve (memory) | Verdict plus options | Choose an option |

---

## 7. A distinctive visual system

**Identity in one line.** *A quiet instrument on paper.* Light bone-coloured paper, graphite ink, hairline rules, tabular numerals, and one signature graphic — the **placement ribbon** — that makes distributed computation literal. The palette borrows from hardware surfaces: verdigris, steel and brass. It is calm without being lifeless, and it contains no sparkle, glow, robot or gradient.

### 7.1 Colour

Contrast ratios were computed against paper (#FBFBF8); “≈” values are estimates to verify with a checker during implementation.

| Token | Hex | Role | Contrast on paper |
| --- | --- | --- | --- |
| paper | #FBFBF8 | Page background | — |
| sunken | #F1F1EB | Wells: code, numeric strips, user messages | — |
| rule | #DEDED6 | Hairlines | decorative |
| rule-strong | #C7C7BD | Input borders, bar outlines | — |
| ink | #1C2024 | Primary text | 15.8 : 1 |
| ink-2 | #555D65 | Secondary text | 6.5 : 1 |
| ink-3 | #69717A | Lowest-emphasis text (never lighter) | 4.8 : 1 |
| verdigris | #1F6F66 | Primary action, Host, focus ring, active state | 5.8 : 1 |
| steel | #46598F | Helper A | ≈ 6.5 : 1 |
| plum | #7A4A6E | Helper B | ≈ 6.7 : 1 |
| graphite-fill | #8A9199 | Helper C and beyond (labelled directly) | graphic only |
| brass | #8A6212 | Caution text and marks | 5.3 : 1 |
| brick | #A33A2C | Error text and marks | 6.3 : 1 |

Tints for banners: verdigris #E3EFEC, brass #F6EDD8, brick #F7E4E0.

**Rules.** There is no separate “green = OK”: a healthy state is a plain ink dot and a word. Colour is reserved for *devices* (ribbon, device marks) and *attention* (brass, brick). Light theme only for v1; semantic tokens leave room for dark later.

**Why not the current forest green.** It reads as generic “calm software” and doubles as the OK colour, so it cannot tell you anything.

### 7.2 Typography (free to change, as you said)

- **UI text — Instrument Sans** (400 / 500 / 600). Sizes: 13 meta, 14 UI, 16 chat body at 26 line-height, 20 section title, 28 page title.
- **Data — IBM Plex Mono** (400 / 500), 13 px, for numbers in tables and ribbons, addresses, paths and layer ranges.
- **Display — Instrument Serif**, 28–36 px, *only* for the model name on Session and for Setup headlines. This one touch of warmth separates Swarm from every sans-only AI tool.
- **Sentence-case labels** at 12–13 px in ink-2 replace the tracked uppercase micro-headings and numbered section titles.
- **Self-host the font files.** Swarm is local-first and should not call a font CDN at runtime. These families are open-licensed on Google Fonts **\[verify licences at implementation\]**. Fallbacks: system-ui / Segoe UI; ui-monospace / Consolas.

### 7.3 Spacing and layout

4-pt grid; scale 4 · 8 · 12 · 16 · 24 · 32 · 48 · 64. Chat column ≤ 720 px (about 70 characters at 16 px — your current 960 px is too wide for comfortable reading). Pages for Session and Devices ≤ 960 px. Side panel 320 px. Rail 56 px collapsed / 200 px expanded. Row height 48 px desktop, 56 px touch. Sections are separated by 32 px of space and at most one hairline.

### 7.4 Surfaces and components

- **No cards.** Content sits on paper. Lists are rows divided by hairlines. Sunken wells only for numeric strips and code. The only raised surfaces are popovers and sheets (1 px rule plus a soft shadow, e.g. 0 8px 24px at 8% ink).
- **Status = dot + word.** No pills. The single chip style is reserved for “Needs attention”.
- **Buttons.** Primary: verdigris fill, white 14/500 text, 36 px high (44 px on touch), 6 px radius. Secondary: hairline outline. Tertiary: text only. One primary per view.
- **Banners.** A 3 px coloured left rule plus text on a tint. No icons-in-circles.
- **Tables.** Sentence-case 12 px headers in ink-2, no zebra striping.
- **Focus.** 2 px verdigris ring with 2 px offset on every interactive element.

### 7.5 Navigation

Desktop rail: three labelled items and a gear at the bottom. Active item = 2 px verdigris bar on the left plus ink text, not a filled grey block. Phone: bottom bar with **Chat · Cluster · More**, labels always visible. The session bar is the only top chrome.

### 7.6 Iconography and mark

Keep Lucide at 18/20 px, 1.5 px stroke, about a dozen icons, never decorative. Replace the lightning-bolt logo (it reads as a generic “AI spark”) with a small mark of three dots on a thread — a miniature of the ribbon. Wordmark: “Swarm” in Instrument Sans 600.

### 7.7 Data visualisation — three graphics, each answering one question

**1. Placement ribbon — “Who holds which part of the model?”**

- One segment per layer in layer order, left to right. GGML places layers contiguously, so the ribbon is a sequence of blocks, not a scatter.
- **Hue = device. Fill = processor.** GPU solid; CPU a light tint with a 1.5 px outline in the device hue (the light tint alone is only \~2 : 1 against paper). A test helper on the same computer gets a dashed outline and the caption “test”. This teaches *device vs processor vs process* without a word of explanation.
- Proportional widths with a minimum 4 px; labels beneath with direct labelling, never a legend you must decode.
- Every segment is focusable and has a text label; Session also offers a table view (WCAG 1.4.1: colour is never the only cue).
- Honest caption: “Placement is fixed when the session loads.”

**2. Memory bar — “Will this computer cope?”** One bar per *physical computer*: used by others · Swarm’s share · free, with a vertical tick and label at the reserve. A verdict sentence sits beside it. Provenance suffix when not measured.

**3. Reply-speed strip — “Did that change make it faster?”** One dot per reply, tokens/s on the y-axis with real axes. Appears after three replies. It earns its place only if session history exists.

**Not used:** donuts, radial gauges, gradient fills, tiles with huge numerals, any animated “activity” the backend cannot measure.

### 7.8 Motion

120–180 ms ease-out for state changes; sheets slide in 200 ms. When placement becomes known, ribbon segments fade in once. Generating: a single dot pulses (1.2 s). No fake progress bars and no per-device activity animation. Everything respects `prefers-reduced-motion` (pulse and slide are removed).

### 7.9 Responsive behaviour

- ≥ 1200 px: rail + conversation + side panel.
- 768–1199 px: rail + conversation; the side panel becomes a drawer.
- < 768 px: single column, bottom bar, full-screen sheets.
- 320 px must work without horizontal scroll. Long paths use middle-ellipsis plus a copy button. Tables become two-line rows. On a phone the ribbon stays full width and its labels move to a legend list beneath it.

### 7.10 Accessibility requirements

- Text contrast ≥ 4.5 : 1; non-text ≥ 3 : 1 (outlines on ribbon segments for this reason).
- Pointer targets ≥ 24 × 24 CSS px (WCAG 2.2 SC 2.5.8, https://www.w3.org/WAI/WCAG22/Understanding/target-size-minimum.html); aim for 44 px on touch.
- Colour is never the only signal: every status has a word, every ribbon segment a label.
- Session-state changes announced with a polite live region; errors as alerts. Do not announce streaming tokens one by one; announce completion.
- Full keyboard operation; visible focus; tabular figures in aligned numbers; usable at 200% zoom and 320 px reflow.

### 7.11 Why this expresses Swarm

The ribbon makes the product’s one genuinely unusual fact visible at a glance. Paper and ink say *careful*; mono numerals say *measured*; the absence of sparkle says *honest*. Nothing here is borrowed from ChatGPT, Linear or Raycast: those are dark-leaning, command-driven or marketing-led, and none has a sequence-of-layers graphic to build from.

---

## 8. Low-fidelity wireframes

A companion **Design canvas** accompanies this document in the chat. It has five artboards: desktop first-run, desktop chat with a reply, desktop Devices, mobile chat, and mobile cluster monitor. All values are **illustrative** (the 37-layer split uses your real example; the helper device and its figures are invented, labelled as such) and none is a performance claim.

---

## 9. Prioritised implementation roadmap

Legend: **FE** frontend · **BE** backend · **Both**. “Accept” is the acceptance criterion.

### P0 — foundational usability and conceptual problems

**P0-1 Vocabulary and copy reset.** *Problem:* five words for one laptop. *Solution:* apply the glossary in section 3; node IDs, ports and API names move to Details. *Benefit:* users read the system correctly. *Complexity:* low. *Accept:* no “node”, “gateway”, “RPC” or “backend” in primary UI; in a 10-second look, a new user can say how many physical computers are involved. *Work:* FE.

**P0-2 One derived session model.** *Problem:* screens read different endpoints and disagree (the CUDA0 defect). *Solution:* one client-side model combining `/health`, `/backends` and `/nodes` (host, devices, processors, layers, provenance), consumed by every screen. *Benefit:* consistency by construction. *Complexity:* low–medium. *Accept:* an automated test with the 37-layer fixture (CPU 33, RPC0 1, CUDA0 3) passes on every screen. *Work:* FE (a unified `/session` endpoint is a later BE option).

**P0-3 Fix and verify metrics.** *Problem:* likely mislabelled “avg token latency”. *Solution:* inspect `/metrics`; relabel or recompute. *Accept:* tokens/s and reply duration are consistent with each other and correctly named. *Work:* FE plus BE verification.

**P0-4 New information architecture.** *Problem:* five endpoint-shaped screens. *Solution:* Chat · Devices · Session + gear; one session bar; remove nav count badges. *Accept:* every fact currently on the five screens is reachable; nav has three items. *Work:* FE.

**P0-5 Status semantics and memory verdicts.** *Problem:* “READY” overloaded; red bar without meaning. *Solution:* Reachable / Holds layers / Idle states; reserve marker; Comfortable / Tight / Below reserve; provenance suffix. *Accept:* a reachable zero-layer helper is never shown as participating; the reserve value displayed matches the configured one. *Work:* FE; BE only if the reserve value is not exposed **\[Open\]**.

**P0-6 Not-running and stopped states without a supervisor.** *Problem:* a dead coordinator leaves a stale UI. *Solution:* detect, grey out last-known state, show the recover checklist and commands, auto-detect restart. *Accept:* killing the coordinator produces the Stopped state within a few seconds and recovers automatically when it returns. *Work:* FE.

**P0-7 Visual reset.** *Problem:* grey-on-grey, uppercase labels, tiles, pills. *Solution:* tokens, typography, rows-and-rules from section 7. *Accept:* contrast table met; no card containers; screenshot review at 1440 and 390. *Work:* FE.

**P0-8 Mobile structure.** *Problem:* the desktop IA shrunk; paths wrap mid-word. *Solution:* bottom bar Chat / Cluster / More; Chat first; middle-ellipsis paths. *Accept:* no horizontal scroll from 320 to 430 px; send a message and see state at 320. *Work:* FE.

**P0-9 Backend semantics check.** *Problem:* unknowns that shape the chat UI. *Solution:* confirm cancel behaviour, whether the timings chunk and usage include the fields needed, and the real source of the 2,048 context value. *Accept:* a one-page findings note. *Work:* BE investigation.

### P1 — core workflow improvements

**P1-1 Placement ribbon** (session bar and Session page). *Problem:* nowhere to see the split at a glance. *Solution:* section 7.7. *Accept:* ribbon totals equal model layers; every segment has a text equivalent. *Work:* FE (uses `/backends`).

**P1-2 Devices list and detail.** *Problem:* Workers and Nodes duplicate each other. *Solution:* section 6.4; one memory bar per physical computer using the existing host-memory deduplication. *Accept:* loopback helpers never add capacity or a second RAM bar. *Work:* FE.

**P1-3 Plan before load (dry run).** *Problem:* insufficient capacity ends in a process exit. *Solution:* expose the existing placement prediction as a dry-run result (predicted split, headroom, fit verdict) for a given model, context and device set. *Benefit:* the highest-value new capability. *Complexity:* medium; builds on the policy engine. *Accept:* choosing a model larger than capacity shows “Won’t fit” with numbers and no process is started. *Work:* **Both**.

**P1-4 Local supervisor.** *Problem:* the browser cannot start, stop or diagnose processes; mid-reply failure kills the UI’s server. *Solution:* a small loopback-only service that starts, stops and restarts only the processes it spawned, tails logs, captures exit codes, and verifies port release. It does not provide remote execution, consistent with your security decisions. *Complexity:* medium–high. *Accept:* Start session reaches Ready without a terminal; killing a helper mid-reply produces a Stopped screen that names the cause from the log signature. *Work:* **Both**.

**P1-5 Add-device flow v1.** *Problem:* adding a computer is manual config. *Solution:* section 5.3 without approval: network check, generated per-device token file, waiting/seen, reachability checks, plan, apply = reload. *Accept:* a second Windows computer is added with no manual environment editing beyond running the launcher; non-private addresses are blocked with an explanation. *Work:* **Both**.

**P1-6 Approval gate.** *Problem:* any holder of the token can appear. *Solution:* a “Needs approval” pending state before a device can take layers. *Accept:* an unapproved device never receives layers. *Work:* **Both**.

**P1-7 Chat essentials.** *Problem:* no context meter, stop, retry or queue state. *Solution:* section 6.2. *Accept:* prompt preserved on any failure; Stop works as verified in P0-9; second request shows the queued state. *Work:* FE plus BE if cancel or usage needs changes.

**P1-8 Settings reorganisation.** *Problem:* settings mix configuration and dev commands. *Solution:* groups from section 6.7, an Apply-and-reload bar, one source of truth per value. *Accept:* every setting shows whether it needs a reload; commands live under Advanced. *Work:* FE; BE (via the supervisor) for writing configuration.

**P1-9 Setup flow.** *Problem:* no first-run path. *Solution:* section 5.1 using the agent’s hardware probe and the P1-3 plan. *Accept:* a fresh install reaches a first reply with no terminal. *Work:* **Both**.

### P2 — refinement and quality

**P2-1 Session history and the reply-speed strip.** Persist per-session metrics so “did adding a helper help?” is answerable. *Accept:* two sessions can be compared on tokens/s. *Work:* **Both**.

**P2-2 Topology layout** for two or more physical devices (section 6.5). *Work:* FE.

**P2-3 Accessibility pass.** Keyboard, screen-reader labels for the ribbon, reduced motion, 200% zoom, target sizes. *Accept:* checklist in section 7.10 passes. *Work:* FE.

**P2-4 Conversation persistence**, if you decide it is wanted. *Work:* FE or Both.

**P2-5 Microcopy and motion polish.** *Work:* FE.

**P2-6 Usability round 1** (section 10) and fixes.

### Later

- **Desktop packaging:** a shell wrapping UI and supervisor, start at login, tray control (Concept D’s lifecycle layer). *Both.*
- **Linux adaptation:** the agent currently links Windows APIs (Win32, DXGI); it needs portable hardware probes and a Linux supervisor. *BE-heavy; the UI is shared.*
- **Android remote client** (chat and monitor a host elsewhere): needs authenticated, encrypted access to the coordinator (today only the telemetry endpoint has a token **\[Open: chat endpoint auth\]**). *Both.*
- **Phone alerts** for session stopped or helper lost. *Both.*
- **Android as helper:** a different product — background execution, battery, thermal and network constraints must be researched **\[Open\]**; start only after the supervisor and approval gate exist.
- **Android local inference:** its own host, with its own memory limits; do not merge it into the helper story.
- **Per-device timing telemetry**, which would finally justify per-request distribution views. *BE.*
- **Mid-reply failure recovery:** blocked by upstream GGML behaviour; not a UI task.

**What to do first.** Start P0-1, P0-2, P0-3 and P0-7 immediately (frontend only, fastest visible change). Start the P0-9 findings note in parallel because it unblocks chat design. Begin P1-3 (dry run) and P1-4 (supervisor) design early because they have the longest lead time and gate the add-device and recovery experiences. **What must wait:** approval gate, phone alerts, Android roles, topology layout, session history.

---

## 10. Usability validation plan

**Method.** Moderated, task-based sessions, 5–8 participants per round, within-subject comparison of the current prototype and the redesign (counterbalanced order). So far you are the only user; recruit outside the project.

**Participants.** (a) developers who have run local LLMs in LM Studio or Ollama; (b) technically comfortable people with two or more computers and no C++ background; (c) at least one person who already uses Tailscale or WireGuard.

| Task | What we are testing | Target (set baseline first) |
| --- | --- | --- |
| T1 First run to first reply | Setup, readiness language | ≥ 80% unassisted; note time and errors |
| T2 After 60 seconds on Session: “How many computers? Which holds the last layers? Which holds most?” | Mental model, ribbon legibility | ≥ 90% correct on “how many physical computers” |
| T3 Add a helper from a staged second machine, with a firewall block planted | Onboarding, error causes, private-network warning | ≥ 70% complete with at most one hint; zero unsafe exposure |
| T4 Helper has 0.93 GB free; “Why does it hold no layers?” | Reserve and idle-state explanation | ≥ 80% give the correct reason |
| T5 Helper killed mid-reply; recover | Stopped state, checklist order | ≥ 80% complete in the correct order |
| T6 End the session safely | Stop semantics, remote-helper wording | No orphaned process; correct understanding of what remains running |
| T7 On a phone: is the cluster healthy? send a prompt | Mobile monitor and chat | Answer correct in < 10 s |

**Measures.** Task completion; time on task; error count; assists; single-ease question after each task; think-aloud confusion tags; five-second test of the home screen (“what state is it in?”).

**Likely points of confusion.** “Session” versus “chat”; “reload to add a device” (users expect live add); “Idle (0 layers)” read as “offline”; what hue versus fill means on the ribbon; what “reserve” is for.

**Instrumentation.** A local-only event log of state transitions and error codes, never sent off the machine.

**Caveats.** Small samples find problems, not statistics. Real two-computer performance is unproven (one run in Milestone 12), so tests must not imply speed gains. Do not call the design validated until a second round meets the targets.

---

## 11. Research notes and references

**Limits of this research.** Claims come from documentation and secondary descriptions; I did not use these products hands-on. Docker Desktop and Ollama-app points rest on third-party descriptions. I did **not** research Linear, Raycast or the OS design systems in this pass; they are not needed for the decisions above, and platform guidance should be consulted when native behaviour (window chrome, notifications, Android permissions) is implemented.

**exo** (distributed inference across everyday devices) — https://landscape.jimmysong.io/projects/exo/ and a README copy at https://github.com/lightpoint-ventures/exo.

- *Learn:* devices discover each other automatically; a built-in dashboard serves cluster view and chat together; the macOS app runs in the background and offers a namespace so clusters on one network do not join each other by accident.
- *Why it works:* one place for chat and cluster; low setup effort.
- *Apply:* the idea of an isolation namespace or pairing code; chat and cluster in one product.
- *Do not copy:* auto-discovery without approval (Swarm’s RPC is unauthenticated, so silent LAN discovery would be unsafe); peer-to-peer equality (Swarm has a host and helpers); live re-partitioning claims (Swarm cannot do this).

**Tailscale device approval and add-device** — https://tailscale.com/docs/features/access-control/device-management/device-approval and https://tailscale.com/kb/1316/device-add.

- *Learn:* a new device waiting for approval cannot send or receive traffic; it appears with a “Needs approval” badge at the top of the machine list; devices can also be added by QR code.
- *Why it works:* trust is an explicit, visible state, and pending items surface first.
- *Apply:* the approval gate, pending-first device list, and (later) QR pairing from a phone.
- *Do not copy:* the account, tailnet and admin-console model.

**LM Studio** — https://lmstudio.ai/blog/lmstudio-v0.3.27, https://www.lmstudio.ai/docs/cli/local-models/load, and NVIDIA’s walkthrough https://blogs.nvidia.com/blog/ai-decoded-lm-studio.

- *Learn:* a memory estimate updates as context length and GPU offload change, with a warning before loading; the CLI can estimate without loading; commands can target a remote instance.
- *Why it works:* it prevents the failure instead of explaining it afterwards.
- *Apply:* plan-before-load, using Swarm’s own predicted placement.
- *Do not copy:* a single offload-percentage slider as the placement control — it hides *which device* holds what, which is exactly Swarm’s point.

**Docker Desktop** — https://thenewstack.io/view-the-resource-usage-of-your-docker-containers/ and https://oneuptime.com/blog/post/2026-02-08-how-to-use-docker-desktop-dashboard-effectively/markdown (secondary sources).

- *Learn:* the default view is a plain list with status and resource use per row; related containers are grouped; start/stop sits in the row.
- *Apply:* devices as rows, grouped under the session, with in-row actions.
- *Do not copy:* the sprawl of sections or an extension marketplace.

**Open WebUI and the Ollama app** — https://docs.openwebui.com/getting-started/quick-start/connect-a-provider/starting-with-ollama and a third-party overview at https://bestllmfor.com/guide/interfaces-graphiques-ollama-comparatif/.

- *Learn:* a per-request context setting can silently override the server default — a trap of layered settings; the Ollama app is deliberately chat-first with a context slider.
- *Apply:* one visible source of truth per setting; chat-first restraint.
- *Do not copy:* breadth (RAG, accounts, plugins). Swarm’s composer must not suggest features the backend lacks.

**llama.cpp RPC documentation** — https://huggingface.co/datasets/echodict/llama.cpp/blob/main/tools/rpc/README.md (mirror).

- *Learn:* the RPC backend is described as proof-of-concept, fragile and insecure; by default weights and KV cache are distributed across local and remote devices in proportion to each device’s available memory.
- *Apply:* the basis for the security messaging and the “why this split?” explanation.

---

## 12. Decisions I need from you, and the handoff brief

### The few decisions that genuinely need your input

1. **Concept.** Do you accept *The Session* (Concept B) and the words **Device / Host / Helper**?
2. **Supervisor.** Are you willing to add a small loopback-only local supervisor (and later a desktop shell)? Without it, start, stop and failure explanation stay manual.
3. **Chat persistence.** Should conversations survive a session restart?
4. **First non-developer target.** Is it a Windows home-lab with two PCs on a private overlay? That decides what Add-device must handle first.
5. **Pairing scope.** Is a Tailscale-style approval step acceptable as new scope?

### Brief for the frontend implementation agent (after you approve)

**Do**

- Build the single derived session model first (P0-2) and test it with the 37-layer fixture.
- Apply the vocabulary and IA (sections 3 and 4) before any restyling.
- Implement the tokens, type and component rules in section 7; remove card containers and uppercase labels.
- Represent every state in section 6.8, including Stopped and Not running.
- Keep provenance visible and treat `null` as “Not available”, never as zero.

**Do not**

- Add endpoints or screens because an endpoint exists.
- Sum memory across loopback helpers or draw loopback as a network.
- Show a worker as participating because it is `READY`.
- Show fake load progress or per-device live activity.
- Add attachments, web search, voice or other features the backend lacks.
- Offer any control that exposes RPC beyond loopback or a private overlay.

**Verify on every change:** reconciliation across screens; viewports 320, 390, 768, 1440; contrast table; keyboard-only run of Chat and Add device.

**Inputs still missing:** desktop Chat screenshots (empty, mid-stream, finished) and one mobile Chat screenshot.
