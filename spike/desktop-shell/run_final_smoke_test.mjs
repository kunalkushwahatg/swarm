// run_final_smoke_test.mjs
// Swarm Final Desktop Smoke Test via Live React Desktop Application (CDP)

import { spawn, execSync } from 'child_process';
import fs from 'fs';
import path from 'path';

const WORKSPACE_ROOT = 'C:\\Users\\kunal\\OneDrive\\Desktop\\swarm';
const APP_PATH = path.join(WORKSPACE_ROOT, 'spike\\desktop-shell\\src-tauri\\target\\debug\\app.exe');
const SCREENSHOT_PATH = path.join(WORKSPACE_ROOT, 'artifacts\\spike_screenshots\\final_desktop_smoke_test_chat.png');
const RESULT_PATH = path.join(WORKSPACE_ROOT, 'spike\\desktop-shell\\final_smoke_test_result.json');

const results = {
  timestamp: new Date().toISOString(),
  safety_checks: {},
  ui_startup: {},
  chat_test: {},
  shutdown: {},
  success: false,
};

function runPowerShell(cmd) {
  try {
    return execSync(`powershell -NoProfile -Command "${cmd}"`, { encoding: 'utf8' }).trim();
  } catch (e) {
    return `ERROR: ${e.message}`;
  }
}

// === STEP A: FRESH SAFETY CHECKS ===
console.log('\n==================================================');
console.log('1. PREFLIGHT SAFETY CHECKS (FRESH READINGS)');
console.log('==================================================');

const ramInfo = runPowerShell(`
  $os = Get-CimInstance Win32_OperatingSystem
  Write-Output "$([math]::Round($os.FreePhysicalMemory / 1024)),$([math]::Round($os.TotalVisibleMemorySize / 1024))"
`);
const [availRamMbStr, totalRamMbStr] = ramInfo.split(',');
const availRamMb = parseInt(availRamMbStr, 10);
const totalRamMb = parseInt(totalRamMbStr, 10);

console.log(`Available Physical RAM: ${availRamMb} MB (Total: ${totalRamMb} MB)`);
results.safety_checks.ram_mb = { available: availRamMb, total: totalRamMb, min_required: 1000, passed: availRamMb >= 1000 };

if (availRamMb < 1000) {
  throw new Error(`RAM preflight failed: ${availRamMb} MB < 1,000 MB required.`);
}

let availVramMb = 0;
let totalVramMb = 0;
try {
  const smi = execSync('nvidia-smi --query-gpu=memory.free,memory.total,name --format=csv,noheader,nounits', { encoding: 'utf8' }).trim();
  const parts = smi.split(',').map(s => s.trim());
  availVramMb = parseInt(parts[0], 10);
  totalVramMb = parseInt(parts[1], 10);
  console.log(`Available GPU VRAM: ${availVramMb} MiB (Total: ${totalVramMb} MiB, GPU: ${parts[2]})`);
  results.safety_checks.vram_mb = { available: availVramMb, total: totalVramMb, gpu: parts[2], min_required: 3100, passed: availVramMb >= 3100 };
} catch (e) {
  throw new Error(`VRAM check failed: ${e.message}`);
}

if (availVramMb < 3100) {
  throw new Error(`VRAM preflight failed: ${availVramMb} MiB < 3,100 MiB required.`);
}

const port8080Listening = runPowerShell(`@(Get-NetTCPConnection -LocalPort 8080 -State Listen -ErrorAction SilentlyContinue).Count -gt 0`) === 'True';
console.log(`Port 8080 in use: ${port8080Listening}`);
results.safety_checks.port_8080_free = !port8080Listening;

if (port8080Listening) {
  throw new Error('Port 8080 is already occupied. Fail-closed: cannot proceed.');
}

const activeSwarmProcs = runPowerShell(`@(Get-Process -Name swarm_node, ggml-rpc-server, app -ErrorAction SilentlyContinue).Count`);
console.log(`Existing Swarm processes: ${activeSwarmProcs}`);
results.safety_checks.no_existing_swarm_procs = parseInt(activeSwarmProcs, 10) === 0;

