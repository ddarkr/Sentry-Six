const fs = require('fs');
const path = require('path');
const vm = require('vm');

const source = fs.readFileSync(path.join(__dirname, '../../src/renderer/script.js'), 'utf8');
function fixture() {
    const listeners = {};
    const video = {
        currentTime: 9, duration: 60, readyState: 3, src: '',
        pause() {}, load() {},
        addEventListener(name, fn) { (listeners[name] ||= new Set()).add(fn); },
        removeEventListener(name, fn) { listeners[name]?.delete(fn); }
    };
    const pending = [];
    const noop = () => {};
    const group = id => ({ id, filesByCamera: new Map([['front', { file: { isElectronFile: true, path: id } }]]) });
    const collection = { groups: [group('a'), group('b')] };
    const context = vm.createContext({
        console: { log: noop, warn: noop, error: noop },
        activeTelemetryController: null,
        playbackBuffering: { reset: jest.fn(), setSources: jest.fn() },
        AbortController,
        state: { collection: { active: collection }, ui: { nativeVideoMode: true }, multi: { enabled: true } },
        nativeVideo: { master: video, currentSegmentIdx: -1, cumulativeStarts: [0, 60, 120], telemetryRafId: 1 },
        videoMain: video, videoBySlot: {}, videoUrls: new Map(), multi: { enabled: false }, selection: {},
        File: class {}, URL: {}, filePathToUrl: x => x, stopTelemetryLoop: noop,
        setMultiCamGridVisible: noop, dashboardVis: { classList: { add: noop } }, mapVis: { classList: { add: noop } },
        seiType: {}, extractSeiFromEntry: jest.fn(() => new Promise(resolve => pending.push(resolve))),
        map: null, window: {}, setTimeout: () => 1, clearTimeout: noop,
        applyPlaybackRate: jest.fn(), updateTimeDisplayNew: jest.fn(), updateRecordingTime: noop,
        playNative: jest.fn(), updatePlayButton: jest.fn(),
        progressBar: { value: 42 }, findSeiAtTime: noop, resetDashboardElements: noop,
        getNativeVideo: () => context.nativeVideo, getVideoBySlot: () => context.videoBySlot, getState: () => context.state
    });
    const sync = fs.readFileSync(path.join(__dirname, '../../src/renderer/scripts/ui/multiCamFocus.js'), 'utf8');
    vm.runInContext(sync.slice(sync.indexOf('export function syncMultiVideos')).replace('export function', 'function'), context);
    vm.runInContext(source.slice(source.indexOf('let nativeSegmentLoadRequest ='), source.indexOf('\nfunction playNative()')), context);
    vm.runInContext(source.slice(source.indexOf('function onMasterTimeUpdate()'), source.indexOf('\nfunction onMasterLoaded()')), context);
    vm.runInContext(source.slice(source.indexOf('function onMasterEnded()'), source.indexOf('\nlet nativeSegmentLoadRequest =')), context);
    return { context, video, pending, collection, ready: index => {
        const callbacks = [...(listeners.canplay || [])];
        (index === undefined ? callbacks : [callbacks[index]]).forEach(fn => fn());
    } };
}

const telemetry = label => ({ seiData: [{ label }], mapPath: [{ label }] });

test('remote registration uses the actual fallback camera and clears sources on replacement', async () => {
    const { context: c, collection, ready } = fixture();
    collection.groups[0].filesByCamera = new Map([['back', { file: { isElectronFile: true, isRemote: true, path: 'remote-back' } }]]);
    c.selection.selectedCamera = 'front';
    const load = c.loadNativeSegment(0);
    const [sources, active] = c.playbackBuffering.setSources.mock.calls[0];
    expect(sources).toHaveLength(1);
    expect(sources[0]).toMatchObject({ video: c.videoMain, camera: 'back', src: 'remote-back' });
    expect(active()).toBe(true);
    ready();
    await load;
    const replacement = c.loadNativeSegment(1);
    expect(active()).toBe(false);
    expect(c.playbackBuffering.reset).toHaveBeenCalledTimes(2);
    expect(c.playbackBuffering.setSources.mock.calls[1][0]).toHaveLength(0);
    ready();
    await replacement;
});
const flush = async () => { await Promise.resolve(); await Promise.resolve(); };

test('A-B-A extraction resolves newest first without older SEI or map overwriting it', async () => {
    const { context: c, pending, ready } = fixture();
    const loads = [c.loadNativeSegment(0), c.loadNativeSegment(1), c.loadNativeSegment(0)];
    pending[2](telemetry('new-a'));
    const calls = c.extractSeiFromEntry.mock.calls;
    expect(calls[0][2].signal.aborted).toBe(true);
    expect(calls[1][2].signal.aborted).toBe(true);
    expect(calls[2][2].signal.aborted).toBe(false);
    await flush();
    pending[1](telemetry('b'));
    pending[0](telemetry('old-a'));
    await flush();
    expect(c.nativeVideo.seiData[0].label).toBe('new-a');
    expect(c.window._lastMapPath[0].label).toBe('new-a');
    ready();
    expect(await Promise.all(loads)).toEqual([false, false, true]);
    expect(c.applyPlaybackRate).toHaveBeenCalledTimes(1);
});

