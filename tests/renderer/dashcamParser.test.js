const fs = require('fs');
const path = require('path');
const vm = require('vm');

function parser(payload) {
    const context = vm.createContext({ window: {}, Uint8Array, DataView });
    vm.runInContext(fs.readFileSync(path.join(__dirname, '../../src/renderer/scripts/data/dashcam-mp4.js'), 'utf8'), context);
    const buffer = Uint8Array.from([0, 0, 0, 0, ...payload]).buffer;
    const mp4 = new context.window.DashcamMP4(buffer);
    mp4.getConfig = () => ({ sps: new Uint8Array(), pps: new Uint8Array(), durations: [40, 50] });
    mp4.findMdat = () => ({ offset: 4, size: payload.length });
    return { mp4, buffer };
}
const nal = bytes => [0, 0, 0, bytes.length, ...bytes];

test('frame and parameter payloads share the input buffer while preserving SEI and frame timing', () => {
    const { mp4, buffer } = parser([
        ...nal([7, 11]), ...nal([8, 12]),
        ...nal([6, 5, 0, 0x42, 0x69, 23, 0x80]),
        ...nal([5, 21, 22]), ...nal([1, 31]),
        0, 0, 0, 8, 1, 99 // truncated NAL must not become a frame
    ]);
    const before = Array.from(new Uint8Array(buffer));
    const frames = mp4.parseFrames({ decode: bytes => ({ value: bytes[0] }) });
    expect(frames).toHaveLength(2);
    expect(Array.from(frames[0].data)).toEqual([5, 21, 22]);
    expect(Array.from(frames[1].data)).toEqual([1, 31]);
    expect(frames.map(f => [f.timestamp, f.duration, f.keyframe])).toEqual([[0, 40, true], [40, 50, false]]);
    expect(frames[0].sei.value).toBe(23);
    expect(frames[1].sei).toBeNull();
    for (const bytes of [frames[0].data, frames[1].data, frames[0].sps, frames[0].pps]) {
        expect(bytes.buffer).toBe(buffer);
        expect(bytes.byteOffset).toBeGreaterThan(4);
    }
    expect(Array.from(frames[0].sps)).toEqual([7, 11]);
    expect(Array.from(frames[0].pps)).toEqual([8, 12]);
    expect(Array.from(new Uint8Array(buffer))).toEqual(before);
});

test.each([[[0, 0, 0, 0]], [[0, 0, 0]], [[0, 0, 0, 3, 5]]])('stops cleanly at invalid or incomplete NAL boundary %j', tail => {
    const { mp4 } = parser([...nal([5, 44]), ...tail]);
    const frames = mp4.parseFrames(null);
    expect(frames).toHaveLength(1);
    expect(Array.from(frames[0].data)).toEqual([5, 44]);
    expect(frames[0].timestamp).toBe(0);
});
