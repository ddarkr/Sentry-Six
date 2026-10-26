const fs = require('fs');
const path = require('path');
const vm = require('vm');

const source = file => fs.readFileSync(path.join(__dirname, '../../src/renderer/', file), 'utf8');
function node() {
    let text = '';
    const classes = new Set();
    return {
        writes: 0, style: {},
        get textContent() { return text; },
        set textContent(value) { text = String(value); this.writes++; },
        classList: {
            add(...names) { names.forEach(name => classes.add(name)); },
            remove(...names) { names.forEach(name => classes.delete(name)); },
            toggle(name, on) { if (on) classes.add(name); else classes.delete(name); },
            contains(name) { return classes.has(name); }
        }
    };
}
function visualization() {
    const names = ['speedValue', 'speedUnit', 'speedValueCompact', 'speedUnitCompact', 'gearState', 'gearStateCompact',
        'blinkLeft', 'blinkRight', 'blinkLeftCompact', 'blinkRightCompact', 'autosteerIcon', 'autosteerIconCompact',
        'apText', 'apTextCompact', 'brakeIcon', 'brakeIconCompact', 'accelPedal', 'accelPedalCompact', 'accelFill',
        'accelFillCompact', 'valSeq', 'valLat', 'valLon', 'valHeading'];
    const nodes = Object.fromEntries(names.map(name => [name, node()]));
    const dashboard = node(), compact = node();
    const c = vm.createContext({ ...nodes, state: { ui: { dashboardEnabled: true, mapEnabled: true, nativeVideoMode: true } },
        nativeVideo: { master: { currentTime: 1 }, seiParsedUntilMs: 2000, seiData: [], playing: false },
        videoMain: null, player: { frames: [], playing: false }, progressBar: { value: 0 },
        useMetric: true, MPS_TO_KMH: 3.6, MPS_TO_MPH: 2.236936,
        locale: 'en', t(key) { return `${c.locale}:${key}`; },
        findSeiAtTime: jest.fn(() => ({ vehicleSpeedMps: 10, gearState: 1, autopilotState: 1 })),
        resetDashboardElements: jest.fn(), stopSteeringAnimation: jest.fn(), smoothSteeringTo: jest.fn(),
        updateGForceMeter: jest.fn(), updateCompass: jest.fn(), updateMapMarker: jest.fn(), hasValidGps: jest.fn(),
        document: { getElementById: () => compact }, window: {}
    });
    const script = source('script.js');
    vm.runInContext(script.slice(script.indexOf('function refreshVisualization()'), script.indexOf('// Toggle Extra Data -')), c);
    vm.runInContext(source('scripts/ui/dashboardVisibility.js').replace(/^import .*;$/m, '').replaceAll('export function ', 'function '), c);
    c.initDashboardVisibility({ getDashboardVis: () => dashboard, getState: () => c.state, refresh: c.refreshVisualization });
    return { c, nodes, dashboard, compact };
}

test('map-only rendering skips dashboard helpers and writes, dashboard-only skips map', () => {
    const { c, nodes } = visualization();
    c.state.ui.dashboardEnabled = false;
    c.updateVisualization({ vehicleSpeedMps: 10 });
    expect(c.updateMapMarker).toHaveBeenCalled();
    expect(c.updateGForceMeter).not.toHaveBeenCalled();
    expect(c.updateCompass).not.toHaveBeenCalled();
    expect(c.smoothSteeringTo).not.toHaveBeenCalled();
    expect(nodes.speedValue.writes).toBe(0);
    c.updateMapMarker.mockClear();
    c.state.ui.dashboardEnabled = true;
    c.state.ui.mapEnabled = false;
    c.refreshVisualization();
    expect(nodes.speedValue.textContent).toBe('36');
    expect(c.updateMapMarker).not.toHaveBeenCalled();
    const writes = Object.values(nodes).reduce((sum, el) => sum + el.writes, 0);
    c.refreshVisualization();
    expect(Object.values(nodes).reduce((sum, el) => sum + el.writes, 0)).toBe(writes);
});

