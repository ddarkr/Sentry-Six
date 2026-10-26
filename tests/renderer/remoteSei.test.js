const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { ReadableStream } = require('stream/web');

const u32 = n => [n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
const box = (name, payload) => [...u32(payload.length + 8), ...Buffer.from(name), ...payload];
const nal = data => [...u32(data.length), ...data];
function fixture(after = false, tail = [], samples = null) {
    const avcC = box('avcC', [1, 100, 0, 31, 255, 225, 0, 1, 7, 1, 0, 1, 8]);
    const stsd = box('stsd', [...u32(0), ...u32(1), ...box('avc1', [...new Array(78).fill(0), ...avcC])]);
    const timing = samples
        ? [...u32(samples.length), ...samples.flatMap(sample => [...u32(1), ...u32(sample.duration)])]
        : [...u32(2), ...u32(1), ...u32(40), ...u32(1), ...u32(50)];
    const stts = box('stts', [...u32(0), ...timing]);
    const mdhd = box('mdhd', [...new Array(12).fill(0), ...u32(1000)]);
    const moov = box('moov', box('trak', box('mdia', [...mdhd, ...box('minf', box('stbl', [...stsd, ...stts]))])));
    const payload = samples ? samples.flatMap(sample => [
        ...(sample.value == null ? [] : nal([6, 5, 0, 0x42, 0x69, sample.value, 0x80])),
        ...nal([1, 31])
    ]) : [
        ...nal([6, 5, 0, 0x42, 0x69, 23, 0x80]), ...nal([5, 21, 22]),
        ...nal([6, 5, 0, 0x42, 0x69, 24, 0x80]), ...nal([1, 31])
    ];
    const mdat = box('mdat', [...payload, ...tail]);
    return Uint8Array.from(after ? [...mdat, ...moov] : [...moov, ...mdat]);
}
function environment(data, { controller, abortDuringRead = false, truncate = false } = {}) {
    let canceled = 0;
    const requests = [];
    const reads = [];
    const context = vm.createContext({
        window: {}, Uint8Array, DataView, DOMException, AbortController, console,
        fetch: async (url, { headers }) => {
            requests.push(url);
            const [, a, b] = /^bytes=(\d+)-(\d+)$/.exec(headers.Range);
            const start = Number(a), end = Number(b);
            let position = start;
            const read = { start, end, position };
            reads.push(read);
            return {
                status: 206,
                headers: { get: () => `bytes ${start}-${end}/${data.length}` },
                body: new ReadableStream({
                    pull(stream) {
                        if (abortDuringRead && end - start > 32) controller.abort();
                        const stop = truncate && end - start > 32 ? end - 1 : end + 1;
                        if (position >= stop) return stream.close();
                        const next = Math.min(position + 3, stop);
                        stream.enqueue(data.slice(position, next));
                        position = next;
                        read.position = position;
                    },
                    cancel() { canceled++; }
                })
            };
        }
    });
    vm.runInContext(fs.readFileSync(path.join(__dirname, '../../src/renderer/scripts/data/dashcam-mp4.js'), 'utf8'), context);
    vm.runInContext(fs.readFileSync(path.join(__dirname, '../../src/renderer/scripts/core/remoteSei.js'), 'utf8').replace('export async function', 'async function'), context);
    return { context, requests, reads, canceled: () => canceled };
}
const decoder = { decode: bytes => ({ value: bytes[0] }) };

test.each([false, true])('stream chunks preserve local timing with moov after mdat=%s', async after => {
    const data = fixture(after);
    const { context, requests } = environment(data);
    const frames = await context.extractRemoteFrames('active-clip', decoder);
    const local = new context.window.DashcamMP4(data.buffer).parseFrames(decoder);
    let time = 0;
    expect(frames).toEqual(local.map(frame => ({ timestampMs: time += frame.duration, frameTimestampMs: frame.timestamp, sei: frame.sei })));
    expect(frames.map(frame => [frame.timestampMs, frame.sei.value])).toEqual([[40, 23], [90, 24]]);
    expect(new Set(requests)).toEqual(new Set(['active-clip']));
});

test('aborting cancels a pending body and rejects instead of returning partial results', async () => {
    const controller = new AbortController();
    const env = environment(fixture(), { controller, abortDuringRead: true });
    await expect(env.context.extractRemoteFrames('active-clip', decoder, controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
    expect(env.canceled()).toBeGreaterThan(0);
});

test('truncated response rejects', async () => {
    const env = environment(fixture(), { truncate: true });
    await expect(env.context.extractRemoteFrames('active-clip', decoder)).rejects.toThrow('Truncated');
});

test.each([[[0, 0, 0]], [[0, 0, 0, 20, 6]], [[0, 0, 0, 0]]])('invalid NAL boundary rejects %j', async tail => {
    const env = environment(fixture(false, tail));
    await expect(env.context.extractRemoteFrames('active-clip', decoder)).rejects.toThrow(/NAL/);
});

test('invalid top-level box size cannot loop or read beyond the source', async () => {
    const env = environment(Uint8Array.from([...u32(2), ...Buffer.from('mdat')]));
    await expect(env.context.extractRemoteFrames('active-clip', decoder)).rejects.toThrow('Invalid MP4 box size');
});

test('extended-size and to-EOF mdat boxes retain telemetry', async () => {
    const original = fixture(true);
    const size = new DataView(original.buffer).getUint32(0);
    const extended = Uint8Array.from([
        ...u32(1), ...Buffer.from('mdat'), ...u32(0), ...u32(size + 8),
        ...original.subarray(8)
    ]);
    const first = environment(extended);
    expect((await first.context.extractRemoteFrames('active', decoder)).map(frame => frame.sei.value)).toEqual([23, 24]);
    const eof = fixture(false);
    let offset = new DataView(eof.buffer).getUint32(0);
    eof.set(u32(0), offset);
    const second = environment(eof);
    expect((await second.context.extractRemoteFrames('active', decoder)).map(frame => frame.timestampMs)).toEqual([40, 90]);
});

test('progress batches media coverage without SEI and preserves late telemetry', async () => {
    const samples = Array.from({ length: 30 }, (_, index) => ({
        duration: 100, value: index === 0 ? 23 : index === 28 ? 24 : null
    }));
    const data = fixture(false, [], samples);
    const { context, reads } = environment(data);
    const progress = [];
    let complete = false;
    const frames = await context.extractRemoteFrames('active', decoder, undefined, {
        onProgress: ({ frames, processedUntilMs }) => {
            expect(complete).toBe(false);
            if (!progress.length) expect(reads[reads.length - 1].position).toBeLessThan(data.length);
            progress.push({ frames, count: frames.length, processedUntilMs });
        }
    });
    complete = true;
    expect(progress.map(item => [item.count, item.processedUntilMs])).toEqual([
        [1, 100], [1, 1100], [1, 2100], [2, 3000]
    ]);
    expect(progress.every(item => item.frames === frames)).toBe(true);
    const local = new context.window.DashcamMP4(data.buffer).parseFrames(decoder);
    let time = 0;
    expect(frames).toEqual(local.flatMap(frame => {
        time += frame.duration;
        return frame.sei ? [{ timestampMs: time, frameTimestampMs: frame.timestamp, sei: frame.sei }] : [];
    }));
});

function loadExtractor(context) {
    context.File = class File {};
    context.isRcloneStreamUrl = () => true;
    context.window.DashcamHelpers = { initProtobuf: async () => ({ SeiMetadata: {
        decode: bytes => ({ value: bytes[0], latitudeDeg: 37, longitudeDeg: 127 })
    } }) };
    const source = fs.readFileSync(path.join(__dirname, '../../src/renderer/scripts/core/seiExtractor.js'), 'utf8')
        .replace(/^import .*;\n/gm, '').replace(/^export /gm, '');
    vm.runInContext(source, context);
}

test('entry progress builds shared map incrementally; abort never caches partial data', async () => {
    const { context, requests } = environment(fixture());
    loadExtractor(context);
    const entry = { file: { isElectronFile: true, path: 'remote' } };
    const controller = new AbortController();
    const abortedProgress = [];
    await expect(context.extractSeiFromEntry(entry, null, {
        signal: controller.signal,
        onProgress: value => {
            abortedProgress.push(value);
            controller.abort();
        }
    })).rejects.toMatchObject({ name: 'AbortError' });
    expect(abortedProgress).toHaveLength(1);
    expect(abortedProgress[0].seiData).toHaveLength(1);
    const progress = [];
    const result = await context.extractSeiFromEntry(entry, null, { onProgress: value => {
        progress.push({ ...value, count: value.mapPath.length });
    } });
    expect(progress.map(value => value.count)).toEqual([1, 2]);
    expect(progress.every(value => value.mapPath === result.mapPath && value.seiData === result.seiData)).toBe(true);
    expect(result.mapPath.map(point => point.timestampMs)).toEqual([40, 90]);
    expect(result.seiData.map(frame => frame.sei.value)).toEqual([23, 24]);
    const cachedRequests = requests.length;
    const onProgress = jest.fn();
    expect(await context.extractSeiFromEntry(entry, null, { onProgress })).toBe(result);
    expect(requests).toHaveLength(cachedRequests);
    expect(onProgress).not.toHaveBeenCalled();
});

test('truncation after progress does not cache incomplete telemetry', async () => {
    const { context } = environment(fixture(false, [0, 0, 0]));
    loadExtractor(context);
    const entry = { file: { isElectronFile: true, path: 'truncated' } };
    const onProgress = jest.fn();
    await expect(context.extractSeiFromEntry(entry, null, { onProgress })).rejects.toThrow('Truncated');
    expect(onProgress).toHaveBeenCalledTimes(1);
    await expect(context.extractSeiFromEntry(entry, null)).rejects.toThrow('Truncated');
});

test('remote reads wait for playback while completed cache hits bypass the gate', async () => {
    const { context, requests } = environment(fixture());
    loadExtractor(context);
    const entry = { file: { isElectronFile: true, path: 'gated' } };
    let release;
    const waiting = context.extractSeiFromEntry(entry, null, {
        beforeRead: () => new Promise(resolve => { release = resolve; })
    });
    await Promise.resolve();
    expect(requests).toEqual([]);
    release();
    const complete = await waiting;
    expect(complete.seiData.map(frame => frame.sei.value)).toEqual([23, 24]);
    const cached = await context.extractSeiFromEntry(entry, null, {
        beforeRead: () => { throw new Error('Cached telemetry must not wait for video'); }
    });
    expect(cached.seiData.map(frame => frame.sei.value)).toEqual([23, 24]);

    const controller = new AbortController();
    requests.length = 0;
    const cancelled = context.extractSeiFromEntry({ file: { isElectronFile: true, path: 'obsolete' } }, null, {
        signal: controller.signal, beforeRead: () => new Promise(resolve => { release = resolve; })
    });
    controller.abort(); release();
    await expect(cancelled).rejects.toMatchObject({ name: 'AbortError' });
    expect(requests).toEqual([]);
});

test('concurrent consumers share the initial playback gate and survive its owner aborting', async () => {
    const { context, requests } = environment(fixture());
    loadExtractor(context);
    const entry = { file: { path: 'shared-gate' } };
    const controller = new AbortController();
    let release, sharedSignal;
    const first = context.extractSeiFromEntry(entry, null, {
        signal: controller.signal,
        beforeRead: signal => {
            sharedSignal = signal;
            return new Promise(resolve => { release = resolve; });
        }
    });
    const rejected = expect(first).rejects.toMatchObject({ name: 'AbortError' });
    const second = context.extractSeiFromEntry(entry);
    await Promise.resolve();
    expect(requests).toEqual([]);
    controller.abort();
    await rejected;
    expect(sharedSignal.aborted).toBe(true);
    expect(requests).toEqual([]);
    const result = await second;
    release(); // An unresolved obsolete gate must not strand the survivor.
    expect(result.seiData.map(frame => frame.sei.value)).toEqual([23, 24]);
    const count = requests.length;
    expect(await context.extractSeiFromEntry(entry)).toBe(result);
    expect(requests).toHaveLength(count);
});

test('late listeners receive current coverage and one subscriber abort does not stop shared ranges', async () => {
    const { context, reads } = environment(fixture());
    loadExtractor(context);
    const entry = { file: { path: 'shared-progress' } };
    const controller = new AbortController();
    let late, firstCoverage;
    const lateProgress = [];
    const first = context.extractSeiFromEntry(entry, null, {
        signal: controller.signal,
        onProgress: progress => {
            firstCoverage = progress.processedUntilMs;
            late = context.extractSeiFromEntry(entry, null, {
                onProgress: value => lateProgress.push({
                    coverage: value.processedUntilMs, count: value.seiData.length
                })
            });
            controller.abort();
        }
    });
    await expect(first).rejects.toMatchObject({ name: 'AbortError' });
    const result = await late;
    expect(lateProgress[0]).toEqual({ coverage: firstCoverage, count: 1 });
    expect(lateProgress[lateProgress.length - 1]).toEqual({ coverage: 90, count: 2 });
    expect(result.seiData.map(frame => frame.sei.value)).toEqual([23, 24]);
    // A single parser reads each metadata/range offset only once.
    expect(new Set(reads.map(read => `${read.start}-${read.end}`)).size).toBe(reads.length);
});

test('last subscriber abort releases a pending gate immediately and old cleanup cannot remove its replacement', async () => {
    const { context, requests } = environment(fixture());
    loadExtractor(context);
    const entry = { file: { path: 'replace-aborted' } };
    const controller = new AbortController();
    let release, oldSignal;
    const old = context.extractSeiFromEntry(entry, null, {
        signal: controller.signal,
        beforeRead: signal => {
            oldSignal = signal;
            return new Promise(resolve => { release = resolve; });
        }
    });
    const rejected = expect(old).rejects.toMatchObject({ name: 'AbortError' });
    controller.abort();
    await rejected;
    expect(oldSignal.aborted).toBe(true);
    const replacement = context.extractSeiFromEntry(entry);
    release();
    const joined = context.extractSeiFromEntry(entry);
    const result = await replacement;
    expect((await joined).seiData.map(frame => frame.sei.value)).toEqual([23, 24]);
    expect(await context.extractSeiFromEntry(entry)).toBe(result);
});

test('gate failure rejects shared consumers and permits a fresh successful extraction', async () => {
    const { context, requests } = environment(fixture());
    loadExtractor(context);
    const entry = { file: { path: 'failed-gate' } };
    let rejectGate;
    const first = context.extractSeiFromEntry(entry, null, {
        beforeRead: () => new Promise((resolve, reject) => { rejectGate = reject; })
    });
    const second = context.extractSeiFromEntry(entry);
    const failures = Promise.all([
        expect(first).rejects.toThrow('Gate failed'),
        expect(second).rejects.toThrow('Gate failed')
    ]);
    rejectGate(new Error('Gate failed'));
    await failures;
    expect(requests).toEqual([]);
    expect((await context.extractSeiFromEntry(entry)).seiData.map(frame => frame.sei.value)).toEqual([23, 24]);
});

test.each([false, true])('progress callback failure only rejects its subscriber (async=%s)', async asynchronous => {
    const { context } = environment(fixture());
    loadExtractor(context);
    const entry = { file: { path: 'callback-failure' } };
    const first = context.extractSeiFromEntry(entry, null, {
        onProgress: () => {
            if (asynchronous) return Promise.reject(new Error('Listener failed'));
            throw new Error('Listener failed');
        }
    });
    const second = context.extractSeiFromEntry(entry);
    await expect(first).rejects.toThrow('Listener failed');
    expect((await second).seiData.map(frame => frame.sei.value)).toEqual([23, 24]);
});

test('departing playback owner hands off to a surviving playback gate', async () => {
    const { context, requests } = environment(fixture());
    loadExtractor(context);
    const entry = { file: { path: 'gate-handoff' } };
    const controller = new AbortController();
    let oldSignal, nextSignal, release, started;
    const gateStarted = new Promise(resolve => { started = resolve; });
    const first = context.extractSeiFromEntry(entry, null, {
        signal: controller.signal,
        beforeRead: signal => {
            oldSignal = signal;
            return new Promise((resolve, reject) => {
                signal.addEventListener('abort', () => reject(signal.reason), { once: true });
            });
        }
    });
    const second = context.extractSeiFromEntry(entry, null, {
        beforeRead: signal => {
            nextSignal = signal;
            started();
            return new Promise(resolve => { release = resolve; });
        }
    });
    const rejected = expect(first).rejects.toMatchObject({ name: 'AbortError' });
    controller.abort();
    await rejected;
    await gateStarted;
    expect(oldSignal.aborted).toBe(true);
    expect(nextSignal.aborted).toBe(false);
    expect(requests).toEqual([]);
    release();
    expect((await second).seiData.map(frame => frame.sei.value)).toEqual([23, 24]);
    expect(nextSignal.aborted).toBe(true);
});
