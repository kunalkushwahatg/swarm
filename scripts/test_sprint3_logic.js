// Test suite for Sprint 3: B.4 timing validation and B.6 tensor buffer composition
import assert from "node:assert/strict";

// ─────────────────────────────────────────────────────────────
// Tensor Buffer Composition logic
// ─────────────────────────────────────────────────────────────
function isValidByteCount(val) {
  return typeof val === "number" && Number.isFinite(val) && val >= 0;
}

function calculateBufferComposition(modelBytesRaw, kvBytesRaw, computeBytesRaw) {
  const modelValid = isValidByteCount(modelBytesRaw);
  const kvValid = isValidByteCount(kvBytesRaw);
  const computeValid = isValidByteCount(computeBytesRaw);

  const modelBytes = modelValid ? modelBytesRaw : undefined;
  const kvBytes = kvValid ? kvBytesRaw : undefined;
  const computeBytes = computeValid ? computeBytesRaw : undefined;

  const hasUnmeasured = !modelValid || !kvValid || !computeValid;

  const measuredComponents = [];
  if (modelValid) measuredComponents.push(modelBytes);
  if (kvValid) measuredComponents.push(kvBytes);
  if (computeValid) measuredComponents.push(computeBytes);

  const totalBytes = measuredComponents.reduce((sum, n) => sum + n, 0);

  if (measuredComponents.length === 0) {
    return {
      hasValidComponents: false,
      hasUnmeasured: true,
      totalBytes: 0,
      modelPct: 0,
      kvPct: 0,
      computePct: 0,
      isZeroTotal: true,
      statusText: "Unmeasured",
    };
  }

  if (totalBytes === 0) {
    return {
      hasValidComponents: true,
      hasUnmeasured,
      modelBytes,
      kvBytes,
      computeBytes,
      totalBytes: 0,
      modelPct: 0,
      kvPct: 0,
      computePct: 0,
      isZeroTotal: true,
      statusText: "No tensor buffers allocated",
    };
  }

  const modelPct = modelValid ? (modelBytes / totalBytes) * 100 : 0;
  const kvPct = kvValid ? (kvBytes / totalBytes) * 100 : 0;
  const computePct = computeValid ? (computeBytes / totalBytes) * 100 : 0;

  return {
    hasValidComponents: true,
    hasUnmeasured,
    modelBytes,
    kvBytes,
    computeBytes,
    totalBytes,
    modelPct,
    kvPct,
    computePct,
    isZeroTotal: false,
  };
}

console.log("=== Testing B.6: Tensor Buffer Composition ===");

// Case 1: Standard measured values (from m12_backends.json for Host CPU)
// Model: 1695736136, KV: 69206016, Compute: 10496246
{
  const cpu = calculateBufferComposition(1695736136, 69206016, 10496246);
  assert.equal(cpu.hasValidComponents, true);
  assert.equal(cpu.hasUnmeasured, false);
  assert.equal(cpu.isZeroTotal, false);
  assert.equal(cpu.totalBytes, 1695736136 + 69206016 + 10496246);
  assert(cpu.modelPct > 95 && cpu.modelPct < 96, `Expected ~95.5%, got ${cpu.modelPct}`);
  assert(cpu.kvPct > 3.8 && cpu.kvPct < 4.0, `Expected ~3.9%, got ${cpu.kvPct}`);
  assert(cpu.computePct > 0.5 && cpu.computePct < 0.7, `Expected ~0.6%, got ${cpu.computePct}`);
  assert.equal(Math.round(cpu.modelPct + cpu.kvPct + cpu.computePct), 100);
  console.log("✔ Case 1 Passed: Standard measured values match expected percentages");
}

// Case 2: CUDA0 GPU with high compute scratch buffer
// Model: 304590356, KV: 2097152, Compute: 315359232
{
  const cuda = calculateBufferComposition(304590356, 2097152, 315359232);
  assert.equal(cuda.isZeroTotal, false);
  assert(cuda.computePct > 50 && cuda.computePct < 51, `Expected ~50.7%, got ${cuda.computePct}`);
  assert(cuda.modelPct > 48 && cuda.modelPct < 49, `Expected ~49.0%, got ${cuda.modelPct}`);
  console.log("✔ Case 2 Passed: GPU buffer proportions calculated correctly");
}

// Case 3: Zero denominator / No tensor buffers allocated
{
  const zero = calculateBufferComposition(0, 0, 0);
  assert.equal(zero.hasValidComponents, true);
  assert.equal(zero.isZeroTotal, true);
  assert.equal(zero.totalBytes, 0);
  assert.equal(zero.modelPct, 0);
  assert.equal(zero.kvPct, 0);
  assert.equal(zero.computePct, 0);
  assert.equal(zero.statusText, "No tensor buffers allocated");
  console.log("✔ Case 3 Passed: Zero denominator cleanly returns 'No tensor buffers allocated'");
}

// Case 4: Unmeasured component (e.g. compute_buffer_bytes is undefined or null)
{
  const partial = calculateBufferComposition(1000, 200, undefined);
  assert.equal(partial.hasValidComponents, true);
  assert.equal(partial.hasUnmeasured, true);
  assert.equal(partial.isZeroTotal, false);
  assert.equal(partial.totalBytes, 1200);
  assert.equal(partial.computeBytes, undefined);
  assert.equal(partial.modelPct, (1000 / 1200) * 100);
  assert.equal(partial.kvPct, (200 / 1200) * 100);
  assert.equal(partial.computePct, 0);
  console.log("✔ Case 4 Passed: Unmeasured component marked unmeasured without inventing zero");
}