test('showing a paused dashboard restores current telemetry with current units and locale', () => {
    const { c, nodes, dashboard, compact } = visualization();
    c.refreshVisualization();
    c.state.ui.dashboardEnabled = false;
    c.updateDashboardVisibility();
    expect(dashboard.classList.contains('user-hidden')).toBe(true);
    expect(c.stopSteeringAnimation).toHaveBeenCalled();
    c.useMetric = false;
    c.locale = 'ko';
    c.findSeiAtTime.mockReturnValue({ vehicleSpeedMps: 20, autopilotState: 2 });
    c.window.dashboardLayout = 'compact';
    c.state.ui.dashboardEnabled = true;
    c.updateDashboardVisibility();
    expect(compact.classList.contains('visible')).toBe(true);
    expect(nodes.speedValueCompact.textContent).toBe('45');
    expect(nodes.speedUnitCompact.textContent).toBe('ko:ui.dashboard.mph');
    expect(nodes.apTextCompact.textContent).toBe('ko:ui.dashboard.autosteer');
    c.nativeVideo.master.currentTime = 3;
    c.refreshVisualization();
    expect(c.resetDashboardElements).toHaveBeenCalled();
});

function steering() {
    const icons = { steeringIcon: node(), steeringIconCompact: node() };
    let now = 0, id = 0;
    const frames = new Map();
    const c = vm.createContext({ document: { getElementById: name => icons[name] }, performance: { now: () => now },
        requestAnimationFrame: fn => { frames.set(++id, fn); return id; }, cancelAnimationFrame: key => frames.delete(key) });
    vm.runInContext(source('scripts/ui/steeringWheel.js').replaceAll('export function ', 'function '), c);
    let rate = 1;
    c.initSteeringWheel(() => rate);
    const tick = () => { now += 16; const callbacks = [...frames.values()]; frames.clear(); callbacks.forEach(fn => fn()); };
    const settle = () => { for (let i = 0; i < 100 && frames.size; i++) tick(); expect(frames.size).toBe(0); };
    return { c, icons, frames, tick, settle, setRate: value => { rate = value; } };
}

test('steering renders initially, stays idle when settled, and restarts changed or interrupted targets', () => {
    const { c, icons, frames, tick, settle, setRate } = steering();
    c.smoothSteeringTo(0);
    settle();
    expect(icons.steeringIcon.style.transform).toBe('rotate(0deg)');
    c.smoothSteeringTo(0);
    expect(frames.size).toBe(0);
    c.smoothSteeringTo(90);
    tick();
    const midway = icons.steeringIcon.style.transform;
    c.stopSteeringAnimation();
    expect(frames.size).toBe(0);
    c.smoothSteeringTo(90);
    expect(frames.size).toBe(1);
    setRate(2);
    tick();
    expect(icons.steeringIcon.style.transform).not.toBe(midway);
    settle();
    expect(icons.steeringIconCompact.style.transform).toBe('rotate(90deg)');
    c.smoothSteeringTo(90);
    expect(frames.size).toBe(0);
    c.smoothSteeringTo(-30);
    settle();
    expect(icons.steeringIcon.style.transform).toBe('rotate(-30deg)');
    c.resetSteeringWheel();
    expect(icons.steeringIcon.style.transform).toBe('rotate(0deg)');
    c.smoothSteeringTo(0);
    settle();
    expect(icons.steeringIconCompact.style.transform).toBe('rotate(0deg)');
});

test('steering tracking responds to playback-rate changes while running', () => {
    const normal = steering();
    const fast = steering();
    normal.c.smoothSteeringTo(90);
    fast.c.smoothSteeringTo(90);
    normal.tick();
    fast.tick();
    fast.setRate(2);
    normal.tick();
    fast.tick();
    const angle = fixture => Number(fixture.icons.steeringIcon.style.transform.match(/rotate\(([-\d.]+)deg\)/)[1]);
    expect(angle(fast)).toBeGreaterThan(angle(normal));
});
