/** Parse routes and tags once off the main thread; transfer map buffers. */
const { parentPort, workerData } = require('worker_threads');
const fs = require('fs');
const { pathToFileURL } = require('url');
const http = require('http');
const { Transform } = require('stream');
const { isStreamPath } = require('./rcloneStream');

(async () => {
  let source, request, pipeline;
  const remote = workerData.remoteSize !== undefined;
  try {
    const { parser } = require('stream-json');
    const { Assembler } = require('stream-json/assembler.js');
    const chainMod = require('stream-chain');
    const chain = chainMod.chain ?? chainMod.default;
    const grouperUrl = new URL('../renderer/scripts/core/driveGrouper.js', pathToFileURL(__filename));
    const { groupStoreDataIntoDrives } = await import(grouperUrl.href);
    const t0 = Date.now();
    if (remote) {
      if (!isStreamPath(workerData.filePath) || !Number.isSafeInteger(workerData.remoteSize) || workerData.remoteSize <= 0) {
        throw new Error('Invalid remote drive data source.');
      }
      source = await new Promise((resolve, reject) => {
        request = http.get(workerData.filePath, { headers: { 'Accept-Encoding': 'identity' } }, response => {
          if (response.statusCode !== 200 || response.headers['content-encoding'] ||
              (response.headers['content-length'] !== undefined && response.headers['content-length'] !== String(workerData.remoteSize))) {
            response.destroy();
            reject(new Error('Remote drive data could not be read safely.'));
          } else resolve(response);
        });
        request.setTimeout(120000, () => request.destroy(new Error('Remote drive data timed out.')));
        request.once('error', reject);
      });
    } else {
      source = fs.createReadStream(workerData.filePath);
    }
    let bytes = 0;
    const sizeCheck = remote ? new Transform({
      transform(chunk, encoding, callback) {
        bytes += chunk.length;
        callback(bytes > workerData.remoteSize ? new Error('Remote drive data size changed.') : null, chunk);
      },
      flush(callback) {
        callback(bytes !== workerData.remoteSize ? new Error('Remote drive data was truncated.') : null);
      }
    }) : null;
    const routes = [];
    let driveTags = {};
    // Sorting needs all routes, but unrelated StoreData and route fields do not.
    const routeFields = new Set(['File', 'file', 'Points', 'points', 'Speeds', 'speeds',
      'AutopilotStates', 'autopilotStates', 'AccelPositions', 'accelPositions',
      'GearStates', 'gearStates', 'GearRuns', 'gearRuns',
      'RawFrameCount', 'rawFrameCount', 'RawParkCount', 'rawParkCount']);
    pipeline = chain([
      source,
      ...(sizeCheck ? [sizeCheck] : []),
      // Never pack ignored strings (ProcessedFiles can exceed V8's string limit).
      parser({ packStrings: false, streamKeys: false, streamNumbers: false }),
    ]);
    let depth = 0;
    let rootKey = '';
    let routeField = '';
    let assembler = null;
    let capture = null;
    let stringParts = [];
    let lastLog = Date.now();
    for await (const token of pipeline) {
      const { name, value } = token;
      const opens = name === 'startObject' || name === 'startArray';
      const closes = name === 'endObject' || name === 'endArray';
      if (name === 'keyValue' && depth === 1) rootKey = value.toLowerCase();
      if (!assembler && depth === 2 && rootKey === 'routes' && name === 'startObject') {
        assembler = new Assembler();
        capture = 'route';
        routeField = '';
      } else if (!assembler && depth === 1 && /^(drivetags|drive_tags)$/.test(rootKey) && name === 'startObject') {
        assembler = new Assembler();
        capture = 'tags';
      }
      if (assembler) {
        if (capture === 'route' && depth === 3 && name === 'keyValue') routeField = value;
        const keep = capture === 'tags' || depth === 2 || (closes && depth === 3) || routeFields.has(routeField);
        if (keep) {
          if (name === 'startString') stringParts = [];
          else if (name === 'stringChunk') stringParts.push(value);
          else if (name === 'endString') {
            assembler.consume({ name: 'stringValue', value: stringParts.join('') });
            stringParts = [];
          } else assembler.consume(token);
        }
        if (closes && assembler.done) {
          if (capture === 'tags') driveTags = assembler.current;
          else {
            routes.push(assembler.current);
            if (routes.length % 1000 === 0 || Date.now() - lastLog > 2000) {
              parentPort.postMessage({ type: 'progress', count: routes.length, elapsedMs: Date.now() - t0 });
              lastLog = Date.now();
            }
          }
          assembler = null;
          capture = null;
        }
      }
      if (opens) depth++;
      if (closes) depth--;
    }
    parentPort.postMessage({ type: 'routesDone', count: routes.length, elapsedMs: Date.now() - t0 });
    const tGroup = Date.now();
    const { drives, driveCount, routeCount } = groupStoreDataIntoDrives({ Routes: routes, DriveTags: driveTags });
    const transfers = [];
    for (const d of drives) {
      const pts = d.points || [];
      const flat = new Float64Array(pts.length * 5);
      for (let i = 0; i < pts.length; i++) {
        const p = pts[i];
        const o = i * 5;
        flat[o] = p[0];
        flat[o + 1] = p[1];
        flat[o + 2] = p[2] || 0;
        flat[o + 3] = p[3] || 0;
        flat[o + 4] = p[4] || 0;
      }
      d.pointsBuf = flat;
      delete d.points;
      transfers.push(flat.buffer);
    }
    parentPort.postMessage({ type: 'done', drives, driveCount, routeCount,
      routesLen: routes.length, groupMs: Date.now() - tGroup }, transfers);
  } catch (err) {
    parentPort.postMessage({ type: 'error', error: remote ? 'Remote drive data could not be read safely.' : err?.message || String(err) });
  } finally {
    pipeline?.destroy();
    source?.destroy();
    request?.destroy();
  }
})();
