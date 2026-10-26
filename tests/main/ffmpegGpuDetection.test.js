const { EventEmitter } = require('events');
jest.mock('child_process');
jest.mock('electron');

function load(output = '', status = 0) {
  jest.resetModules();
  const cp = require('child_process');
  cp.spawn.mockReset();
  const children = [];
  cp.spawn.mockImplementation(() => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = jest.fn();
    children.push(child);
    setImmediate(() => {
      child.stdout.emit('data', Buffer.from(output));
      child.emit('close', status);
    });
    return child;
  });
  return { ffmpeg: require('../../src/main/ffmpeg'), spawn: cp.spawn, children };
}

for (const [method, prefix] of [['detectGpuEncoder', 'h264'], ['detectHEVCEncoder', 'hevc']]) {
  describe(method, () => {
    test.each([false, true])('coalesces concurrent work and caches usable=%s', async usable => {
      const codec = `${prefix}_${process.platform === 'darwin' ? 'videotoolbox' : 'nvenc'}`;
      const { ffmpeg, spawn } = load(usable ? `V..... ${codec}` : 'libx264');
      const first = ffmpeg[method]('/a path/ffmpeg');
      expect(ffmpeg[method]('/a path/ffmpeg')).toBe(first);
      const result = await first;
      if (usable) expect(result.codec).toBe(codec);
      else expect(result).toBeNull();
      const count = spawn.mock.calls.length;
      expect(await ffmpeg[method]('/a path/ffmpeg')).toBe(result);
      expect(spawn).toHaveBeenCalledTimes(count);
      expect(spawn.mock.calls[0][2].shell).toBe(false);
    });
  });
}

test.each([0, 1])('path detection shares work and caches status %s', async status => {
  const { ffmpeg, spawn } = load('', status);
  const first = ffmpeg.findFFmpegPath();
  expect(ffmpeg.findFFmpegPath()).toBe(first);
  const result = await first;
  expect(result === null).toBe(status !== 0);
  const count = spawn.mock.calls.length;
  expect(await ffmpeg.findFFmpegPath()).toBe(result);
  expect(spawn).toHaveBeenCalledTimes(count);
});

test('hardware absence is coalesced and cached', async () => {
  const { ffmpeg, spawn } = load();
  const pending = ffmpeg.detectGpuHardware();
  expect(ffmpeg.detectGpuHardware()).toBe(pending);
  expect(await pending).toBeNull();
  expect(await ffmpeg.detectGpuHardware()).toBeNull();
  expect(spawn).toHaveBeenCalledTimes(1);
});

test('probe is asynchronous and drains both pipes before close', async () => {
  const { ffmpeg, children } = load('hello');
  let settled = false;
  const pending = ffmpeg.runProbe('/path with spaces/ffmpeg', ['-version']).then(result => { settled = true; return result; });
  await Promise.resolve();
  expect(settled).toBe(false);
  children[0].stderr.emit('data', Buffer.from('diagnostic'));
  expect(await pending).toMatchObject({ status: 0, stdout: 'hello', stderr: 'diagnostic' });
  expect(children[0].listenerCount('close')).toBe(0);
  expect(children[0].stdout.listenerCount('data')).toBe(0);
});

test('failed starts and timeouts settle once and clean up', async () => {
  jest.useFakeTimers();
  try {
    const { ffmpeg, spawn } = load();
    spawn.mockImplementationOnce(() => { throw new Error('missing'); });
    expect((await ffmpeg.runProbe('missing', [])).error.message).toBe('missing');
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = jest.fn();
    spawn.mockReturnValueOnce(child);
    const pending = ffmpeg.runProbe('hung', [], { timeout: 10 });
    jest.advanceTimersByTime(10);
    expect((await pending).error.message).toBe('Probe timed out');
    expect(child.kill).toHaveBeenCalledWith('SIGKILL');
    expect(child.listenerCount('close')).toBe(0);
    expect(jest.getTimerCount()).toBe(0);
  } finally { jest.useRealTimers(); }
});

test('hardware success is cached after asynchronous completion', async () => {
  const output = process.platform === 'darwin' ? 'Chipset Model: Test GPU' :
    process.platform === 'win32' ? 'Name\nNVIDIA Test GPU\n' :
      'VGA compatible controller: Test GPU';
  const { ffmpeg, spawn } = load(output);
  const result = await ffmpeg.detectGpuHardware();
  expect(result).toContain('Test GPU');
  expect(await ffmpeg.detectGpuHardware()).toBe(result);
  expect(spawn).toHaveBeenCalledTimes(1);
});

test('spawn error resolves failure and ignores subsequent close', async () => {
  const { ffmpeg, children } = load();
  const pending = ffmpeg.runProbe('missing', []);
  const child = children[0];
  child.emit('error', new Error('ENOENT'));
  child.emit('close', -1);
  expect((await pending).error.message).toBe('ENOENT');
  expect(child.listenerCount('error')).toBe(0);
  expect(child.stderr.listenerCount('data')).toBe(0);
});
