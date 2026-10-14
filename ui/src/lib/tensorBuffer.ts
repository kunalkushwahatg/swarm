// ─────────────────────────────────────────────
//  Tensor Buffer Composition calculation and validation
// ─────────────────────────────────────────────

export interface BufferCompositionResult {
  hasValidComponents: boolean;
  hasUnmeasured: boolean;
  modelBytes?: number;
  kvBytes?: number;
  computeBytes?: number;
  totalBytes: number;
  modelPct: number;
  kvPct: number;
  computePct: number;
  isZeroTotal: boolean;
  statusText?: string;
}

export function isValidByteCount(val: unknown): val is number {
  return typeof val === "number" && Number.isFinite(val) && val >= 0;
}

/**
 * Calculates tensor buffer composition proportions from measured component bytes.
 *
 * Formula:
 *   total = model_buffer_bytes + kv_buffer_bytes + compute_buffer_bytes
 *   proportion = measured_component / total
 *
 * Missing or unmeasured components are marked as unmeasured and omitted from total.
 * If denominator is zero, marks isZeroTotal = true.
 */
export function calculateBufferComposition(
  modelBytesRaw: unknown,
  kvBytesRaw: unknown,
  computeBytesRaw: unknown
): BufferCompositionResult {
  const modelValid = isValidByteCount(modelBytesRaw);
  const kvValid = isValidByteCount(kvBytesRaw);
  const computeValid = isValidByteCount(computeBytesRaw);

  const modelBytes = modelValid ? (modelBytesRaw as number) : undefined;
  const kvBytes = kvValid ? (kvBytesRaw as number) : undefined;
  const computeBytes = computeValid ? (computeBytesRaw as number) : undefined;

  const hasUnmeasured = !modelValid || !kvValid || !computeValid;

  const measuredComponents: number[] = [];
  if (modelValid) measuredComponents.push(modelBytes!);
  if (kvValid) measuredComponents.push(kvBytes!);
  if (computeValid) measuredComponents.push(computeBytes!);

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

  const modelPct = modelValid ? (modelBytes! / totalBytes) * 100 : 0;
  const kvPct = kvValid ? (kvBytes! / totalBytes) * 100 : 0;
  const computePct = computeValid ? (computeBytes! / totalBytes) * 100 : 0;

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
