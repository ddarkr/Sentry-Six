const fs = require('fs');
const path = require('path');
const vm = require('vm');
const context = vm.createContext({ atob, console });
vm.runInContext(fs.readFileSync(path.resolve(__dirname, '../../src/renderer/scripts/core/driveGrouper.js'), 'utf8')
  .replaceAll('export function ', 'function '), context);
const group = Routes => context.groupStoreDataIntoDrives({ Routes });
const File = '2024-01-15_10-30-00-front.mp4';
const runs = [{ Gear: 1, Frames: 30 }, { Gear: 0, Frames: 10 }, { Gear: 1, Frames: 20 }];

test('empty, invalid, and mixed filenames produce only valid drives', () => {
  for (const routes of [[], [{ File: 'invalid' }], [{}], [{ File: 12 }]]) {
    expect(group(routes)).toEqual({ drives: [], driveCount: 0, routeCount: 0 });
  }
  const result = group([{ File: 'invalid' }, { File }]);
  expect(result.routeCount).toBe(1);
  expect(result.drives[0].durationMs).toBe(60000);
});

test.each([false, true])('split bounds survive with GPS=%s', gps => {
  const Points = gps ? Array.from({ length: 60 }, (_, i) => [37 + i / 10000, -122]) : [];
  const { drives } = group([{ File, Points, GearRuns: runs }]);
  expect(drives.map(d => d.durationMs)).toEqual([30000, 20000]);
  expect(drives[1].startMs - drives[0].startMs).toBe(40000);
  expect(drives[1].endMs - drives[0].startMs).toBe(60000);
  expect(drives.map(d => d.pointCount)).toEqual(gps ? [30, 20] : [0, 0]);
});

test('sparse GPS does not discard a timed split segment', () => {
  const { drives } = group([{ File, Points: [[37, -122]], GearRuns: runs }]);
  expect(drives.map(d => d.durationMs)).toEqual([30000, 20000]);
  expect(drives.reduce((n, d) => n + d.pointCount, 0)).toBe(1);
});

test('second split preserves lowercase/base64 parallel fields and accel grace cadence', () => {
  const points = Array.from({ length: 60 }, (_, i) => [37 + i / 10000, -122]);
  const accel = Array(60).fill(0);
  // Two seconds into the second segment: ignored; four seconds: counted.
  accel[42] = 0.5;
  accel[44] = 0.5;
  const { drives } = group([{ file: File, points, gearRuns: runs.map(r => ({ gear: r.Gear, frames: r.Frames })),
    autopilotStates: Buffer.from(Array(60).fill(1)).toString('base64'),
    gearStates: Buffer.from(Array(60).fill(1)).toString('base64'),
    speeds: Array(60).fill(12), accelPositions: accel }]);
  expect(drives[1].accelPushCount).toBe(1);
  expect(drives[1].fsdPercent).toBe(100);
  expect(drives[1].points[0][3]).toBe(12);
});

test('split sample cadence honors the two-second Park disengagement grace', () => {
  const Points = Array.from({ length: 120 }, (_, i) => [37 + i / 10000, -122]);
  const AutopilotStates = Array(120).fill(1);
  const GearStates = Array(120).fill(1);
  // Within the second segment disengage, then Park one second later.
  AutopilotStates.fill(0, 90);
  GearStates[92] = 0;
  const { drives } = group([{ File, Points, GearRuns: runs, AutopilotStates, GearStates }]);
  expect(drives[1].fsdDisengagements).toBe(0);
});

test('multiple Park gaps retain each segment original bounds', () => {
  const { drives } = group([{ File, GearRuns: [
    { Gear: 1, Frames: 10 }, { Gear: 0, Frames: 5 }, { Gear: 1, Frames: 15 },
    { Gear: 0, Frames: 10 }, { Gear: 1, Frames: 20 },
  ] }]);
  expect(drives.map(d => d.durationMs)).toEqual([10000, 15000, 20000]);
  expect(drives.map(d => d.startMs - drives[0].startMs)).toEqual([0, 15000, 40000]);
});
