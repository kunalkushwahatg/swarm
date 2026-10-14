// test_profiles_ui.mjs
// Automated frontend integration and deterministic fixture validation for Swarm Phase C.3.9
// Validates all 11 required behaviors without launching real engine or loading weights.

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Minimal deterministic DOM mock for testing supervisor-diagnostics.js
class MockElement {
  constructor(tagName = 'div', doc = null) {
    this.tagName = tagName;
    this.doc = doc;
    this.style = {};
    this.id = '';
    this.disabled = false;
    this._innerHTML = '';
    this._innerText = '';
    this.onclick = null;
    this.onchange = null;
    this.children = [];
  }

  prepend(child) {
    this.children.unshift(child);
    if (child.id && this.doc) {
      this.doc.elementsById.set(child.id, child);
    }
  }

  appendChild(child) {
    this.children.push(child);
    if (child.id && this.doc) {
      this.doc.elementsById.set(child.id, child);
    }
  }

  get innerHTML() {
    return this._innerHTML;
  }

  set innerHTML(val) {
    this._innerHTML = val;
    this._innerText = val.replace(/<[^>]*>/g, ' ');
    if (this.doc) {
      this.doc.indexIds(val);
    }
  }

  get innerText() {
    return this._innerText;
  }

  set innerText(val) {
    this._innerText = val;
  }
}

class MockDocument {
  constructor() {
    this.elementsById = new Map();
    this.body = new MockElement('body', this);
    this.readyState = 'complete';
  }

  createElement(tag) {
    return new MockElement(tag, this);
  }

  getElementById(id) {
    return this.elementsById.get(id) || null;
  }

  addEventListener() {}

  indexIds(html) {
    const idRegex = /id=["']([^"']+)["']/g;
    let match;
    while ((match = idRegex.exec(html)) !== null) {
      const id = match[1];
      if (!this.elementsById.has(id)) {
        const el = new MockElement('div', this);
        el.id = id;
        this.elementsById.set(id, el);
      }
    }
  }
}