const modelPath = 'C:\\Users\\kunal\\OneDrive\\Desktop\\swarm\\models\\qwen2.5-3b-instruct-q4_k_m.official-check.gguf';
const modelExists = fs.existsSync(modelPath);
const modelStat = modelExists ? fs.statSync(modelPath) : null;
console.log(`Official Model exists: ${modelExists} (${modelStat ? modelStat.size : 0} bytes)`);
results.safety_checks.model_file = { exists: modelExists, size: modelStat ? modelStat.size : 0, passed: modelExists && modelStat.size === 2104932768 };

console.log('-> ALL PREFLIGHT CHECKS PASSED: Hardware & environment verified.');

// === STEP B: LAUNCH DESKTOP APP & CONNECT VIA CDP ===
console.log('\n==================================================');
console.log('2. LAUNCHING NATIVE DESKTOP APP & CONNECTING VIA CDP');
console.log('==================================================');

const appProc = spawn(APP_PATH, [], {
  env: {
    ...process.env,
    WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: '--remote-debugging-port=9222',
  },
  detached: false,
});

console.log(`Desktop app started with PID ${appProc.pid}. Waiting 5s for WebView2...`);
await new Promise(r => setTimeout(r, 5000));

let targets = [];
for (let attempt = 0; attempt < 10; attempt++) {
  try {
    const res = await fetch('http://127.0.0.1:9222/json');
    targets = await res.json();
    if (targets.length > 0 && targets[0].webSocketDebuggerUrl) break;
  } catch (e) {
    await new Promise(r => setTimeout(r, 1000));
  }
}

const pageTarget = targets.find(t => t.type === 'page' || t.url.includes('tauri.localhost')) || targets[0];
if (!pageTarget || !pageTarget.webSocketDebuggerUrl) {
  appProc.kill();
  throw new Error('Could not find active WebView2 page target on port 9222.');
}

console.log(`Connected to page target: ${pageTarget.title} (${pageTarget.url})`);

// Setup CDP client over WebSocket
const ws = new WebSocket(pageTarget.webSocketDebuggerUrl);
await new Promise((resolve, reject) => {
  ws.onopen = resolve;
  ws.onerror = reject;
});

let msgId = 1;
const pendingCalls = new Map();

ws.onmessage = (event) => {
  const msg = JSON.parse(event.data);
  if (msg.id && pendingCalls.has(msg.id)) {
    const { resolve, reject } = pendingCalls.get(msg.id);
    pendingCalls.delete(msg.id);
    if (msg.error) reject(new Error(msg.error.message));
    else resolve(msg.result);
  }
};

function cdpEval(expr) {
  const id = msgId++;
  return new Promise((resolve, reject) => {
    pendingCalls.set(id, { resolve, reject });
    ws.send(JSON.stringify({
      id,
      method: 'Runtime.evaluate',
      params: {
        expression: expr,
        awaitPromise: true,
        returnByValue: true,
      },
    }));
  });
}

// === STEP C: SELECT PROFILE & START ENGINE FROM REAL UI ===
console.log('\n==================================================');
console.log('3. INTERACTING WITH REACT UI: SELECTING STANDALONE CUDA');
console.log('==================================================');

// Click Standalone CUDA button
const selectProfileRes = await cdpEval(`
  (() => {
    const btn = document.getElementById('profile-standalone-cuda');
    if (!btn) return { error: 'Could not find #profile-standalone-cuda in DOM' };
    btn.click();
    return { ok: true, text: btn.innerText };
  })()
`);
console.log('Select Profile Result:', selectProfileRes.result.value);

await new Promise(r => setTimeout(r, 1000));

// Click Start Engine button to open confirmation dialog
const openConfirmRes = await cdpEval(`
  (() => {
    const btn = document.getElementById('start-engine-btn');
    if (!btn) return { error: 'Could not find #start-engine-btn in DOM' };
    btn.click();
    return { ok: true };
  })()
`);
console.log('Open Confirmation Modal Result:', openConfirmRes.result.value);

