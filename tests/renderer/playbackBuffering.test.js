const fs = require('fs');
const path = require('path');
const vm = require('vm');
const context = vm.createContext({});
vm.runInContext(fs.readFileSync(path.join(__dirname, '../../src/renderer/scripts/ui/playbackBuffering.js'), 'utf8').replace(/export /g, ''), context);
const { bufferedAhead, bufferedTimelineRanges, bufferingState, createPlaybackBuffering } = context;
const ranges = values => ({ length: values.length, start: i => values[i][0], end: i => values[i][1] });
const ready = overrides => ({ seen: true, ready: true, paused: false, ahead: 4, ...overrides });

test('ahead stops at gaps and returns zero outside ranges or with invalid time', () => {
    const video = { currentTime: 4, buffered: ranges([[0, 6], [9, 20]]) };
    expect(bufferedAhead(video)).toBe(2);
    video.currentTime = 8;
    expect(bufferedAhead(video)).toBe(0);
    video.currentTime = NaN;
    expect(bufferedAhead(video)).toBe(0);
});

test('timeline shows only common camera ranges, preserving holes and collection offsets', () => {
    const videos = [
        { buffered: ranges([[0, 10], [20, 40]]) },
        { buffered: ranges([[5, 25], [30, 50]]) }
    ];
    expect(bufferedTimelineRanges(videos, { offset: 60, duration: 100, segmentDuration: 40 }))
        .toEqual([[65, 70], [80, 85], [90, 100]]);
    expect(bufferedTimelineRanges([...videos, { buffered: ranges([]) }],
        { offset: 60, duration: 100, segmentDuration: 40 })).toEqual([]);
    expect(bufferedTimelineRanges([{ buffered: ranges([[10, 15]]) }],
        { offset: 60, duration: 100, segmentDuration: 40 })).toEqual([[70, 75]]);
});

test('timeline clips ranges to segment bounds and rejects unknown durations', () => {
    const videos = [{ buffered: ranges([[-5, 90]]) }];
    expect(bufferedTimelineRanges(videos, { offset: 20, duration: 100, segmentDuration: 30 }))
        .toEqual([[20, 50]]);
    expect(bufferedTimelineRanges(videos, { offset: 80, duration: 100, segmentDuration: 30 }))
        .toEqual([[80, 100]]);
    for (const duration of [0, NaN, Infinity]) {
        expect(bufferedTimelineRanges(videos, { offset: 0, duration, segmentDuration: 30 })).toEqual([]);
    }
    expect(bufferedTimelineRanges([], { offset: 0, duration: 100, segmentDuration: 30 })).toEqual([]);
});

test('minimum includes missing current ranges and counts only registered cameras', () => {
    expect(bufferingState([ready(), ready({ ahead: 1.5 })]).ahead).toBe(1.5);
    expect(bufferingState([ready(), ready({ ahead: 0 })]).ahead).toBe(0);
    expect(bufferingState([ready()]).waiting).toBe(0);
});

test('initial loading, partial readiness, paused frames, seeking, errors and recovery differ', () => {
    expect(bufferingState([ready({ seen: false, ready: false })]).state).toBe('loading');
    expect(bufferingState([ready(), ready({ seen: false, ready: false })]).state).toBe('buffering');
    expect(bufferingState([ready({ waiting: true, paused: true })]).state).toBe('ready');
    expect(bufferingState([ready({ seeking: true })]).state).toBe('seeking');
    expect(bufferingState([ready({ seeking: true, error: {} })]).state).toBe('error');
    expect(bufferingState([ready({ waiting: true })]).state).toBe('buffering');
    expect(bufferingState([ready()]).state).toBe('ready');
});

