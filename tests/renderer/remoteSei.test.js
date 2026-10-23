const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { ReadableStream } = require('stream/web');

const u32 = n => [n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
const box = (name, payload) => [...u32(payload.length + 8), ...Buffer.from(name), ...payload];
const nal = data => [...u32(data.length), ...data];
function fixture(after = false, tail = []) {
    const avcC = box('avcC', [1, 100, 0, 31, 255, 225, 0, 1, 7, 1, 0, 1, 8]);
    const stsd = box('stsd', [...u32(0), ...u32(1), ...box('avc1', [...new Array(78).fill(0), ...avcC])]);
    const stts = box('stts', [...u32(0), ...u32(2), ...u32(1), ...u32(40), ...u32(1), ...u32(50)]);
    const mdhd = box('mdhd', [...new Array(12).fill(0), ...u32(1000)]);
    const moov = box('moov', box('trak', box('mdia', [...mdhd, ...box('minf', box('stbl', [...stsd, ...stts]))])));
    const mdat = box('mdat', [
        ...nal([6, 5, 0, 0x42, 0x69, 23, 0x80]), ...nal([5, 21, 22]),
        ...nal([6, 5, 0, 0x42, 0x69, 24, 0x80]), ...nal([1, 31]), ...tail
    ]);
    return Uint8Array.from(after ? [...mdat, ...moov] : [...moov, ...mdat]);
}
function environment(data, { controller, abortDuringRead = false, truncate = false } = {}) {
    let canceled = 0;
    const requests = [];
    const context = vm.createContext({
        window: {}, Uint8Array, DataView, DOMException, console,
        fetch: async (url, { headers }) => {
            requests.push(url);
            const [, a, b] = /^bytes=(\d+)-(\d+)$/.exec(headers.Range);
            const start = Number(a), end = Number(b);
            let position = start;
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
                    },
                    cancel() { canceled++; }
                })
            };
        }
    });
    vm.runInContext(fs.readFileSync(path.join(__dirname, '../../src/renderer/scripts/data/dashcam-mp4.js'), 'utf8'), context);
    vm.runInContext(fs.readFileSync(path.join(__dirname, '../../src/renderer/scripts/core/remoteSei.js'), 'utf8').replace('export async function', 'async function'), context);
    return { context, requests, canceled: () => canceled };
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
