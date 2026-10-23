const { Worker } = require('worker_threads');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

async function runWorker(workerData) {
  const worker = new Worker(path.resolve(__dirname, '../../src/main/driveLoadWorker.js'), { workerData });
  const messages = [];
  try {
    const code = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('worker did not exit unaided')), 5000);
      worker.on('message', message => messages.push(message));
      worker.once('error', error => { clearTimeout(timer); reject(error); });
      worker.once('exit', code => { clearTimeout(timer); resolve(code); });
    });
    expect(code).toBe(0);
    return messages;
  } finally {
    await worker.terminate();
  }
}

async function load(contents) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dlw-test-'));
  const filePath = path.join(dir, 'drive-data.json');
  fs.writeFileSync(filePath, contents);
  try {
    return await runWorker({ filePath });
  } finally {
    fs.rmSync(dir, { recursive: true });
  }
}

const route = {
  File: '2024-01-15_10-30-00-front.mp4',
  Points: [[37, -122], [37.001, -122]], Speeds: [10, 20],
  AutopilotStates: 'AQE=', GearStates: 'AQE=', AccelPositions: [0, 0],
  unused: { nested: ['ignored'] },
};

test.each(['DriveTags', 'driveTags', 'DRIVE_TAGS'])('extracts %s before and after routes and exits without parent messages', async key => {
  for (const before of [true, false]) {
    const tags = { [key]: { 1: ['commute'] } };
    const data = before ? { ...tags, RoUtEs: [route] } : { RoUtEs: [route], ...tags };
    const messages = await load(JSON.stringify({ ProcessedFiles: ['irrelevant'], ...data }));
    expect(messages.find(m => m.type === 'routesDone').count).toBe(1);
    const result = messages.find(m => m.type === 'done');
    expect(result.driveCount).toBe(1);
    expect(result.drives[0].tags).toEqual(['commute']);
    expect(result.drives[0].fsdPercent).toBe(100);
    expect(result.drives[0].distanceKm).toBeGreaterThan(0);
    expect(require('util').types.isFloat64Array(result.drives[0].pointsBuf)).toBe(true);
    expect(Array.from(result.drives[0].pointsBuf)).toEqual([37, -122, 0, 10, 1, 37.001, -122, 0, 20, 1]);
  }
}, 20000);

test.each([{}, { routes: [] }, { drive_tags: { 1: ['tag'] } }, { routes: [{ File: 'invalid' }] }])('missing or invalid routes finish normally: %j', async data => {
  const messages = await load(JSON.stringify(data));
  expect(messages.find(m => m.type === 'done').driveCount).toBe(0);
});

test('absent tags and unsorted routes retain chronological geometry and default tags', async () => {
  const later = { ...route, File: '2024-01-15_10-31-00-front.mp4' };
  const messages = await load(JSON.stringify({ routes: [later, route] }));
  const drive = messages.find(m => m.type === 'done').drives[0];
  expect(drive.tags).toEqual([]);
  expect(drive.routeTimestampKeys).toEqual(['2024-01-15_10-30-00', '2024-01-15_10-31-00']);
  expect(drive.pointCount).toBe(4);
});

test('malformed JSON emits error, never done, and exits unaided', async () => {
  const messages = await load('{"routes": [], "DriveTags": {');
  expect(messages.some(m => m.type === 'error' && m.error)).toBe(true);
  expect(messages.some(m => m.type === 'done')).toBe(false);
});

test.each(['valid', 'malformed', 'short', 'long', 'aborted', 'redirect', 'status', 'wrong-length'])(
  'remote HTTP streaming handles %s without publishing partial data', async mode => {
    const body = Buffer.from(JSON.stringify({ Routes: [route], ProcessedFiles: ['ignored'] }));
    let redirected = false;
    const server = http.createServer((req, res) => {
      if (req.url === '/redirect-target') redirected = true;
      if (mode === 'redirect') { res.writeHead(302, { Location: '/redirect-target' }).end(); return; }
      if (mode === 'status') { res.writeHead(403).end('private diagnostics'); return; }
      if (mode === 'wrong-length') { res.writeHead(200, { 'Content-Length': body.length + 1 }).end(body); return; }
      res.writeHead(200);
      if (mode === 'malformed') { res.end('{"Routes": ['); return; }
      if (mode === 'short') { res.end(body.subarray(0, body.length - 1)); return; }
      if (mode === 'long') { res.end(Buffer.concat([body, Buffer.from(' ')])); return; }
      res.write(body.subarray(0, 20));
      setImmediate(() => {
        if (mode === 'aborted') res.destroy();
        else res.end(body.subarray(20));
      });
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    try {
      const filePath = `http://127.0.0.1:${server.address().port}/sentry-rclone/${'a'.repeat(64)}/drive-data.json`;
      const messages = await runWorker({ filePath, remoteSize: body.length });
      if (mode === 'valid') {
        expect(messages.find(m => m.type === 'done').driveCount).toBe(1);
      } else {
        expect(messages.some(m => m.type === 'done')).toBe(false);
        expect(messages.find(m => m.type === 'error').error).toBe('Remote drive data could not be read safely.');
      }
      expect(redirected).toBe(false);
    } finally {
      server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
    }
  }, 10000);

test('rejects non-managed remote URL shapes before requesting them', async () => {
  const messages = await runWorker({ filePath: 'http://example.com/drive-data.json', remoteSize: 123 });
  expect(messages.some(m => m.type === 'done')).toBe(false);
  expect(messages.find(m => m.type === 'error').error).toBe('Remote drive data could not be read safely.');
});