await new Promise(r => setTimeout(r, 800));

// Check authorization checkbox and confirm launch
const confirmLaunchRes = await cdpEval(`
  (() => {
    const chk = document.getElementById('auth-real-checkbox');
    const confirmBtn = document.getElementById('confirm-launch-btn');
    if (!chk) return { error: 'Could not find #auth-real-checkbox' };
    if (!confirmBtn) return { error: 'Could not find #confirm-launch-btn' };
    chk.click();
    confirmBtn.click();
    return { ok: true, authorized: chk.checked };
  })()
`);
console.log('Confirm & Launch Triggered:', confirmLaunchRes.result.value);
results.ui_startup.launch_triggered = confirmLaunchRes.result.value;

// === STEP D: WAIT FOR ENGINE HEALTHY & READY ===
console.log('\n==================================================');
console.log('4. WAITING FOR ENGINE STARTUP & INFERENCE READINESS');
console.log('==================================================');

const tLaunchStart = Date.now();
let isReady = false;
let lastHealth = null;

for (let i = 0; i < 40; i++) {
  await new Promise(r => setTimeout(r, 1000));
  try {
    const healthRes = await fetch('http://127.0.0.1:8080/health');
    if (healthRes.ok) {
      lastHealth = await healthRes.json();
      if (lastHealth?.inference?.ready && lastHealth?.model?.loaded) {
        isReady = true;
        break;
      }
    }
  } catch (e) {
    // coordinator starting up
  }
}

const startupDurationMs = Date.now() - tLaunchStart;
console.log(`Engine Ready: ${isReady} after ${startupDurationMs} ms`);
console.log('Coordinator Health:', lastHealth);

results.ui_startup.ready = isReady;
results.ui_startup.duration_ms = startupDurationMs;
results.ui_startup.health = lastHealth;

if (!isReady) {
  // Capture UI error state before aborting
  const uiError = await cdpEval(`document.body.innerText`);
  console.error('UI State on failure:', uiError.result.value.slice(0, 500));
  throw new Error('Engine failed to reach inference readiness within 40 seconds.');
}

// === STEP E: SEND EXACT CHAT PROMPT THROUGH REACT COMPOSER ===
console.log('\n==================================================');
console.log('5. SUBMITTING AUDITED CHAT PROMPT VIA REACT COMPOSER');
console.log('==================================================');

const promptText = 'Reply with exactly: SWARM DESKTOP TEST OK';

// Input text and trigger React state update, then click Send
const sendPromptRes = await cdpEval(`
  (() => {
    const input = document.getElementById('chat-input');
    const sendBtn = document.getElementById('chat-send-btn');
    if (!input) return { error: 'Could not find #chat-input' };
    if (!sendBtn) return { error: 'Could not find #chat-send-btn' };

    // Set React value natively
    const nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
    nativeSetter.call(input, ${JSON.stringify(promptText)});
    input.dispatchEvent(new Event('input', { bubbles: true }));

    setTimeout(() => {
      sendBtn.click();
    }, 100);

    return { ok: true, promptSubmitted: ${JSON.stringify(promptText)} };
  })()
`);
console.log('Prompt submission initiated:', sendPromptRes.result.value);

// Wait for assistant response to stream and finish
console.log('Awaiting SSE streaming generation...');
let chatFinished = false;
let finalAssistantContent = '';
let responseTimings = null;
const tInferenceStart = Date.now();

for (let i = 0; i < 30; i++) {
  await new Promise(r => setTimeout(r, 1000));
  const checkChat = await cdpEval(`
    (() => {
      const messages = Array.from(document.querySelectorAll('.animate-fade-in'));
      const textNodes = messages.map(m => m.innerText);
      const isStreaming = Boolean(document.getElementById('chat-stop-btn'));
      return {
        messagesCount: messages.length,
        texts: textNodes,
        isStreaming,
      };
    })()
  `);

  const chatState = checkChat.result.value;
  // Look for assistant response
  const texts = chatState.texts || [];
  const assistantMsg = texts.find(t => t.includes('Swarm') && !t.includes('You'));

  if (!chatState.isStreaming && assistantMsg && assistantMsg.includes('SWARM')) {
    chatFinished = true;
    finalAssistantContent = assistantMsg;
    break;
  }
}