test.each(['replace', 'clear'])('collection %s invalidates pending telemetry and video-ready reset', async action => {
    const { context: c, pending, ready, collection, video } = fixture();
    const oldLoad = c.loadNativeSegment(0);
    c.state.collection.active = action === 'clear' ? null : { groups: collection.groups };
    let newLoad;
    if (action === 'replace') newLoad = c.loadNativeSegment(0);
    if (newLoad) { pending[1](telemetry('replacement')); await flush(); }
    pending[0](telemetry('stale'));
    await flush();
    video.currentTime = 23;
    ready();
    expect(await oldLoad).toBe(false);
    if (newLoad) {
        expect(await newLoad).toBe(true);
        expect(c.nativeVideo.seiData[0].label).toBe('replacement');
    } else {
        expect(c.nativeVideo.seiData).toHaveLength(0);
        expect(video.currentTime).toBe(23);
        expect(c.applyPlaybackRate).not.toHaveBeenCalled();
    }
});


test('superseded automatic transition releases its guard without clearing a newer transition', async () => {
    const { context: c, pending, ready } = fixture();
    c.nativeVideo.currentSegmentIdx = 0;
    c.onMasterEnded();
    expect(c.nativeVideo.isTransitioning).toBe(true);
    const seek = c.loadNativeSegment(0);
    expect(c.nativeVideo.isTransitioning).toBe(false);
    pending[1](telemetry('seek'));
    await flush();
    ready(1);
    expect(await seek).toBe(true);
    c.onMasterEnded();
    expect(c.nativeVideo.isTransitioning).toBe(true);
    pending[0](telemetry('superseded'));
    ready(0);
    await flush();
    expect(c.nativeVideo.isTransitioning).toBe(true);
    pending[2](telemetry('advance'));
    await flush();
    ready();
    await flush();
    expect(c.nativeVideo.isTransitioning).toBe(false);
    expect(c.nativeVideo.currentSegmentIdx).toBe(1);
    expect(c.playNative).toHaveBeenCalledTimes(1);
});

function durationFixture(actual) {
    const groups = actual.map((duration, index) => ({
        id: index, duration,
        filesByCamera: new Map([['front', { file: { isRemote: true } }]])
    }));
    const context = vm.createContext({
        state: { collection: { active: { groups } } },
        nativeVideo: {
            segmentDurations: actual.map(() => 60),
            cumulativeStarts: actual.map((_, i) => i * 60).concat(actual.length * 60)
        },
        DOMException,
        probeSegmentDurations: jest.fn(async selected => selected.map(group => group.duration))
    });
    vm.runInContext(source.slice(source.indexOf('nativeVideo.ensureExportDurations ='),
        source.indexOf('\nfunction initNativeVideoPlayback()')), context);
    return context;
}

test('full remote range ends at actual final frame after all selected durations refine', async () => {
    const c = durationFixture([3, 3, 3]);
    expect(await c.nativeVideo.ensureExportDurations(0, 180)).toEqual({ startSec: 0, endSec: 9 });
    expect(c.nativeVideo.cumulativeStarts).toEqual([0, 3, 6, 9]);
    expect(c.probeSegmentDurations.mock.calls.map(([groups]) => groups[0].id)).toEqual([0, 1, 2]);
});

test('partial source markers stay on selected source rather than newly overlapping estimates', async () => {
    const c = durationFixture([60, 30, 12, 60]);
    expect(await c.nativeVideo.ensureExportDurations(100, 110)).toEqual({ startSec: 90, endSec: 90 });
    expect(c.probeSegmentDurations.mock.calls.map(([groups]) => groups[0].id)).toEqual([1]);
});

test('partial multi-source range preserves offsets and validates every exported overlap only', async () => {
    const c = durationFixture([60, 30, 20, 60]);
    const range = await c.nativeVideo.ensureExportDurations(70, 135);
    expect(range).toEqual({ startSec: 70, endSec: 105 });
    const overlaps = c.state.collection.active.groups.filter((_, i) =>
        c.nativeVideo.cumulativeStarts[i] < range.endSec &&
        c.nativeVideo.cumulativeStarts[i + 1] > range.startSec).map(group => group.id);
    expect(overlaps).toEqual([1, 2]);
    expect(c.probeSegmentDurations.mock.calls.map(([groups]) => groups[0].id)).toEqual(overlaps);
});

test('exact selected source boundaries follow actual source end without probing neighbors', async () => {
    const c = durationFixture([60, 3, 60]);
    expect(await c.nativeVideo.ensureExportDurations(60, 120)).toEqual({ startSec: 60, endSec: 63 });
    expect(c.probeSegmentDurations.mock.calls.map(([groups]) => groups[0].id)).toEqual([1]);
});
