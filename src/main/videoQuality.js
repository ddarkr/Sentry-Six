'use strict';

const fs = require('fs');
const path = require('path');

// Conservative, manual adjustments only. No scene inference or Tesla-specific LUT.
// These limits are also enforced in the main process, not just the export form.
const LIMITS = Object.freeze({
  brightness: [-0.08, 0.08, 0],
  gamma: [0.8, 1.2, 1],
  contrast: [0.85, 1.15, 1],
  saturation: [0.8, 1.2, 1],
  red: [-0.08, 0.08, 0],
  green: [-0.08, 0.08, 0],
  blue: [-0.08, 0.08, 0],
  denoise: [0, 1, 0],
  sharpen: [0, 0.3, 0]
});

function normalizeQualityAdjustment(input) {
  const source = input && typeof input === 'object' ? input : {};
  const result = { enabled: source.enabled === true };
  for (const [name, [min, max, fallback]] of Object.entries(LIMITS)) {
    const value = source[name];
    result[name] = typeof value === 'number' && Number.isFinite(value)
      ? Math.round(Math.max(min, Math.min(max, value)) * 1000) / 1000
      : fallback;
  }
  return result;
}

function buildQualityFilter(input) {
  const q = normalizeQualityAdjustment(input);
  if (!q.enabled) return '';
  const filters = [];
  // Numeric serialization only: never accept arbitrary filter expressions from IPC.
  if (q.brightness !== 0 || q.gamma !== 1 || q.contrast !== 1 || q.saturation !== 1) {
    filters.push(`eq=brightness=${q.brightness}:gamma=${q.gamma}:contrast=${q.contrast}:saturation=${q.saturation}`);
  }
  if (q.red !== 0 || q.green !== 0 || q.blue !== 0) {
    filters.push(`colorbalance=rm=${q.red}:gm=${q.green}:bm=${q.blue}:pl=1`);
  }
  if (q.denoise > 0) {
    // Mild spatial/temporal denoise can remove real detail; opt-in and bounded.
    const n = value => Number(value.toFixed(3));
    filters.push(`hqdn3d=${q.denoise}:${n(q.denoise * 0.75)}:${n(q.denoise * 1.5)}:${n(q.denoise * 1.125)}`);
  }
  if (q.sharpen > 0) filters.push(`unsharp=3:3:${q.sharpen}:3:3:0`);
  return filters.join(',');
}

function assertOutputIsNotSource(segments, outputPath) {
  if (typeof outputPath !== 'string' || !outputPath) throw new Error('Choose an export output file.');
  const canonical = file => {
    try { return fs.realpathSync(file); } catch { return path.resolve(file); }
  };
  const output = canonical(outputPath);
  let outputStat;
  try { outputStat = fs.statSync(outputPath); } catch { /* New destination. */ }
  for (const segment of segments || []) {
    for (const file of Object.values(segment.files || {})) {
      if (typeof file !== 'string') continue;
      let sameFile = canonical(file) === output;
      if (!sameFile && outputStat) {
        try {
          const sourceStat = fs.statSync(file);
          sameFile = sourceStat.dev === outputStat.dev && sourceStat.ino === outputStat.ino;
        } catch { /* Missing sources are handled by the exporter. */ }
      }
      if (sameFile) throw new Error('Choose a new output file. Original camera recordings cannot be overwritten.');
    }
  }
}

module.exports = { LIMITS, normalizeQualityAdjustment, buildQualityFilter, assertOutputIsNotSource };