// Deterministic test fixtures matching supervisor backend schema
const FIXTURES = {
  both_eligible: {
    default_profile_id: 'default',
    queried_ram_mb: 1600,
    queried_vram_mb: 3500,
    query_timestamp: '2026-10-12T16:00:00Z',
    profiles: [
      {
        id: 'default',
        display_name: 'Standard Distributed Cluster',
        description: 'Dual-process distributed cluster with coordinator and local RPC worker.',
        is_default: true,
        required_ram_mb: 1500,
        required_vram_mb: null,
        coordinator_port: 8080,
        rpc_port: 50052,
        requires_rpc_worker: true,
        requires_real_authorization: true,
        env_vars: [
          { key: 'SWARM_USE_RPC', value: '1' },
          { key: 'PORT', value: '8080' },
          { key: 'SWARM_N_GPU_LAYERS', value: '4' },
          { key: 'SWARM_CTX_SIZE', value: '2048' },
          { key: 'SWARM_RPC_ENDPOINTS', value: '127.0.0.1:50052' },
        ],
        eligibility: {
          satisfies_ram: true,
          satisfies_vram: true,
          ram_status: 'Satisfied',
          vram_status: 'Satisfied',
          ports_available: true,
          can_launch_now: true,
          note: 'Eligible for launch: Meets RAM threshold (1500 MB) and VRAM requirements; required ports free.',
        },
      },
      {
        id: 'low_memory_cuda_standalone',
        display_name: 'Standalone Single-GPU (Low Memory)',
        description: 'Isolated single-process coordinator offloading all 37 model layers to local CUDA.',
        is_default: false,
        required_ram_mb: 1000,
        required_vram_mb: 3100,
        coordinator_port: 8080,
        rpc_port: null,
        requires_rpc_worker: false,
        requires_real_authorization: true,
        env_vars: [
          { key: 'SWARM_USE_RPC', value: '0' },
          { key: 'PORT', value: '8080' },
          { key: 'SWARM_N_GPU_LAYERS', value: '-1' },
          { key: 'SWARM_CTX_SIZE', value: '512' },
        ],
        eligibility: {
          satisfies_ram: true,
          satisfies_vram: true,
          ram_status: 'Satisfied',
          vram_status: 'Satisfied',
          ports_available: true,
          can_launch_now: true,
          note: 'Eligible for launch: Meets RAM threshold (1000 MB) and VRAM requirements; required ports free.',
        },
      },
    ],
  },

  ram_deficit: {
    default_profile_id: 'default',
    queried_ram_mb: 1200,
    queried_vram_mb: 3500,
    query_timestamp: '2026-10-12T16:00:00Z',
    profiles: [
      {
        id: 'default',
        display_name: 'Standard Distributed Cluster',
        description: 'Dual-process distributed cluster with coordinator and local RPC worker.',
        is_default: true,
        required_ram_mb: 1500,
        required_vram_mb: null,
        coordinator_port: 8080,
        rpc_port: 50052,
        requires_rpc_worker: true,
        requires_real_authorization: true,
        env_vars: [
          { key: 'SWARM_USE_RPC', value: '1' },
          { key: 'PORT', value: '8080' },
          { key: 'SWARM_N_GPU_LAYERS', value: '4' },
          { key: 'SWARM_CTX_SIZE', value: '2048' },
        ],
        eligibility: {
          satisfies_ram: false,
          satisfies_vram: true,
          ram_status: { Deficit: { current: 1200, required: 1500 } },
          vram_status: 'Satisfied',
          ports_available: true,
          can_launch_now: false,
          note: 'Ineligible: RAM deficit (1200 MB < 1500 MB).',
        },
      },
      {
        id: 'low_memory_cuda_standalone',
        display_name: 'Standalone Single-GPU (Low Memory)',
        description: 'Isolated single-process coordinator offloading all 37 model layers to local CUDA.',
        is_default: false,
        required_ram_mb: 1000,
        required_vram_mb: 3100,
        coordinator_port: 8080,
        rpc_port: null,
        requires_rpc_worker: false,
        requires_real_authorization: true,
        env_vars: [
          { key: 'SWARM_USE_RPC', value: '0' },
          { key: 'PORT', value: '8080' },
          { key: 'SWARM_N_GPU_LAYERS', value: '-1' },
          { key: 'SWARM_CTX_SIZE', value: '512' },
        ],
        eligibility: {
          satisfies_ram: true,
          satisfies_vram: true,
          ram_status: 'Satisfied',
          vram_status: 'Satisfied',
          ports_available: true,
          can_launch_now: true,
          note: 'Eligible for launch: Meets RAM threshold (1000 MB) and VRAM requirements; required ports free.',
        },
      },
    ],
  },

  vram_deficit: {
    default_profile_id: 'default',
    queried_ram_mb: 1600,
    queried_vram_mb: 2800,
    query_timestamp: '2026-10-12T16:00:00Z',
    profiles: [
      {
        id: 'default',
        display_name: 'Standard Distributed Cluster',
        description: 'Dual-process distributed cluster with coordinator and local RPC worker.',
        is_default: true,
        required_ram_mb: 1500,
        required_vram_mb: null,
        coordinator_port: 8080,
        rpc_port: 50052,
        requires_rpc_worker: true,
        requires_real_authorization: true,
        env_vars: [
          { key: 'SWARM_USE_RPC', value: '1' },
          { key: 'PORT', value: '8080' },
          { key: 'SWARM_N_GPU_LAYERS', value: '4' },
          { key: 'SWARM_CTX_SIZE', value: '2048' },
        ],
        eligibility: {
          satisfies_ram: true,
          satisfies_vram: true,
          ram_status: 'Satisfied',
          vram_status: 'Satisfied',
          ports_available: true,
          can_launch_now: true,
          note: 'Eligible for launch: Meets RAM threshold (1500 MB) and VRAM requirements; required ports free.',
        },
      },
      {
        id: 'low_memory_cuda_standalone',
        display_name: 'Standalone Single-GPU (Low Memory)',
        description: 'Isolated single-process coordinator offloading all 37 model layers to local CUDA.',
        is_default: false,
        required_ram_mb: 1000,
        required_vram_mb: 3100,
        coordinator_port: 8080,
        rpc_port: null,
        requires_rpc_worker: false,
        requires_real_authorization: true,
        env_vars: [
          { key: 'SWARM_USE_RPC', value: '0' },
          { key: 'PORT', value: '8080' },
          { key: 'SWARM_N_GPU_LAYERS', value: '-1' },
          { key: 'SWARM_CTX_SIZE', value: '512' },
        ],
        eligibility: {
          satisfies_ram: true,
          satisfies_vram: false,
          ram_status: 'Satisfied',
          vram_status: { Deficit: { current: 2800, required: 3100 } },
          ports_available: true,
          can_launch_now: false,
          note: 'Ineligible: GPU VRAM deficit (2800 MiB < 3100 MiB).',
        },
      },
    ],
  },

  unknown_metrics: {
    default_profile_id: 'default',
    queried_ram_mb: null,
    queried_vram_mb: null,
    query_timestamp: '2026-10-12T16:00:00Z',
    profiles: [
      {
        id: 'default',
        display_name: 'Standard Distributed Cluster',
        description: 'Dual-process distributed cluster with coordinator and local RPC worker.',
        is_default: true,
        required_ram_mb: 1500,
        required_vram_mb: null,
        coordinator_port: 8080,
        rpc_port: 50052,
        requires_rpc_worker: true,
        requires_real_authorization: true,
        env_vars: [],
        eligibility: {
          satisfies_ram: null,
          satisfies_vram: true,
          ram_status: { Unavailable: { reason: 'Sensor unreadable' } },
          vram_status: 'Satisfied',
          ports_available: true,
          can_launch_now: false,
          note: 'Status Unknown: Host RAM sensor unreadable.',
        },
      },
      {
        id: 'low_memory_cuda_standalone',
        display_name: 'Standalone Single-GPU (Low Memory)',
        description: 'Isolated single-process coordinator offloading all 37 model layers to local CUDA.',
        is_default: false,
        required_ram_mb: 1000,
        required_vram_mb: 3100,
        coordinator_port: 8080,
        rpc_port: null,
        requires_rpc_worker: false,
        requires_real_authorization: true,
        env_vars: [],
        eligibility: {
          satisfies_ram: null,
          satisfies_vram: null,
          ram_status: { Unavailable: { reason: 'Sensor unreadable' } },
          vram_status: { Unavailable: { reason: 'GPU sensor unreadable' } },
          ports_available: true,
          can_launch_now: false,
          note: 'Status Unknown: Host RAM and GPU VRAM sensors unreadable.',
        },
      },
    ],
  },

  rpc_port_conflict: {
    default_profile_id: 'default',
    queried_ram_mb: 1600,
    queried_vram_mb: 3500,
    query_timestamp: '2026-10-12T16:00:00Z',
    profiles: [
      {
        id: 'default',
        display_name: 'Standard Distributed Cluster',
        description: 'Dual-process distributed cluster with coordinator and local RPC worker.',
        is_default: true,
        required_ram_mb: 1500,
        required_vram_mb: null,
        coordinator_port: 8080,
        rpc_port: 50052,
        requires_rpc_worker: true,
        requires_real_authorization: true,
        env_vars: [],
        eligibility: {
          satisfies_ram: true,
          satisfies_vram: true,
          ram_status: 'Satisfied',
          vram_status: 'Satisfied',
          ports_available: false,
          can_launch_now: false,
          note: 'Ineligible: RPC worker port 50052 is currently bound by an external process.',
        },
      },
      {
        id: 'low_memory_cuda_standalone',
        display_name: 'Standalone Single-GPU (Low Memory)',
        description: 'Isolated single-process coordinator offloading all 37 model layers to local CUDA.',
        is_default: false,
        required_ram_mb: 1000,
        required_vram_mb: 3100,
        coordinator_port: 8080,
        rpc_port: null,
        requires_rpc_worker: false,
        requires_real_authorization: true,
        env_vars: [],
        eligibility: {
          satisfies_ram: true,
          satisfies_vram: true,
          ram_status: 'Satisfied',
          vram_status: 'Satisfied',
          ports_available: true,
          can_launch_now: true,
          note: 'Eligible for launch: Port 8080 free; RPC worker port 50052 bypassed in standalone mode.',
        },
      },
    ],
  },
};

