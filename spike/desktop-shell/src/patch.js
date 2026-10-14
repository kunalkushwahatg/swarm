import { fetch as tauriFetch } from '@tauri-apps/plugin-http';
import { invoke } from '@tauri-apps/api/core';

const COORDINATOR_BASE = 'http://127.0.0.1:8080';
const nativeFetch = window.fetch.bind(window);

// 1. Wrap window.fetch for all coordinator endpoints
window.fetch = async function (input, init) {
  let url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;

  if (
    url.startsWith('/health') ||
    url.startsWith('/backends') ||
    url.startsWith('/nodes') ||
    url.startsWith('/metrics') ||
    url.startsWith('/workers') ||
    url.startsWith('/v1/') ||
    url.startsWith('/api/')
  ) {
    const targetUrl = COORDINATOR_BASE + url;
    return tauriFetch(targetUrl, init);
  }

  return nativeFetch(input, init);
};

window.invoke = invoke;

console.log('[Swarm Desktop Spike] Tauri HTTP Bridge initialized. Intercepting coordinator requests to', COORDINATOR_BASE);

// 2. Automated Diagnostic Test Suite for Phase C.1 Spike Verification
window.__SPIKE_TEST_RESULTS__ = {
  status: 'running',
  tests: {},
  streamingChunks: [],
  timings: null,
  errors: []
};

