# Swarm Security Architecture — Remote-Node Readiness

**Document Version:** 1.0.0  
**Milestone:** 10 — Secure Remote-Node Readiness  
**Date:** 2026-10-10  
**Scope:** Distributed LLM inference security model across Coordinator, Reporting Agents, and GGML RPC Workers.

---

## 1. Executive Summary and Threat Model

Swarm distributes LLM inference across heterogeneous computing nodes (CPU, CUDA, remote RPC backends). Prior to Milestone 10, cluster components operated in a trusted, unauthenticated environment suitable only for local loopback development.

Milestone 10 defines and implements the security boundary required before deploying Swarm across independent computers on a network.

### 1.1 Threat Surface Matrix

| Network Channel | Transport | Default Port | Threat Surface | Security Mechanism |
|---|---|---|---|---|
| **Coordinator Public API** | HTTP/1.1 | 8080 | Untrusted clients querying model inference (`/v1/chat/completions`) or cluster health (`/health`, `/metrics`, `/nodes`) | Reverse proxy / API Gateway / Network boundary |
| **Telemetry Ingestion** | HTTP/1.1 | 8080 (`/api/v1/nodes/report`, `/nodes/report`) | Malicious or rogue agents injecting false hardware metrics, spoofing nodes, or exhausting coordinator memory | **Bearer Token Auth**, Constant-Time Compare, 64KB Payload Limit, Monotonic Freshness, Replay Rejection |
| **GGML RPC Data Plane** | Raw TCP binary | 50052, 50053 | Direct execution of tensor allocation, model weights upload, and compute graphs | **Strict Network Isolation (Loopback or Encrypted Overlay)**; unauthenticated and unencrypted protocol |

### 1.2 Core Security Distinctions

To ensure security guarantees are transparent and honest, Swarm explicitly distinguishes:

1. **Confidentiality:** Preventing eavesdropping of prompts, model weights, and hardware telemetry.
2. **Server Authentication:** Verifying that worker agents and RPC clients are communicating with the genuine coordinator, not an impersonator.
3. **Client Authentication:** Verifying the identity of worker agents submitting telemetry reports to the coordinator.
4. **Authorization:** Ensuring only registered, authenticated nodes can influence layer placement and capacity budgets.
5. **Data Integrity:** Ensuring telemetry payloads and tensor data are not modified in transit.
6. **Replay Protection:** Ensuring recorded legitimate telemetry packets cannot be replayed to deceive the coordinator into treating a dead or altered node as fresh.
7. **Network Isolation:** Restricting raw network listeners to private, encrypted point-to-point tunnels (e.g. WireGuard or Tailscale).

> [!CRITICAL]
> **GGML RPC Security Reality:** Protecting the HTTP telemetry endpoint does **NOT** secure GGML RPC. The upstream GGML RPC protocol provides **zero native authentication, zero transport encryption, and zero authorization**. Exposing `ggml-rpc-server` to an untrusted or public network allows arbitrary remote actors to allocate buffers and execute arbitrary compute graphs. GGML RPC must **never** be exposed outside loopback or an authenticated, encrypted VPN overlay.

---

## 2. Telemetry Ingestion Security (Coordinator & Agent)

### 2.1 Authentication Contract
The telemetry reporting endpoint (`POST /api/v1/nodes/report` and `POST /nodes/report`) enforces HTTP Bearer token authentication:

```http
POST /api/v1/nodes/report HTTP/1.1
Host: coordinator:8080
Authorization: Bearer <shared_secret_token>
Content-Type: application/json
Content-Length: ...
```

### 2.2 Rejection Codes & Enforcement Policy
The coordinator validates requests in strict sequence before updating any cluster state:

1. **Payload Size Guard (HTTP 413):** If `Content-Length` or raw body exceeds 64 KiB (`65,536 bytes`), reject with `HTTP 413 Payload Too Large`.
2. **Authentication Guard:**
   - If `SWARM_TELEMETRY_TOKEN` is configured on the coordinator:
     - Missing `Authorization` header $\rightarrow$ **HTTP 401 Unauthorized** (`{"error": "Unauthorized: Missing Authorization header"}`).
     - Malformed format (not `Bearer <token>`) $\rightarrow$ **HTTP 401 Unauthorized** (`{"error": "Unauthorized: Invalid Authorization header format"}`).
     - Token mismatch $\rightarrow$ **HTTP 403 Forbidden** (`{"error": "Forbidden: Invalid telemetry authentication token"}`).
   - If `SWARM_TELEMETRY_TOKEN` is **not** configured:
     - Insecure loopback-only development mode is active.
     - Requests from loopback (`127.0.0.1`, `::1`) are permitted with a logged security warning.
     - Requests from non-loopback addresses are rejected with **HTTP 403 Forbidden** (`{"error": "Forbidden: Unauthenticated telemetry is rejected for remote clients. Configure SWARM_TELEMETRY_TOKEN."}`).
3. **Timing-Attack Resistance:**
   Token verification uses a constant-time comparison algorithm (`volatile` bitwise XOR accumulator) to eliminate timing side-channel leakage:
   ```cpp
   bool constant_time_equals(const std::string& a, const std::string& b) {
       if (a.size() != b.size()) return false;
       volatile unsigned char diff = 0;
       for (size_t i = 0; i < a.size(); ++i) {
           diff |= static_cast<unsigned char>(a[i] ^ b[i]);
       }
       return diff == 0;
   }
   ```
4. **State Isolation:**
   Unauthorized requests are rejected immediately without acquiring the inventory mutex and without updating `last_observed_ms` or `last_receipt_time_ms`. Telemetry freshness is never refreshed by unauthenticated attempts.

### 2.3 Secret Management & Configuration
- **Coordinator Configuration:**
  - Environment variable: `SWARM_TELEMETRY_TOKEN` (fallback: `SWARM_AUTH_TOKEN`).
  - Secrets are never logged to console, written to log files, or echoed in error payloads.
  - Startup logs display only: `Telemetry Auth: Enabled (token configured)`.
- **Worker Agent Configuration:**
  - CLI flag: `--token <secret>` or `--auth-token <secret>`.
  - Environment variable: `SWARM_TELEMETRY_TOKEN` or `SWARM_AUTH_TOKEN`.
  - Secrets are never written into report JSON payloads or printed in agent stdout.

---

## 3. Transport Security & Network Isolation

### 3.1 Transport Security Assessment
- The existing project build links `cpp-httplib` in standard C++ without external OpenSSL runtime dependencies.
- **Honest Security Posture:** An API token transmitted over unencrypted HTTP across an untrusted network is vulnerable to packet sniffing and man-in-the-middle attacks.
- Therefore, HTTP Bearer tokens are considered safe **only** on:
  1. The local machine kernel loopback interface (`127.0.0.1`).
  2. Point-to-point authenticated, encrypted network tunnels (WireGuard / Tailscale).

### 3.2 GGML RPC Security Boundary & VPN Overlay Architecture
Because GGML RPC cannot perform in-protocol authentication or encryption, distributed Swarm clusters must encapsulate all inter-node traffic inside an encrypted network overlay:

```
+-----------------------------------------------------------------------------------+
|                            SECURE OVERLAY (WireGuard / Tailscale)                |
|                                                                                   |
|  +---------------------------+                +--------------------------------+  |
|  |     COORDINATOR NODE      |                |         WORKER NODE 1          |  |
|  | WireGuard IP: 10.42.0.1   |                | WireGuard IP: 10.42.0.2        |  |
|  |                           |                |                                |  |
|  | [Swarm Gateway]           |                | [ggml-rpc-server]              |  |
|  |   Listening: 10.42.0.1:8080| <=== WireGuard |   Listening: 10.42.0.2:50052   |  |
|  |   (Auth: Bearer Token)    |     Encrypted  |   (Firewall: only 10.42.0.1)   |  |
|  |                           |     Tunnel     |                                |  |
|  | [GGML RPC Client] --------+--------------->| [swarm_agent]                  |  |
|  |                           |     (UDP 51820)|   Reporting to: 10.42.0.1:8080 |  |
|  +---------------------------+                +--------------------------------+  |
+-----------------------------------------------------------------------------------+
```

### 3.3 Network Port Isolation Matrix