function fixture() {
    const root = { hidden: true, dataset: {} };
    let announcements = 0;
    const status = { get textContent() { return this.text; }, set textContent(text) { this.text = text; announcements++; } };
    const detail = {};
    const listeners = {};
    const video = { src: 'remote-a', currentSrc: 'remote-a', readyState: 0, paused: false, seeking: false,
        error: null, currentTime: 0, buffered: ranges([]),
        addEventListener(event, listener) { (listeners[event] ||= new Set()).add(listener); },
        removeEventListener(event, listener) { listeners[event].delete(listener); } };
    const emit = type => [...(listeners[type] || [])].forEach(listener => listener({ type }));
    const controller = createPlaybackBuffering({ root, status, detail, cameraLabel: camera => camera,
        t: (key, values) => key + (key.endsWith('ahead') ? values.seconds : key.endsWith('error') ? values.cameras : '') });
    const register = (src = 'remote-a', active) => controller.setSources([{ video, src, camera: 'front' }], active);
    return { root, status, detail, video, emit, controller, register, listeners, announcements: () => announcements };
}

test('native events recover waiting and seek states without announcing time updates', () => {
    const f = fixture();
    f.register();
    expect(f.root.dataset.state).toBe('loading');
    f.emit('loadstart');
    f.video.readyState = 3;
    f.video.buffered = ranges([[0, 10]]);
    f.emit('canplay');
    expect(f.root.dataset.state).toBe('ready');
    const announcements = f.announcements();
    f.video.currentTime = 1;
    f.emit('timeupdate');
    expect(f.detail.textContent).toContain('9.0');
    expect(f.announcements()).toBe(announcements);
    f.video.readyState = 2;
    f.emit('waiting');
    expect(f.root.dataset.state).toBe('buffering');
    f.video.readyState = 3;
    f.emit('playing');
    expect(f.root.dataset.state).toBe('ready');
    f.video.seeking = true;
    f.emit('seeking');
    expect(f.root.dataset.state).toBe('seeking');
    f.video.seeking = false;
    f.emit('seeked');
    expect(f.root.dataset.state).toBe('ready');
    f.video.error = {};
    f.emit('error');
    expect(f.status.textContent).toContain('front');
});

test('download stalls with future frames stay ready and progress clears starvation', () => {
    const f = fixture();
    f.register();
    f.emit('loadstart');
    f.video.readyState = 4;
    f.video.buffered = ranges([[0, 10]]);
    f.emit('canplay');
    f.emit('stalled');
    expect(f.root.dataset.state).toBe('ready');
    f.video.readyState = 2;
    f.video.buffered = ranges([]);
    f.emit('waiting');
    expect(f.root.dataset.state).toBe('buffering');
    f.video.readyState = 4;
    f.video.buffered = ranges([[0, 10]]);
    f.emit('progress');
    expect(f.root.dataset.state).toBe('ready');
    f.video.readyState = 2;
    f.emit('progress');
    expect(f.root.dataset.state).toBe('ready');
});

test('source replacement discards old frames/events and reset removes every listener', () => {
    const f = fixture();
    f.register();
    f.emit('loadstart');
    f.video.readyState = 3;
    f.emit('canplay');
    f.register('remote-b');
    f.emit('playing');
    expect(f.root.dataset.state).toBe('loading');
    f.video.src = 'remote-b';
    f.emit('canplay'); // currentSrc still belongs to old source
    expect(f.root.dataset.state).toBe('loading');
    f.video.currentSrc = 'remote-b';
    f.emit('loadstart');
    f.emit('canplay');
    expect(f.root.dataset.state).toBe('ready');
    f.controller.reset();
    expect(f.root.hidden).toBe(true);
    expect(Object.values(f.listeners).every(listeners => listeners.size === 0)).toBe(true);
    f.controller.setSources([]);
    expect(f.root.hidden).toBe(true);
});

test('inactive collection and aborted waits do not leave stale buffering visible', () => {
    const f = fixture();
    let active = true;
    f.register('remote-a', () => active);
    f.emit('loadstart');
    f.video.readyState = 3;
    f.emit('canplay');
    f.emit('stalled');
    f.emit('abort');
    expect(f.root.dataset.state).toBe('ready');
    active = false;
    f.emit('progress');
    expect(f.root.hidden).toBe(true);
});