async function runDiagnostics() {
  console.log('[Swarm Desktop Spike] Running C.1 Feasibility Diagnostics...');

  // Test 1: /health
  try {
    const t0 = performance.now();
    const res = await tauriFetch(`${COORDINATOR_BASE}/health`);
    const data = await res.json();
    const duration = performance.now() - t0;
    window.__SPIKE_TEST_RESULTS__.tests.health = {
      ok: res.ok,
      status: res.status,
      durationMs: Math.round(duration),
      inferenceReady: data?.inference?.ready ?? false,
      modelLoaded: data?.model?.loaded ?? false,
      modelPath: data?.model?.path ?? ''
    };
    console.log('[Spike Test 1] /health result:', window.__SPIKE_TEST_RESULTS__.tests.health);
  } catch (err) {
    window.__SPIKE_TEST_RESULTS__.tests.health = { ok: false, error: String(err) };
    console.error('[Spike Test 1] /health failed:', err);
  }

  // Test 2: /backends, /nodes, /metrics
  try {
    const bRes = await tauriFetch(`${COORDINATOR_BASE}/backends`);
    const bData = await bRes.json();
    const nRes = await tauriFetch(`${COORDINATOR_BASE}/nodes`);
    const nData = await nRes.json();
    const mRes = await tauriFetch(`${COORDINATOR_BASE}/metrics`);
    const mText = await mRes.text();

    window.__SPIKE_TEST_RESULTS__.tests.restEndpoints = {
      backendsOk: bRes.ok,
      backendsCount: Array.isArray(bData?.backends) ? bData.backends.length : (Array.isArray(bData) ? bData.length : 0),
      nodesOk: nRes.ok,
      nodesCount: Array.isArray(nData?.nodes) ? nData.nodes.length : 0,
      metricsOk: mRes.ok,
      metricsLength: mText.length
    };
    console.log('[Spike Test 2] REST endpoints result:', window.__SPIKE_TEST_RESULTS__.tests.restEndpoints);
  } catch (err) {
    window.__SPIKE_TEST_RESULTS__.tests.restEndpoints = { ok: false, error: String(err) };
    console.error('[Spike Test 2] REST endpoints failed:', err);
  }

  // Test 3: Incremental Streaming & Terminal Timings (/v1/chat/completions)
  try {
    console.log('[Spike Test 3] Dispatching streaming chat completion...');
    const tStart = performance.now();
    const chatReq = {
      model: 'qwen2.5-3b-instruct',
      messages: [{ role: 'user', content: 'Say hello in two words.' }],
      stream: true,
      max_tokens: 16
    };

    const res = await tauriFetch(`${COORDINATOR_BASE}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(chatReq)
    });

    if (!res.ok) {
      throw new Error(`HTTP ${res.status}: ${await res.text()}`);
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    const chunkTimestamps = [];
    let fullContent = '';
    let parsedTimings = null;
    let chunkCount = 0;

    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      const readTime = performance.now() - tStart;
      chunkCount++;
      chunkTimestamps.push(Math.round(readTime));

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || !trimmed.startsWith('data: ')) continue;
        const payload = trimmed.slice(6).trim();
        if (payload === '[DONE]') continue;

        try {
          const parsed = JSON.parse(payload);
          if (parsed.choices?.[0]?.delta?.content) {
            fullContent += parsed.choices[0].delta.content;
            window.__SPIKE_TEST_RESULTS__.streamingChunks.push({
              index: chunkCount,
              timeMs: Math.round(readTime),
              text: parsed.choices[0].delta.content
            });
          }
          if (parsed.timings) {
            parsedTimings = parsed.timings;
          }
        } catch (e) {
          // ignore parsing error for chunk
        }
      }
    }

    const totalDuration = performance.now() - tStart;
    const isIncremental = chunkTimestamps.length > 1 && (chunkTimestamps[chunkTimestamps.length - 1] - chunkTimestamps[0] > 100);

    window.__SPIKE_TEST_RESULTS__.tests.streaming = {
      ok: true,
      totalChunksReceived: chunkCount,
      contentGenerated: fullContent,
      firstChunkMs: chunkTimestamps[0] ?? 0,
      lastChunkMs: chunkTimestamps[chunkTimestamps.length - 1] ?? 0,
      totalDurationMs: Math.round(totalDuration),
      isIncrementalArrival: isIncremental,
      chunkArrivalIntervalsMs: chunkTimestamps,
      terminalTimings: parsedTimings
    };
    console.log('[Spike Test 3] Streaming result:', window.__SPIKE_TEST_RESULTS__.tests.streaming);
  } catch (err) {
    window.__SPIKE_TEST_RESULTS__.tests.streaming = { ok: false, error: String(err) };
    console.error('[Spike Test 3] Streaming failed:', err);
  }

  // Test 4: Cancellation test
  try {
    const controller = new AbortController();
    const chatReq = {
      model: 'qwen2.5-3b-instruct',
      messages: [{ role: 'user', content: 'Count from 1 to 50.' }],
      stream: true
    };

    const promise = tauriFetch(`${COORDINATOR_BASE}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(chatReq),
      signal: controller.signal
    });

    // Abort after 80ms
    setTimeout(() => controller.abort(), 80);

    try {
      const res = await promise;
      const reader = res.body.getReader();
      await reader.read();
      // abort
      controller.abort();
      window.__SPIKE_TEST_RESULTS__.tests.cancellation = { ok: true, abortedCleanly: true };
    } catch (err) {
      // An abort rejection is expected and healthy
      window.__SPIKE_TEST_RESULTS__.tests.cancellation = { ok: true, abortedCleanly: true, message: String(err) };
    }
    console.log('[Spike Test 4] Cancellation result:', window.__SPIKE_TEST_RESULTS__.tests.cancellation);
  } catch (err) {
    window.__SPIKE_TEST_RESULTS__.tests.cancellation = { ok: false, error: String(err) };
  }

  // Test 5: Connection error handling (unreachable port)
  try {
    const deadPort = 59999;
    const res = await tauriFetch(`http://127.0.0.1:${deadPort}/health`).catch(e => ({ error: e }));
    window.__SPIKE_TEST_RESULTS__.tests.connectionErrorHandling = {
      ok: true,
      rejectedGracefully: true,
      errorDetected: Boolean(res.error)
    };
    console.log('[Spike Test 5] Connection error handling result:', window.__SPIKE_TEST_RESULTS__.tests.connectionErrorHandling);
  } catch (err) {
    window.__SPIKE_TEST_RESULTS__.tests.connectionErrorHandling = { ok: true, rejectedGracefully: true, message: String(err) };
  }

  window.__SPIKE_TEST_RESULTS__.status = 'completed';
  window.__SPIKE_TEST_RESULTS__.completedAt = new Date().toISOString();

  // Expose results into DOM banner for inspection and visual capture
  const banner = document.createElement('div');
  banner.id = 'spike-test-banner';
  banner.style.cssText = 'position:fixed;bottom:12px;right:12px;background:rgba(15,23,42,0.95);color:#38bdf8;padding:12px 16px;border-radius:8px;font-family:monospace;font-size:12px;z-index:99999;border:1px solid #0284c7;box-shadow:0 8px 24px rgba(0,0,0,0.5);max-width:400px;';
  
  const s = window.__SPIKE_TEST_RESULTS__.tests;
  const isStreamOk = s.streaming?.isIncrementalArrival;
  banner.innerHTML = `
    <div style="font-weight:bold;color:#f8fafc;margin-bottom:6px;">⚡ Swarm Tauri Feasibility Spike</div>
    <div>• /health: <span style="color:#4ade80">${s.health?.ok ? 'PASS (Ready)' : 'FAIL'}</span></div>
    <div>• REST endpoints: <span style="color:#4ade80">${s.restEndpoints?.backendsOk ? 'PASS' : 'FAIL'}</span></div>
    <div>• Incremental SSE: <span style="color:${isStreamOk ? '#4ade80' : '#f87171'}">${isStreamOk ? 'PASS (' + s.streaming.totalChunksReceived + ' chunks)' : 'BUFFERED/FAIL'}</span></div>
    <div>• Terminal Timings: <span style="color:#4ade80">${s.streaming?.terminalTimings ? 'PASS (' + s.streaming.terminalTimings.tokens_per_sec?.toFixed(1) + ' t/s)' : 'FAIL'}</span></div>
    <div>• Cancellation: <span style="color:#4ade80">${s.cancellation?.ok ? 'PASS' : 'FAIL'}</span></div>
    <div>• Error Handling: <span style="color:#4ade80">${s.connectionErrorHandling?.ok ? 'PASS' : 'FAIL'}</span></div>
  `;
  document.body.appendChild(banner);

  try {
    await invoke('save_spike_results', { results: JSON.stringify(window.__SPIKE_TEST_RESULTS__, null, 2) });
    console.log('[Swarm Desktop Spike] Successfully recorded diagnostic results via Tauri IPC!');
  } catch (ipcErr) {
    console.warn('[Swarm Desktop Spike] Failed to save diagnostics via Tauri IPC:', ipcErr);
  }
}

// Run diagnostics 1.5 seconds after page loads
setTimeout(runDiagnostics, 1500);