| Port / Protocol | Host | Binding Address | Permitted Inbound Sources | Risk Level if Exposed |
|---|---|---|---|---|
| **TCP 8080** | Coordinator | `10.42.0.1` (Overlay) or `127.0.0.1` | Local host, authorized overlay peers | High (unauthorized inference or telemetry spoofing) |
| **TCP 50052 / 50053** | Worker | `10.42.0.2` (Overlay) or `127.0.0.1` | **Coordinator overlay IP ONLY** (`10.42.0.1`) | **CRITICAL (Arbitrary memory allocation & compute execution)** |
| **UDP 51820** | All Nodes | `0.0.0.0` (Public IP) | Internet / Router (Encrypted WireGuard handshakes) | Low (Cryptographically authenticated via Noise protocol) |

### 3.4 Firewall Rules (Windows & Linux Example)

#### Windows Host (Coordinator):
```powershell
# Restrict coordinator telemetry port 8080 to loopback and overlay subnet
New-NetFirewallRule -DisplayName "Swarm Coordinator Private" -Direction Inbound `
    -LocalPort 8080 -Protocol TCP -Action Allow `
    -RemoteAddress @("127.0.0.1", "10.42.0.0/24")
```

#### Windows Host (Worker):
```powershell
# Block all external access to GGML RPC except from coordinator overlay IP
New-NetFirewallRule -DisplayName "Swarm GGML RPC Coordinator Only" -Direction Inbound `
    -LocalPort 50052, 50053 -Protocol TCP -Action Allow `
    -RemoteAddress @("127.0.0.1", "10.42.0.1")
```

---

## 4. Replay Protection & Telemetry Freshness

1. **Monotonic Elapsed-Time Freshness:**
   Freshness is calculated strictly as `(coordinator_now_ms - last_receipt_time_ms) > 30,000ms`. Worker wall-clock timestamps are never subtracted from the coordinator clock to assess staleness.
2. **Session and Sequence Number Tracking:**
   Every report carries an `agent_session_id` (generated at agent startup) and a monotonically incrementing `sequence_number`. Reports matching the active session must strictly advance the sequence number:
   `sequence_number > last_sequence_number`.
3. **Replay Invalidation:**
   Replayed or re-transmitted reports with identical or retrograded sequence numbers are rejected (`err: Replayed report rejected`). Replayed attempts never extend `last_receipt_time_ms`.
4. **Known Limitation (In-Memory Persistence):**
   Sequence number records reside in coordinator memory. On coordinator restart, sequence counters reset. Cryptographic nonces and persistent disk storage are deferred to subsequent production hardening.

---

## 5. Milestone 11 Production Hardening & Operational Controls

### 5.1 Protected File-Based Secret Ingestion
On multi-user Windows and Linux environments, passing secrets via CLI arguments (`--token <secret>`) or setting unprotected global environment variables exposes secrets to unprivileged local users via `Get-Process`, Task Manager, or `/proc/*/cmdline`.

Milestone 11 introduces:
- `swarm::security::read_secret_from_file(path, out_secret)` with whitespace trimming.
- Coordinator support for `SWARM_TELEMETRY_TOKEN_FILE`.
- Agent support for `--token-file <path>` and `SWARM_TELEMETRY_TOKEN_FILE`.
- Automatic security warnings logged if `--token` is provided via CLI.

### 5.2 Fail-Secure Production Preflight Mode
Swarm recognizes `SWARM_DEPLOYMENT_ENV`:
- **"development" (default):** Permissive loopback behavior preserved for local testing. Unauthenticated loopback telemetry accepted with logged warnings; remote telemetry denied HTTP 403.
- **"production":** Strict fail-secure mode. Coordinator startup **aborts immediately with exit code 1** if no telemetry token is configured via `SWARM_TELEMETRY_TOKEN` or `SWARM_TELEMETRY_TOKEN_FILE`.

### 5.3 Remote RPC Preflight Transport Advisories
During coordinator startup in production mode, all registered endpoints in `SWARM_RPC_ENDPOINTS` are evaluated against loopback address patterns. For any non-loopback endpoint, the coordinator logs explicit security advisories reminding operators that GGML RPC is unencrypted and must be encapsulated within a WireGuard or Tailscale VPN tunnel.