const DIAGNOSTICS_FIXTURE = {
  supervisor_initialized: true,
  job_object_active: true,
  host_platform: 'Windows-x64-TestFixture',
  managed_children_count: 0,
  managed_children: [],
  coordinator_port: { occupied: false, listening: false, description: 'Available' },
  rpc_port: { occupied: false, listening: false, description: 'Available' },
  coordinator_health: { reachable: false, status_code: null, inference_ready: null },
  rpc_reachability: { reachable: false, duration_ms: 0, status_note: 'Not tested', diagnostic_state: 'NOT_TESTED' },
  configuration_valid: true,
  coordinator_executable: { path: 'build-cuda\\swarm_node.exe', exists: true },
  rpc_executable: { path: 'dist\\ggml-rpc-server.exe', exists: true },
  dll_directories: [{ path: 'build-cuda', exists: true }],
  model_file: { path: 'models\\qwen2.5-3b-instruct-q4_k_m.official-check.gguf', exists: true, size_bytes: 2104932768, recorded_sha256_provenance: '626B4A66...' },
  issues: [],
  is_simulated_fixture: true,
  fixture_name: 'ports_available',
};

async function runTestSuite() {
  console.log('==========================================================');
  console.log('  Swarm Phase C.3.9 Frontend Integration Test Suite');
  console.log('==========================================================\n');

  let passedCount = 0;
  let failedCount = 0;
  const testResults = [];

  function record(name, passed, details) {
    if (passed) {
      passedCount++;
      console.log(`  [PASS] ${name}`);
    } else {
      failedCount++;
      console.log(`  [FAIL] ${name} - Details: ${JSON.stringify(details)}`);
    }
    testResults.push({ name, passed, details });
  }

  // Load the supervisor script code
  const scriptPath = path.join(__dirname, 'dist', 'assets', 'supervisor-diagnostics.js');
  const scriptCode = fs.readFileSync(scriptPath, 'utf-8');

  // Helper to create an isolated harness environment
  function createHarness(options = {}) {
    const document = new MockDocument();
    const interceptedCalls = [];
    let currentProfileResponse = options.initialProfiles || FIXTURES.both_eligible;

    const window = {
      __TAURI_INTERNALS__: {
        invoke: async (cmd, args = {}) => {
          interceptedCalls.push({ cmd, args });
          if (cmd === 'supervisor_get_engine_status') {
            return { state: 'Stopped', rpc_pid: null, coordinator_pid: null, rpc_port: 0, coordinator_port: 0, last_error: null };
          }
          if (cmd === 'supervisor_get_diagnostics' || cmd === 'supervisor_get_diagnostic_fixture') {
            return DIAGNOSTICS_FIXTURE;
          }
          if (cmd === 'supervisor_get_available_profiles') {
            if (options.simulateIpcError) {
              throw new Error('Simulated Backend IPC Disconnection');
            }
            return currentProfileResponse;
          }
          if (cmd === 'supervisor_get_profile_fixture') {
            const fix = args.fixtureName;
            if (fix === 'profile_both_eligible') return FIXTURES.both_eligible;
            if (fix === 'profile_ram_deficit') return FIXTURES.ram_deficit;
            if (fix === 'profile_vram_deficit') return FIXTURES.vram_deficit;
            if (fix === 'profile_unknown_metrics') return FIXTURES.unknown_metrics;
            if (fix === 'profile_rpc_port_conflict') return FIXTURES.rpc_port_conflict;
            if (fix === 'profile_ipc_error') throw new Error('Simulated Profile IPC Error');
            throw new Error(`Unknown profile fixture: ${fix}`);
          }
          if (cmd === 'supervisor_start_engine') {
            throw new Error('SAFETY VIOLATION: supervisor_start_engine must not be called from selector!');
          }
          if (cmd === 'supervisor_stop_engine') {
            throw new Error('SAFETY VIOLATION: supervisor_stop_engine must not be called from selector!');
          }
          throw new Error(`Unexpected command: ${cmd}`);
        },
      },
      __SWARM_PROFILES_STATE__: null,
    };
    window.invoke = window.__TAURI_INTERNALS__.invoke;

    // Execute supervisor-diagnostics.js inside harness scope
    const runner = new Function('window', 'document', scriptCode);
    runner(window, document);

    return { window, document, interceptedCalls, setProfiles: (p) => { currentProfileResponse = p; } };
  }

  // -----------------------------------------------------------------
  // Test 1: Default Cluster is Selected Initially
  // -----------------------------------------------------------------
  {
    const h = createHarness();
    // Allow promises in init() to resolve
    await new Promise((r) => setTimeout(r, 50));
    const state = h.window.__SWARM_PROFILES_STATE__;
    const selectedId = state.getSelectedProfileId();
    const passed = selectedId === 'default';
    record('Test 1: Default cluster selected initially', passed, { selectedId });
  }

  // -----------------------------------------------------------------
  // Test 2: Switching Profiles Updates Displayed Requirements
  // -----------------------------------------------------------------
  {
    const h = createHarness();
    await new Promise((r) => setTimeout(r, 50));
    const state = h.window.__SWARM_PROFILES_STATE__;

    // Switch to standalone CUDA profile
    state.setSelectedProfileId('low_memory_cuda_standalone');
    const selectedId = state.getSelectedProfileId();
    const rootHtml = h.document.getElementById('swarm-supervisor-panel').innerHTML;

    const hasStandaloneCard = rootHtml.includes('swarm-profile-card-low_memory_cuda_standalone');
    const has3100Vram = rootHtml.includes('3100 MiB') || rootHtml.includes('3,100 MiB');
    const has512Ctx = rootHtml.includes('512 ctx');
    const passed = selectedId === 'low_memory_cuda_standalone' && hasStandaloneCard && has3100Vram && has512Ctx;
    record('Test 2: Switching profiles updates displayed requirements', passed, { selectedId, has3100Vram, has512Ctx });
  }

  // -----------------------------------------------------------------
  // Test 3: Eligible Status is Displayed Correctly
  // -----------------------------------------------------------------
  {
    const h = createHarness({ initialProfiles: FIXTURES.both_eligible });
    await new Promise((r) => setTimeout(r, 50));
    const rootHtml = h.document.getElementById('swarm-supervisor-panel').innerHTML;

    const hasEligibleBadge = rootHtml.includes('ELIGIBLE FOR LAUNCH');
    const hasPassRam = rootHtml.includes('PASS (Sufficient Headroom)');
    const passed = hasEligibleBadge && hasPassRam;
    record('Test 3: Eligible status displayed correctly', passed, { hasEligibleBadge, hasPassRam });
  }

  // -----------------------------------------------------------------
  // Test 4: RAM Below Threshold Displays Clear Failure
  // -----------------------------------------------------------------
  {
    const h = createHarness({ initialProfiles: FIXTURES.ram_deficit });
    await new Promise((r) => setTimeout(r, 50));
    // Default cluster is selected (requires 1500 MB; available is 1200 MB)
    const rootHtml = h.document.getElementById('swarm-supervisor-panel').innerHTML;

    const hasIneligible = rootHtml.includes('INELIGIBLE');
    const hasDeficit = rootHtml.includes('DEFICIT (Insufficient RAM)');
    const passed = hasIneligible && hasDeficit;
    record('Test 4: RAM below threshold displays clear failure', passed, { hasIneligible, hasDeficit });
  }

  // -----------------------------------------------------------------
  // Test 5: VRAM Below Standalone Threshold Displays Clear Failure
  // -----------------------------------------------------------------
  {
    const h = createHarness({ initialProfiles: FIXTURES.vram_deficit });
    await new Promise((r) => setTimeout(r, 50));
    const state = h.window.__SWARM_PROFILES_STATE__;

    // In cluster mode (unconstrained VRAM), cluster remains eligible
    const clusterHtml = h.document.getElementById('swarm-supervisor-panel').innerHTML;
    const clusterEligible = clusterHtml.includes('ELIGIBLE FOR LAUNCH');

    // Switch to standalone CUDA (requires 3100 MiB; available is 2800 MiB)
    state.setSelectedProfileId('low_memory_cuda_standalone');
    const standaloneHtml = h.document.getElementById('swarm-supervisor-panel').innerHTML;
    const standaloneIneligible = standaloneHtml.includes('INELIGIBLE');
    const standaloneDeficit = standaloneHtml.includes('DEFICIT (Insufficient VRAM)');

    const passed = clusterEligible && standaloneIneligible && standaloneDeficit;
    record('Test 5: VRAM below standalone threshold displays clear failure', passed, {
      clusterEligible,
      standaloneIneligible,
      standaloneDeficit,
    });
  }

  // -----------------------------------------------------------------
  // Test 6: Missing RAM or VRAM Measurements Display Unknown
  // -----------------------------------------------------------------
  {
    const h = createHarness({ initialProfiles: FIXTURES.unknown_metrics });
    await new Promise((r) => setTimeout(r, 50));
    const rootHtml = h.document.getElementById('swarm-supervisor-panel').innerHTML;

    const hasUnknown = rootHtml.includes('UNKNOWN (MEASUREMENTS UNAVAILABLE)');
    const hasFailClosed = rootHtml.includes('UNKNOWN (Unreadable)');
    const passed = hasUnknown && hasFailClosed;
    record('Test 6: Missing RAM/VRAM measurements display Unknown', passed, { hasUnknown, hasFailClosed });
  }

  // -----------------------------------------------------------------
  // Test 7: Port Conflicts Affect Only Profiles Requiring That Port
  // -----------------------------------------------------------------
  {
    const h = createHarness({ initialProfiles: FIXTURES.rpc_port_conflict });
    await new Promise((r) => setTimeout(r, 50));
    const state = h.window.__SWARM_PROFILES_STATE__;

    // Cluster requires port 50052: must be Ineligible
    const clusterHtml = h.document.getElementById('swarm-supervisor-panel').innerHTML;
    const clusterIneligible = clusterHtml.includes('INELIGIBLE');

    // Standalone bypasses port 50052: must be Eligible
    state.setSelectedProfileId('low_memory_cuda_standalone');
    const standaloneHtml = h.document.getElementById('swarm-supervisor-panel').innerHTML;
    const standaloneEligible = standaloneHtml.includes('ELIGIBLE FOR LAUNCH');

    const passed = clusterIneligible && standaloneEligible;
    record('Test 7: Port conflicts affect only profiles requiring that port', passed, {
      clusterIneligible,
      standaloneEligible,
    });
  }

  // -----------------------------------------------------------------
  // Test 8: IPC Errors Produce a Visible Error State
  // -----------------------------------------------------------------
  {
    const h = createHarness({ simulateIpcError: true });
    await new Promise((r) => setTimeout(r, 50));
    const state = h.window.__SWARM_PROFILES_STATE__;
    const err = state.getProfilesError();
    const rootHtml = h.document.getElementById('swarm-supervisor-panel').innerHTML;

    const hasErrorBanner = rootHtml.includes('swarm-profiles-error-banner');
    const hasErrorMessage = rootHtml.includes('Simulated Backend IPC Disconnection');
    const passed = !!err && hasErrorBanner && hasErrorMessage;
    record('Test 8: IPC errors produce visible error state', passed, { err, hasErrorBanner, hasErrorMessage });
  }

  // -----------------------------------------------------------------
  // Test 9: Unknown Profile IDs are Rejected
  // -----------------------------------------------------------------
  {
    const h = createHarness();
    await new Promise((r) => setTimeout(r, 50));
    const state = h.window.__SWARM_PROFILES_STATE__;

    // Try setting an unknown profile string
    state.setSelectedProfileId('unknown_rogue_profile');
    const selectedAfter = state.getSelectedProfileId();
    const err = state.getProfilesError();
    const rootHtml = h.document.getElementById('swarm-supervisor-panel').innerHTML;

    const rejected = selectedAfter === 'default'; // Did not adopt rogue profile
    const errorShown = rootHtml.includes('Unknown profile identifier') && rootHtml.includes('Silent fallback prevented');
    const passed = rejected && errorShown;
    record('Test 9: Unknown profile IDs are rejected', passed, { selectedAfter, err, errorShown });
  }

  // -----------------------------------------------------------------
  // Test 10: Selecting a Profile Cannot Launch or Stop Any Process
  // -----------------------------------------------------------------
  {
    const h = createHarness();
    await new Promise((r) => setTimeout(r, 50));
    const state = h.window.__SWARM_PROFILES_STATE__;

    // Switch between profiles multiple times
    state.setSelectedProfileId('low_memory_cuda_standalone');
    state.setSelectedProfileId('default');
    state.setSelectedProfileId('low_memory_cuda_standalone');

    // Verify zero calls to start or stop engine
    const startCalls = h.interceptedCalls.filter((c) => c.cmd === 'supervisor_start_engine');
    const stopCalls = h.interceptedCalls.filter((c) => c.cmd === 'supervisor_stop_engine');
    const passed = startCalls.length === 0 && stopCalls.length === 0;
    record('Test 10: Profile selection cannot launch or stop any process', passed, {
      startCalls: startCalls.length,
      stopCalls: stopCalls.length,
    });
  }

  // -----------------------------------------------------------------
  // Test 11: Ordinary Default Configuration & Startup Behavior Unchanged
  // -----------------------------------------------------------------
  {
    const h = createHarness();
    await new Promise((r) => setTimeout(r, 50));
    const pData = h.window.__SWARM_PROFILES_STATE__.getProfilesData();

    const def = pData.profiles.find((p) => p.id === 'default');
    const findEnv = (k) => def.env_vars.find((e) => e.key === k)?.value;

    const useRpc = findEnv('SWARM_USE_RPC') === '1';
    const gpuLayers = findEnv('SWARM_N_GPU_LAYERS') === '4';
    const ctxSize = findEnv('SWARM_CTX_SIZE') === '2048';
    const ramReq = def.required_ram_mb === 1500;
    const coordPort = def.coordinator_port === 8080;
    const rpcPort = def.rpc_port === 50052;
    const needsWorker = def.requires_rpc_worker === true;

    const passed = useRpc && gpuLayers && ctxSize && ramReq && coordPort && rpcPort && needsWorker;
    record('Test 11: Default configuration & behavior unchanged', passed, {
      useRpc,
      gpuLayers,
      ctxSize,
      ramReq,
      coordPort,
      rpcPort,
      needsWorker,
    });
  }

  console.log('\n==========================================================');
  console.log(`  Frontend Test Results: Total: 11 | Passed: ${passedCount} | Failed: ${failedCount}`);
  console.log('==========================================================');

  const reportPath = path.join(__dirname, 'frontend_profile_test_results.json');
  fs.writeFileSync(reportPath, JSON.stringify({ total: 11, passed: passedCount, failed: failedCount, tests: testResults }, null, 2));
  console.log(`Report written to: ${reportPath}`);

  if (failedCount > 0) {
    process.exit(1);
  }
}

runTestSuite().catch((err) => {
  console.error('Test execution failed:', err);
  process.exit(1);
});
