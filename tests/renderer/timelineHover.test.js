const fs = require('fs');
const path = require('path');
const vm = require('vm');

const context = vm.createContext({ window: { _timeFormat: '24h' } });
vm.runInContext(fs.readFileSync(path.join(__dirname, '../../src/renderer/scripts/ui/timeDisplay.js'), 'utf8')
    .replaceAll('export function ', 'function '), context);

const group = timestampKey => ({ timestampKey });
const state = {
    collection: { active: { groups: [group('2026-10-25_23-59-58'), group('2026-10-26_10-30-00')] } },
    ui: { nativeVideoMode: true }, library: { clipGroupById: new Map() }, selection: {}, player: {},
};

test('hover follows actual segment durations and filename times across recording gaps', () => {
    const native = { cumulativeStarts: [0, 4, 10] };
    expect(context.getTimelineHoverTime(state, native, 0)).toBe('23:59:58');
    expect(context.getTimelineHoverTime(state, native, 0.3)).toBe('00:00:01');
    expect(context.getTimelineHoverTime(state, native, 0.4)).toBe('10:30:00');
    expect(context.getTimelineHoverTime(state, native, 0.7)).toBe('10:30:03');
    expect(context.getTimelineHoverTime(state, native, 1)).toBe('10:30:06');
    context.window._timeFormat = '12h';
    expect(context.getTimelineHoverTime(state, native, 0.7)).toBe('10:30:03 AM');
    context.window._timeFormat = '24h';
    native.cumulativeStarts = [0, 2, 8];
    expect(context.getTimelineHoverTime(state, native, 0.25)).toBe('10:30:00');
});

test('unidentified recordings fall back to elapsed time and unavailable durations stay hidden', () => {
    const single = { ...state, collection: { active: null } };
    expect(context.getTimelineHoverTime(single, { master: { duration: 90 } }, 0.5)).toBe('00:45');
    expect(context.getTimelineHoverTime(single, { master: { duration: NaN } }, 0.5)).toBe('');
    expect(context.getTimelineHoverTime(state, { cumulativeStarts: [] }, 0.5)).toBe('');
});

test('frame and millisecond timelines retain their seek coordinate units', () => {
    const legacy = {
        ...state, ui: { nativeVideoMode: false },
        collection: { active: { groups: state.collection.active.groups, segmentStartsMs: [0, 4000], durationMs: 10000 } },
    };
    expect(context.getTimelineHoverTime(legacy, {}, 0.7)).toBe('10:30:03');
    legacy.collection.active = null;
    legacy.player = { frames: [{ timestamp: 0 }, { timestamp: 1500 }, { timestamp: 5000 }] };
    expect(context.getTimelineHoverTime(legacy, {}, 0.5)).toBe('00:01');
});
