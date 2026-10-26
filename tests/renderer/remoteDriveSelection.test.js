const fs = require('fs');
const path = require('path');
const vm = require('vm');
const source = fs.readFileSync(path.join(__dirname, '../../src/renderer/script.js'), 'utf8');

function setup() {
    const dataPath = 'http://127.0.0.1:1234/sentry-rclone/' + 'a'.repeat(64) + '/drive-data.json';
    let finish;
    const context = vm.createContext({
        state: { sentryUsb: { dataPath, hasFootage: new Set([1]) } },
        library: { clipGroups: [{ timestampKey: '2026-10-09_12-30-00' }] },
        folderStructure: null, driveList: { setAttribute() {}, removeAttribute() {} },
        isRcloneStreamUrl: value => typeof value === 'string' && value.startsWith('http://127.0.0.1:'),
        matchClipsTodrives: () => new Set([1]),
        window: { electronAPI: { rcloneOpenDriveFootage: () => new Promise(resolve => { finish = resolve; }) } },
        localStorage: { getItem() {} },
        SHOW_FSD_EVENTS_KEY: 'showFsdEvents',
        getState() {}, getUseMetric() {}, useMetric: true, showDriveStats: true,
        notify: jest.fn(), selectDriveCollection: jest.fn(),
        openRemoteRecordingManifest: async manifest => { context.library.clipGroups = manifest.groups; },
        initDriveBrowser: deps => { context.selectDrive = deps.onDriveSelected; }
    });
    vm.runInContext(source.slice(source.indexOf('let openingRemoteDrive ='), source.indexOf('\nconst settingsShowDriveStats')), context);
    return { context, resolve: value => finish(value) };
}

test('an unrelated loaded clip does not claim footage for remote drive data', () => {
    const { context: c } = setup();
    expect([...c.matchLoadedDriveFootage([{ id: 1 }])]).toEqual([]);
});

test('missing remote footage leaves the existing library untouched instead of playing a timestamp match', async () => {
    const { context: c, resolve } = setup();
    const existing = c.library.clipGroups;
    const pending = c.selectDrive({ id: 1, date: '2026-10-09', routeFiles: ['RecentClips/2026-10-09_12-30-00-front.mp4'] });
    resolve({ ok: true, data: null });
    await pending;
    expect(c.library.clipGroups).toBe(existing);
    expect(c.selectDriveCollection).not.toHaveBeenCalled();
});

test('replacing the drive JSON while locating footage discards the late selection', async () => {
    const { context: c, resolve } = setup();
    const existing = c.library.clipGroups;
    const pending = c.selectDrive({ id: 1, routeFiles: ['RecentClips/2026-10-09_12-30-00-front.mp4'] });
    c.state.sentryUsb.dataPath = '/local/replacement.json';
    resolve({ ok: true, data: { groups: [{ timestampKey: 'obsolete' }] } });
    await pending;
    expect(c.library.clipGroups).toBe(existing);
    expect(c.selectDriveCollection).not.toHaveBeenCalled();
});
