// Verification script for installed NSIS application
import { spawn } from 'child_process';
import fs from 'fs';

const installedExe = 'C:\\Users\\kunal\\AppData\\Local\\Swarm Desktop\\app.exe';
const cdpPort = 9222;

console.log(`[Verify Installed App] Launching installed executable: ${installedExe}`);

const appProc = spawn(installedExe, [], {
  cwd: 'C:\\Users\\kunal\\AppData\\Local\\Swarm Desktop',
  env: {
    ...process.env,
    WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${cdpPort}`,
  },
  stdio: ['ignore', 'pipe', 'pipe']
});

appProc.stdout.on('data', d => console.log(`[App stdout] ${d.toString().trim()}`));
appProc.stderr.on('data', d => console.log(`[App stderr] ${d.toString().trim()}`));

async function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

async function main() {
  console.log(`[Verify Installed App] Waiting for WebView2 CDP on port ${cdpPort}...`);
  let targets = [];
  for (let attempt = 0; attempt < 20; attempt++) {
    await sleep(1000);
    try {
      const res = await fetch(`http://127.0.0.1:${cdpPort}/json`);
      targets = await res.json();
      if (targets.length > 0 && targets[0].webSocketDebuggerUrl) break;
    } catch (e) {
      // Retrying
    }
  }

  const pageTarget = targets.find(t => t.type === 'page' || t.url.includes('tauri.localhost') || t.url.includes('localhost')) || targets[0];
  if (!pageTarget || !pageTarget.webSocketDebuggerUrl) {
    appProc.kill();
    throw new Error(`Could not find active WebView2 page target on port ${cdpPort}. Targets: ${JSON.stringify(targets)}`);
  }

  console.log(`[Verify Installed App] Found WebView2 target: "${pageTarget.title}" (${pageTarget.url})`);

  // Connect via WebSocket
  const ws = new WebSocket(pageTarget.webSocketDebuggerUrl);
  await new Promise(r => ws.addEventListener('open', r, { once: true }));
  console.log('[Verify Installed App] Connected to CDP WebSocket successfully');

  let idCounter = 1;
  function sendCdp(method, params = {}) {
    return new Promise(resolve => {
      const id = idCounter++;
      const handler = event => {
        const msg = JSON.parse(event.data);
        if (msg.id === id) {
          ws.removeEventListener('message', handler);
          resolve(msg.result);
        }
      };
      ws.addEventListener('message', handler);
      ws.send(JSON.stringify({ id, method, params }));
    });
  }

  await sendCdp('Runtime.enable');
  await sendCdp('Page.enable');

  // Allow React to hydrate and render fully
  await sleep(2000);

  // 1. Inspect DOM
  const domCheck = await sendCdp('Runtime.evaluate', {
    expression: `(() => {
      const root = document.getElementById('root');
      const bodyText = document.body.innerText;
      const navButtons = Array.from(document.querySelectorAll('button')).map(b => b.innerText.trim()).filter(Boolean);
      const headings = Array.from(document.querySelectorAll('h1, h2, h3, h4')).map(h => h.innerText.trim());
      return {
        rootExists: !!root,
        rootChildCount: root ? root.children.length : 0,
        title: document.title,
        headings,
        navButtons: navButtons.slice(0, 15),
        hasChat: bodyText.includes('Chat') || navButtons.some(b => b.includes('Chat')),
        hasSettings: bodyText.includes('Settings') || navButtons.some(b => b.includes('Settings')),
        hasSession: bodyText.includes('Session') || navButtons.some(b => b.includes('Session')),
        hasDevices: bodyText.includes('Devices') || navButtons.some(b => b.includes('Devices')),
        snippet: bodyText.slice(0, 400)
      };
    })()`,
    returnByValue: true
  });

  console.log('\n--- DOM EVALUATION (INSTALLED REACT FRONTEND) ---');
  console.log(JSON.stringify(domCheck.result.value, null, 2));

  // 2. Inspect IPC Runtime & Diagnostics from installed app context
  const ipcCheck = await sendCdp('Runtime.evaluate', {
    expression: `(async () => {
      try {
        if (!window.__TAURI_INTERNALS__) return { error: 'No Tauri IPC bridge' };
        const status = await window.__TAURI_INTERNALS__.invoke('supervisor_get_status');
        const profiles = await window.__TAURI_INTERNALS__.invoke('supervisor_get_available_profiles');
        const diag = await window.__TAURI_INTERNALS__.invoke('supervisor_get_diagnostics');
        return {
          supervisor_status: status ? { is_active: status.is_active, job_object: status.job_object_active, cluster_state: status.cluster_status ? status.cluster_status.state : null } : null,
          profile_count: profiles ? profiles.profiles.length : 0,
          coord_executable: diag ? diag.coordinator_executable : null,
          rpc_executable: diag ? diag.rpc_executable : null,
          model_file: diag ? diag.model_file : null,
          dll_directories: diag ? diag.dll_directories : null
        };
      } catch (err) {
        return { error: err.toString() };
      }
    })()`,
    awaitPromise: true,
    returnByValue: true
  });

  console.log('\n--- IPC RUNTIME & MODEL DISCOVERY (INSTALLED BACKEND) ---');
  console.log(JSON.stringify(ipcCheck.result.value, null, 2));

  // 3. Capture screenshot of installed UI
  const screenshotRes = await sendCdp('Page.captureScreenshot', { format: 'png' });
  if (screenshotRes && screenshotRes.data) {
    const screenshotPath = 'C:\\Users\\kunal\\OneDrive\\Desktop\\swarm\\artifacts\\spike_screenshots\\installed_nsis_app_ui.png';
    fs.writeFileSync(screenshotPath, Buffer.from(screenshotRes.data, 'base64'));
    console.log(`\n[Verify Installed App] Screenshot saved: ${screenshotPath}`);
  }

  // 4. Clean exit without starting engine or performing inference
  console.log('\n[Verify Installed App] Closing installed application cleanly (zero engine startup, zero inference)...');
  ws.close();
  appProc.kill('SIGTERM');
  await sleep(1500);
  try {
    process.kill(appProc.pid, 'SIGKILL');
  } catch {}

  const domOk = domCheck.result.value.rootExists && domCheck.result.value.hasChat;
  const ipcOk = ipcCheck.result.value.coord_executable && ipcCheck.result.value.coord_executable.exists;
  const passed = domOk && ipcOk;

  console.log(`\n==================================================`);
  console.log(`INSTALLED APP VERIFICATION: ${passed ? 'SUCCESS (PASS)' : 'FAILED'}`);
  console.log(`==================================================`);

  // Write verification result to JSON
  fs.writeFileSync('installed_verification_result.json', JSON.stringify({
    timestamp: new Date().toISOString(),
    installed_exe: installedExe,
    dom: domCheck.result.value,
    ipc: ipcCheck.result.value,
    passed
  }, null, 2));

  process.exit(passed ? 0 : 1);
}

main().catch(e => {
  console.error('[Verify Installed App] Error:', e);
  appProc.kill('SIGTERM');
  process.exit(1);
});