// Case 5: All components unmeasured / missing
{
  const none = calculateBufferComposition(null, undefined, "invalid");
  assert.equal(none.hasValidComponents, false);
  assert.equal(none.hasUnmeasured, true);
  assert.equal(none.isZeroTotal, true);
  assert.equal(none.statusText, "Unmeasured");
  console.log("✔ Case 5 Passed: All unmeasured returns 'Unmeasured' status");
}

// ─────────────────────────────────────────────────────────────
// Generation Timings Validation logic
// ─────────────────────────────────────────────────────────────
function isValidTimingNumber(val) {
  return typeof val === "number" && Number.isFinite(val) && val >= 0;
}

function validateTimings(raw, ttfcMs) {
  if (!raw || typeof raw !== "object") return null;
  const t = raw;

  if (!isValidTimingNumber(t.tokens_generated)) {
    return null;
  }

  const tokensGenerated = Math.floor(t.tokens_generated);
  const promptEvalMs = isValidTimingNumber(t.prompt_eval_ms) ? t.prompt_eval_ms : undefined;
  const genMs = isValidTimingNumber(t.gen_ms) ? t.gen_ms : undefined;
  const totalMs = isValidTimingNumber(t.total_ms) ? t.total_ms : undefined;

  let tokensPerSec = undefined;
  if (tokensGenerated === 0) {
    tokensPerSec = undefined;
  } else if (isValidTimingNumber(t.tokens_per_sec) && t.tokens_per_sec > 0) {
    tokensPerSec = t.tokens_per_sec;
  }

  const validTtfc = isValidTimingNumber(ttfcMs) ? ttfcMs : undefined;

  return {
    tokens_generated: tokensGenerated,
    tokens_per_sec: tokensPerSec,
    prompt_eval_ms: promptEvalMs,
    gen_ms: genMs,
    total_ms: totalMs,
    ttfc_ms: validTtfc,
    completed_at: Date.now(),
  };
}

console.log("\n=== Testing B.4: Generation Timings Validation ===");

// Case 6: Authoritative terminal timings from captured Milestone 12 response
{
  const rawCaptured = {
    gen_ms: 8072.625,
    prompt_eval_ms: 6712.5476,
    tokens_generated: 26,
    tokens_per_sec: 3.220761524287329,
    total_ms: 14815.8315,
  };
  const val = validateTimings(rawCaptured, 412);
  assert(val !== null);
  assert.equal(val.tokens_generated, 26);
  assert.equal(val.tokens_per_sec, 3.220761524287329);
  assert.equal(val.prompt_eval_ms, 6712.5476);
  assert.equal(val.gen_ms, 8072.625);
  assert.equal(val.total_ms, 14815.8315);
  assert.equal(val.ttfc_ms, 412);
  console.log("✔ Case 6 Passed: Authoritative captured M12 timing event validated successfully");
}

// Case 7: Zero-token response
{
  const rawZero = {
    gen_ms: 0,
    prompt_eval_ms: 124.5,
    tokens_generated: 0,
    tokens_per_sec: 0,
    total_ms: 124.5,
  };
  const val = validateTimings(rawZero, 125);
  assert(val !== null);
  assert.equal(val.tokens_generated, 0);
  assert.equal(val.tokens_per_sec, undefined); // Suppressed to N/A for 0 tokens
  assert.equal(val.prompt_eval_ms, 124.5);
  assert.equal(val.gen_ms, 0);
  assert.equal(val.total_ms, 124.5);
  console.log("✔ Case 7 Passed: Zero-token response correctly sets tokens_per_sec to undefined (N/A)");
}

// Case 8: Malformed / non-numeric / negative values treated as unavailable
{
  const rawMalformed = {
    tokens_generated: 15,
    prompt_eval_ms: -50,
    gen_ms: "8000",
    tokens_per_sec: NaN,
    total_ms: Infinity,
  };
  const val = validateTimings(rawMalformed);
  assert(val !== null);
  assert.equal(val.tokens_generated, 15);
  assert.equal(val.prompt_eval_ms, undefined);
  assert.equal(val.gen_ms, undefined);
  assert.equal(val.tokens_per_sec, undefined);
  assert.equal(val.total_ms, undefined);
  console.log("✔ Case 8 Passed: Malformed, negative, NaN, and non-finite values treated as unavailable");
}

// Case 9: Missing or completely invalid timing payload
{
  assert.equal(validateTimings(null), null);
  assert.equal(validateTimings(undefined), null);
  assert.equal(validateTimings({ foo: "bar" }), null);
  assert.equal(validateTimings({ tokens_generated: -1 }), null);
  console.log("✔ Case 9 Passed: Completely invalid payloads return null");
}

// Case 10: Positive tokens with zero or non-positive rate treated as unavailable (N/A)
{
  const rawPositiveTokensZeroRate = {
    tokens_generated: 42,
    tokens_per_sec: 0, // Inconsistent / invalid for positive tokens
    prompt_eval_ms: 500,
    gen_ms: 1000,
    total_ms: 1500,
  };
  // Update validateTimings logic in test to match useSwarm.ts
  const val = validateTimings(rawPositiveTokensZeroRate);
  assert(val !== null);
  assert.equal(val.tokens_generated, 42);
  assert.equal(val.tokens_per_sec, undefined); // Must be suppressed to N/A!
  console.log("✔ Case 10 Passed: Positive token count with zero rate cleanly suppresses rate to undefined (N/A)");
}

console.log("\nAll 10 logic and calculation tests passed!");
