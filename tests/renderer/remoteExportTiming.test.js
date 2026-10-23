const fs = require('fs');
const path = require('path');
const vm = require('vm');

function canvasFixture(ensureExportDurations) {
    const advancedEditorState = {
        playback: {}, videoElements: new Map(), aeSeiBySegment: new Map(),
    };
    const nativeVideo = { cumulativeStarts: [0, 60, 120, 180] };
    if (ensureExportDurations) nativeVideo.ensureExportDurations = jest.fn(async (...args) => {
        const range = await ensureExportDurations(...args);
        nativeVideo.cumulativeStarts = [0, 3, 6, 9];
        return range;
    });
    const groups = Array.from({ length: 3 }, () => ({ filesByCamera: new Map() }));
    const context = vm.createContext({
        advancedEditorState, AbortController, console,
        filePathToUrl: value => value, isRcloneStreamUrl: () => false,
        extractSeiFromEntry: jest.fn(),
    });
    const source = fs.readFileSync(path.join(__dirname, '../../src/renderer/scripts/ui/advancedEditor/videoSync.js'), 'utf8')
        .replace(/^import .*;\n/gm, '')
        .replaceAll('export async function ', 'async function ')
        .replaceAll('export function ', 'function ');
    vm.runInContext(source, context);
    context.initVideoSync({
        getNativeVideo: () => nativeVideo,
        getState: () => ({ collection: { active: { groups } } }),
    });
    return { context, nativeVideo, playback: advancedEditorState.playback };
}

test.each([
    [0, 180, { startSec: 0, endSec: 9 }],
    [61, 122, { startSec: 4, endSec: 8 }],
    [100, 110, { startSec: 6, endSec: 6 }],
])('canvas consumes source-anchored range %s–%s without extending it', async (startSec, endSec, corrected) => {
    const { context, nativeVideo, playback } = canvasFixture(async () => corrected);
    await context.loadVideosForCanvas({ cameras: new Set(), startSec, endSec });
    const [start, end, options] = nativeVideo.ensureExportDurations.mock.calls[0];
    expect([start, end]).toEqual([startSec, endSec]);
    expect(options.signal).toBeInstanceOf(AbortSignal);
    expect(playback.startSec).toBe(corrected.startSec);
    expect(playback.endSec).toBe(corrected.endSec);
    expect(playback.currentSec).toBe(corrected.startSec);
});

test('canvas retains local bounds without a duration resolver', async () => {
    const { context, playback } = canvasFixture();
    await context.loadVideosForCanvas({ cameras: new Set(), startSec: 20, endSec: 80 });
    expect([playback.startSec, playback.endSec]).toEqual([20, 80]);
});

test('disposing during duration resolution aborts and does not install stale bounds', async () => {
    let finish;
    const { context, nativeVideo, playback } = canvasFixture(() => new Promise(resolve => { finish = resolve; }));
    const loading = context.loadVideosForCanvas({ cameras: new Set(), startSec: 0, endSec: 180 });
    const signal = nativeVideo.ensureExportDurations.mock.calls[0][2].signal;
    context.disposeVideos();
    expect(signal.aborted).toBe(true);
    finish({ startSec: 0, endSec: 9 });
    await loading;
    expect(playback.endSec).toBeUndefined();
});
