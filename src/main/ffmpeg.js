const { app } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawn } = require('child_process');

// Cached GPU encoder detection
let gpuEncoder = undefined; // undefined = not checked, null = checked but none usable
let gpuEncoderHEVC = undefined; // undefined = not checked, null = checked but none usable
let cachedGpuHardware = undefined; // undefined = not checked, null = checked but not found
let cachedFFmpegPath = undefined; // undefined = not checked, null = checked but not found
let pathProbe;
let hardwareProbe;
let gpuProbe;
let hevcProbe;

// Collect both pipes and settle once, including failed starts and hung probes.
function runProbe(executable, args, { timeout = 5000 } = {}) {
  return new Promise((resolve) => {
    let child;
    let timer;
    let stdout = '';
    let stderr = '';
    let settled = false;
    const onStdout = data => { stdout += data.toString(); };
    const onStderr = data => { stderr += data.toString(); };
    const finish = (status, error = null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child?.stdout?.removeListener('data', onStdout);
      child?.stderr?.removeListener('data', onStderr);
      child?.removeListener('error', onError);
      child?.removeListener('close', onClose);
      resolve({ status, stdout, stderr, error });
    };
    const onError = error => finish(null, error);
    const onClose = code => finish(code);
    try {
      child = spawn(executable, args, { windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
      child.stdout?.on('data', onStdout);
      child.stderr?.on('data', onStderr);
      child.once('error', onError);
      child.once('close', onClose);
      timer = setTimeout(() => {
        try { child.kill('SIGKILL'); } catch {}
        finish(null, new Error('Probe timed out'));
      }, timeout);
    } catch (error) {
      finish(null, error);
    }
  });
}

/**
 * Ensures macOS/Linux FFmpeg binaries are executable.
 * Called before attempting to run FFmpeg to handle fresh installs or builds.
 */
function ensureExecutable(filePath) {
  if (process.platform === 'win32') return; // Windows doesn't need chmod
  
  try {
    if (fs.existsSync(filePath)) {
      const stats = fs.statSync(filePath);
      // Check if executable bit is set (owner execute = 0o100)
      if ((stats.mode & 0o100) === 0) {
        console.log(`[CHMOD] Making executable: ${filePath}`);
        fs.chmodSync(filePath, 0o755);
      }
    }
  } catch (err) {
    console.warn(`[CHMOD] Could not set executable permission on ${filePath}: ${err.message}`);
  }
}

/**
 * Build the platform-specific ordered list of paths to check for ffmpeg.
 */
function buildFFmpegCandidatePaths() {
  const isMac = process.platform === 'darwin';
  const isWin = process.platform === 'win32';
  const paths = [];

  if (isMac) {
    if (app.isPackaged) {
      paths.push(path.join(process.resourcesPath, 'ffmpeg_bin', 'ffmpeg'));
    }
    paths.push(
      path.join(app.getAppPath(), 'ffmpeg_bin', 'macos', process.arch, 'ffmpeg'),
      path.join(__dirname, '..', 'ffmpeg_bin', 'ffmpeg'),
      path.join(__dirname, 'ffmpeg_bin', 'ffmpeg'),
      path.join(process.cwd(), 'ffmpeg_bin', 'ffmpeg'),
      path.join(app.getAppPath(), 'ffmpeg_bin', 'ffmpeg'),
      path.join(app.getAppPath(), '..', 'ffmpeg_bin', 'ffmpeg'),
      '/opt/homebrew/bin/ffmpeg',
      '/usr/local/bin/ffmpeg',
      '/opt/local/bin/ffmpeg',
      '/usr/bin/ffmpeg',
      path.join(os.homedir(), '.local', 'bin', 'ffmpeg'),
      path.join(os.homedir(), 'bin', 'ffmpeg')
    );
  } else if (isWin) {
    if (app.isPackaged) {
      paths.push(path.join(process.resourcesPath, 'ffmpeg_bin', 'ffmpeg.exe'));
    }
    paths.push(
      path.join(__dirname, '..', 'ffmpeg_bin', 'ffmpeg.exe'),
      path.join(__dirname, 'ffmpeg_bin', 'ffmpeg.exe'),
      path.join(process.cwd(), 'ffmpeg_bin', 'ffmpeg.exe'),
      path.join(app.getAppPath(), 'ffmpeg_bin', 'ffmpeg.exe'),
      path.join(app.getAppPath(), '..', 'ffmpeg_bin', 'ffmpeg.exe')
    );
  } else {
    paths.push(
      path.join(__dirname, '..', 'ffmpeg_bin', 'ffmpeg'),
      path.join(__dirname, 'ffmpeg_bin', 'ffmpeg'),
      path.join(process.cwd(), 'ffmpeg_bin', 'ffmpeg'),
      '/usr/bin/ffmpeg',
      '/usr/local/bin/ffmpeg'
    );
  }

  paths.push('ffmpeg');
  return paths;
}

function findFFmpegPath() {
  if (cachedFFmpegPath !== undefined) return Promise.resolve(cachedFFmpegPath);
  if (pathProbe) return pathProbe;
  const paths = buildFFmpegCandidatePaths();
  pathProbe = (async () => {
    for (const p of paths) {
      try {
        const exists = p === 'ffmpeg' || fs.existsSync(p);
        console.log(`  Checking ${p}: exists=${exists}`);
        if (!exists) continue;

        if (p !== 'ffmpeg' && !p.startsWith('/opt') && !p.startsWith('/usr')) {
          ensureExecutable(p);
        }

        const result = await runProbe(p, ['-version']);
        const ok = result.status === 0;

        if (ok) {
          console.log(`[OK] Found FFmpeg at: ${p}`);
          cachedFFmpegPath = p;
          return p;
        }
      } catch (err) {
        console.log(`  Error checking ${p}: ${err.message}`);
      }
    }

    console.warn('[ERROR] FFmpeg not found in any of the checked paths');
    cachedFFmpegPath = null;
    return null;
  })().finally(() => { pathProbe = undefined; });
  return pathProbe;
}

/**
 * Pre-cache FFmpeg path at startup in the background. Uses async spawn so the
 * main-process event loop never blocks — IPC from the renderer keeps flowing.
 */
async function preCacheFFmpegPath() {
  if (cachedFFmpegPath !== undefined) return; // Already cached
  console.log('[STARTUP] Pre-caching FFmpeg path...');
  const result = await findFFmpegPath();
  console.log(`[STARTUP] FFmpeg pre-cache complete: ${result ? 'found' : 'not found'}`);
}

/**
 * Format milliseconds into a human-readable time string (Xh Xm Xs format)
 * @param {number} ms - Milliseconds
 * @returns {string} Formatted time string
 */
function formatExportDuration(ms) {
  const totalSeconds = Math.floor(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  
  if (hours > 0) {
    return `${hours}h ${minutes}m ${seconds}s`;
  } else if (minutes > 0) {
    return `${minutes}m ${seconds}s`;
  } else {
    return `${seconds}s`;
  }
}

/**
 * Detect actual GPU hardware model name (e.g., "NVIDIA GeForce RTX 4070 Super")
 * This is separate from encoder detection - shows the actual hardware.
 */
function detectGpuHardware() {
  if (cachedGpuHardware !== undefined) return Promise.resolve(cachedGpuHardware);
  if (!hardwareProbe) hardwareProbe = probeGpuHardware().finally(() => { hardwareProbe = undefined; });
  return hardwareProbe;
}

async function probeGpuHardware() {
  
  try {
    if (process.platform === 'win32') {
      // Windows: Use wmic to get GPU name
      const result = await runProbe('wmic', ['path', 'win32_VideoController', 'get', 'name']);
      const output = result.stdout?.toString() || '';
      const lines = output.split('\n').map(l => l.trim()).filter(l => l && l !== 'Name');
      if (lines.length > 0) {
        // Filter out basic display adapters, prefer dedicated GPUs
        const dedicated = lines.find(l => 
          l.includes('NVIDIA') || l.includes('AMD') || l.includes('Radeon') || l.includes('GeForce')
        );
        cachedGpuHardware = dedicated || lines[0];
        console.log(`[GPU] Hardware detected: ${cachedGpuHardware}`);
        return cachedGpuHardware;
      }
    } else if (process.platform === 'darwin') {
      // macOS: Use system_profiler
      const result = await runProbe('system_profiler', ['SPDisplaysDataType']);
      const output = result.stdout?.toString() || '';
      const chipMatch = output.match(/Chipset Model:\s*(.+)/i) || output.match(/Chip:\s*(.+)/i);
      if (chipMatch) {
        cachedGpuHardware = chipMatch[1].trim();
        console.log(`[GPU] Hardware detected: ${cachedGpuHardware}`);
        return cachedGpuHardware;
      }
    } else {
      // Linux: Use lspci
      const result = await runProbe('lspci', ['-v']);
      const output = result.stdout?.toString() || '';
      const vgaMatch = output.match(/VGA compatible controller:\s*(.+)/i);
      if (vgaMatch) {
        cachedGpuHardware = vgaMatch[1].trim().split('(')[0].trim();
        console.log(`[GPU] Hardware detected: ${cachedGpuHardware}`);
        return cachedGpuHardware;
      }
    }
  } catch (err) {
    console.log('[GPU] Could not detect hardware:', err.message);
  }
  
  cachedGpuHardware = null;
  return null;
}

/**
 * Finds the first available VAAPI render node on Linux (e.g. /dev/dri/renderD128).
 * Returns null if not on Linux or no render node exists.
 */
function findVaapiDevice() {
  if (process.platform !== 'linux') return null;
  try {
    const entries = fs.readdirSync('/dev/dri');
    const render = entries.find((n) => n.startsWith('renderD'));
    return render ? `/dev/dri/${render}` : null;
  } catch {
    return null;
  }
}

/**
 * Tests if a GPU encoder can actually access hardware.
 * FFmpeg may list encoders that aren't usable (e.g., NVENC listed but no NVIDIA GPU).
 * Uses a strict test: only returns true if the encoder actually works (status === 0).
 */
async function testEncoderCapability(ffmpegPath, codec) {
  try {
    // Verify encoder exists in FFmpeg build
    const helpResult = await runProbe(ffmpegPath, ['-hide_banner', '-h', `encoder=${codec}`], { timeout: 2000 });
    if (helpResult.status !== 0) return false;
    
    const helpOutput = (helpResult.stdout?.toString() || '') + (helpResult.stderr?.toString() || '');
    
    if (helpOutput.includes('Unknown encoder') || 
        helpOutput.includes('No such encoder') ||
        helpOutput.includes('not found')) {
      return false;
    }
    
    // Test encoder with realistic test input
    // HEVC VideoToolbox needs larger resolution and specific settings
    const isHEVC = codec.includes('hevc');
    const testSize = isHEVC ? '640x480' : '320x240';
    let testArgs = ['-hide_banner', '-f', 'lavfi', '-i', `testsrc2=duration=1:size=${testSize}:rate=1`];

    // VAAPI needs the hardware device declared before inputs and a hwupload filter
    if (codec.includes('vaapi')) {
      const dev = findVaapiDevice();
      if (!dev) return false;
      testArgs.unshift('-vaapi_device', dev);
      testArgs.push('-vf', 'format=nv12,hwupload');
    }

    // Add encoder-specific settings
    if (codec.includes('videotoolbox')) {
      testArgs.push('-b:v', isHEVC ? '5M' : '2M');
      if (isHEVC) {
        testArgs.push('-allow_sw', '1'); // Allow software fallback for HEVC test
      }
    }
    
    testArgs.push('-c:v', codec, '-frames:v', '1', '-f', 'null', '-');
    
    const testResult = await runProbe(ffmpegPath, testArgs);
    
    const testOutput = (testResult.stdout?.toString() || '') + (testResult.stderr?.toString() || '');
    
    // Log test output for debugging
    if (testOutput.length > 0) {
      const shortOutput = testOutput.split('\n').slice(0, 3).join(' ').substring(0, 150);
      console.log(`  ${codec} test: status=${testResult.status}, output: ${shortOutput}...`);
    }
    
    // Check for definitive hardware errors
    const fatalErrors = [
      'No such device',
      'Could not open encoder',
      'Failed to create encoder',
      'Cannot load',
      'Device creation failed',
      'No capable devices found',
      'No device available',
      'No hardware device found',
      'Task finished with error',
      'Invalid argument'
    ];
    
    for (const error of fatalErrors) {
      if (testOutput.toLowerCase().includes(error.toLowerCase())) {
        console.log(`  ${codec}: Fatal error - ${error}`);
        return false;
      }
    }
    
    // STRICT: Only return true if the test actually succeeded (status === 0)
    return testResult.status === 0;
  } catch (err) {
    console.log(`  ${codec}: Exception - ${err.message}`);
    return false;
  }
}

function detectGpuEncoder(ffmpegPath) {
  if (gpuEncoder !== undefined) return Promise.resolve(gpuEncoder);
  if (!gpuProbe) gpuProbe = probeGpuEncoder(ffmpegPath).finally(() => { gpuProbe = undefined; });
  return gpuProbe;
}

async function probeGpuEncoder(ffmpegPath) {
  
  try {
    // Query FFmpeg for available encoders
    const encoderResult = await runProbe(ffmpegPath, ['-encoders']);
    const encoderOutput = encoderResult.stdout?.toString() || '';
    
    // Define encoder priority by platform
    // Test all encoders in order and use the first one that actually works
    const encodersToCheck = [];
    
    if (process.platform === 'darwin') {
      encodersToCheck.push({ codec: 'h264_videotoolbox', name: 'Apple VideoToolbox', priority: 1 });
    } else if (process.platform === 'win32') {
      encodersToCheck.push(
        { codec: 'h264_nvenc', name: 'NVIDIA NVENC', priority: 1 },
        { codec: 'h264_amf', name: 'AMD AMF', priority: 2 },
        { codec: 'h264_qsv', name: 'Intel QuickSync', priority: 3 }
      );
    } else {
      // Linux: VAAPI is the common path for both AMD and Intel integrated GPUs.
      encodersToCheck.push(
        { codec: 'h264_nvenc', name: 'NVIDIA NVENC', priority: 1 },
        { codec: 'h264_vaapi', name: 'VAAPI (AMD/Intel)', priority: 2 },
        { codec: 'h264_amf', name: 'AMD AMF', priority: 3 },
        { codec: 'h264_qsv', name: 'Intel QuickSync', priority: 4 }
      );
    }
    
    encodersToCheck.sort((a, b) => (a.priority || 999) - (b.priority || 999));
    
    // Test each encoder in priority order, return first working one
    for (const encoder of encodersToCheck) {
      if (encoderOutput.includes(encoder.codec)) {
        console.log(`[TEST] Testing ${encoder.name} (${encoder.codec})...`);
        if (await testEncoderCapability(ffmpegPath, encoder.codec)) {
          gpuEncoder = encoder;
          console.log(`[GPU] GPU encoder available: ${gpuEncoder.name}`);
          return gpuEncoder;
        } else {
          console.log(`[WARN] ${encoder.codec} is listed but not usable (no hardware available)`);
        }
      }
    }
    
    gpuEncoder = null;
    console.log('[INFO] No usable GPU encoder found, will use CPU encoding');
  } catch (err) {
    console.error('Error detecting GPU encoder:', err.message);
    gpuEncoder = null;
  }
  return gpuEncoder;
}

/**
 * Detects HEVC (H.265) GPU encoders for higher resolution support.
 * HEVC encoders support up to 8192px (vs H.264's 4096px limit).
 * Used when H.264 GPU encoding would exceed resolution limits.
 */
function detectHEVCEncoder(ffmpegPath) {
  if (gpuEncoderHEVC !== undefined) return Promise.resolve(gpuEncoderHEVC);
  if (!hevcProbe) hevcProbe = probeHEVCEncoder(ffmpegPath).finally(() => { hevcProbe = undefined; });
  return hevcProbe;
}

async function probeHEVCEncoder(ffmpegPath) {
  
  try {
    // Query FFmpeg for available encoders
    const encoderResult = await runProbe(ffmpegPath, ['-encoders']);
    const encoderOutput = encoderResult.stdout?.toString() || '';
    
    // HEVC encoders by platform
    const hevcEncoders = [];
    if (process.platform === 'darwin') {
      hevcEncoders.push({ codec: 'hevc_videotoolbox', name: 'Apple VideoToolbox HEVC', maxRes: 8192, priority: 1 });
    } else if (process.platform === 'win32') {
      hevcEncoders.push(
        { codec: 'hevc_nvenc', name: 'NVIDIA NVENC HEVC', maxRes: 8192, priority: 1 },
        { codec: 'hevc_amf', name: 'AMD AMF HEVC', maxRes: 8192, priority: 2 },
        { codec: 'hevc_qsv', name: 'Intel QuickSync HEVC', maxRes: 8192, priority: 3 }
      );
      hevcEncoders.sort((a, b) => (a.priority || 999) - (b.priority || 999));
    } else {
      // Linux: VAAPI covers both AMD and Intel integrated HEVC.
      hevcEncoders.push(
        { codec: 'hevc_nvenc', name: 'NVIDIA NVENC HEVC', maxRes: 8192, priority: 1 },
        { codec: 'hevc_vaapi', name: 'VAAPI HEVC (AMD/Intel)', maxRes: 8192, priority: 2 },
        { codec: 'hevc_amf', name: 'AMD AMF HEVC', maxRes: 8192, priority: 3 },
        { codec: 'hevc_qsv', name: 'Intel QuickSync HEVC', maxRes: 8192, priority: 4 }
      );
      hevcEncoders.sort((a, b) => (a.priority || 999) - (b.priority || 999));
    }
    
    console.log('[HEVC] Checking for HEVC GPU encoders...');
    for (const encoder of hevcEncoders) {
      if (encoderOutput.includes(encoder.codec)) {
        console.log(`[TEST] Testing HEVC encoder ${encoder.name} (${encoder.codec})...`);
        if (await testEncoderCapability(ffmpegPath, encoder.codec)) {
          gpuEncoderHEVC = encoder;
          console.log(`[GPU] HEVC encoder available: ${gpuEncoderHEVC.name}`);
          return gpuEncoderHEVC;
        } else {
          console.log(`[WARN] ${encoder.codec} listed but not usable`);
        }
      } else {
        console.log(`[INFO] ${encoder.codec} not found in FFmpeg encoders list`);
      }
    }
    
    gpuEncoderHEVC = null;
    console.log('[INFO] No usable HEVC GPU encoder found');
  } catch (err) {
    console.error('Error detecting HEVC encoder:', err.message);
    gpuEncoderHEVC = null;
  }
  return gpuEncoderHEVC;
}

// Getters/setters for mutable encoder state (used by video export and diagnostics)
function getGpuEncoder() { return gpuEncoder; }
function setGpuEncoder(val) { gpuEncoder = val; }
function getGpuEncoderHEVC() { return gpuEncoderHEVC; }
function setGpuEncoderHEVC(val) { gpuEncoderHEVC = val; }

module.exports = {
  runProbe,
  findFFmpegPath,
  preCacheFFmpegPath,
  formatExportDuration,
  detectGpuHardware,
  detectGpuEncoder,
  detectHEVCEncoder,
  findVaapiDevice,
  getGpuEncoder,
  setGpuEncoder,
  getGpuEncoderHEVC,
  setGpuEncoderHEVC
};