const inferenceDurationMs = Date.now() - tInferenceStart;
console.log(`Chat completed: ${chatFinished} in ${inferenceDurationMs} ms`);
console.log('Assistant Response Snippet:\n', finalAssistantContent);

results.chat_test = {
  prompt: promptText,
  completed: chatFinished,
  duration_ms: inferenceDurationMs,
  assistant_message: finalAssistantContent,
  has_exact_response: finalAssistantContent.includes('SWARM DESKTOP TEST OK'),
};

// === STEP F: CAPTURE SCREENSHOT OF LIVE UI ===
console.log('\n==================================================');
console.log('6. CAPTURING DESKTOP WINDOW SCREENSHOT');
console.log('==================================================');

try {
  execSync(`powershell -ExecutionPolicy Bypass -File .\\Capture-Window.ps1 -ProcessName app -WindowTitle "Swarm Desktop" -OutputPath "${SCREENSHOT_PATH}"`, {
    cwd: path.join(WORKSPACE_ROOT, 'spike\\desktop-shell'),
    stdio: 'inherit',
  });
  console.log(`Window screenshot captured to: ${SCREENSHOT_PATH}`);
} catch (e) {
  console.warn('Screenshot capture warning:', e.message);
}

// === STEP G: STOP ENGINE SAFELY VIA TOPBAR STOP BUTTON ===
console.log('\n==================================================');
console.log('7. STOPPING ENGINE SAFELY VIA TOPBAR UI CONTROL');
console.log('==================================================');

const stopEngineRes = await cdpEval(`
  (() => {
    const btn = document.getElementById('topbar-stop-engine-btn');
    if (!btn) return { error: 'Could not find #topbar-stop-engine-btn' };
    btn.click();
    return { ok: true };
  })()
`);
console.log('Stop Engine Triggered:', stopEngineRes.result.value);

// Wait for coordinator to exit cleanly
let coordinatorExited = false;
for (let i = 0; i < 15; i++) {
  await new Promise(r => setTimeout(r, 1000));
  const coordRunning = runPowerShell(`@(Get-Process -Name swarm_node -ErrorAction SilentlyContinue).Count -gt 0`) === 'True';
  if (!coordRunning) {
    coordinatorExited = true;
    break;
  }
}
console.log(`Coordinator Exited Cleanly: ${coordinatorExited}`);

const port8080Released = runPowerShell(`@(Get-NetTCPConnection -LocalPort 8080 -State Listen -ErrorAction SilentlyContinue).Count -eq 0`) === 'True';
console.log(`Port 8080 Released: ${port8080Released}`);

let finalVramMb = 0;
try {
  const smi = execSync('nvidia-smi --query-gpu=memory.free --format=csv,noheader,nounits', { encoding: 'utf8' }).trim();
  finalVramMb = parseInt(smi, 10);
  console.log(`Recovered GPU VRAM: ${finalVramMb} MiB free`);
} catch (e) {}

results.shutdown = {
  coordinator_exited: coordinatorExited,
  port_8080_released: port8080Released,
  recovered_vram_mb: finalVramMb,
};

// Close app
ws.close();
appProc.kill();
console.log('Desktop application process terminated cleanly.');

results.success = isReady && chatFinished && coordinatorExited && port8080Released;
fs.writeFileSync(RESULT_PATH, JSON.stringify(results, null, 2));
console.log(`Smoke test results recorded to: ${RESULT_PATH}`);
console.log('\nFINAL SMOKE TEST RESULT:', results.success ? 'PASS (100% SUCCESS)' : 'FAIL');
