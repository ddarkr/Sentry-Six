const fs = require('fs');
const path = require('path');
const vm = require('vm');
const context = vm.createContext({ atob, console });
vm.runInContext(fs.readFileSync(path.resolve(__dirname, '../../src/renderer/scripts/core/driveGrouper.js'), 'utf8')
  .replaceAll('export function ', 'function '), context);
const group = Routes => context.groupStoreDataIntoDrives({ Routes });
const File = '2024-01-15_10-30-00-front.mp4';
const runs = [{ Gear: 1, Frames: 30 }, { Gear: 0, Frames: 10 }, { Gear: 1, Frames: 20 }];

test('grouped and split drives preserve original route file references', () => {
  const original = 'TeslaCam/SavedClips/2024-01-15/' + File;
  const Points = Array.from({ length: 60 }, (_, i) => [37 + i / 10000, 127]);
  const split = group([{ file: original, Points, GearRuns: runs }]);
  expect(split.drives.map(drive => Array.from(drive.routeFiles))).toEqual([[original], [original]]);
  const second = '2024-01-15/' + File.replace('10-30-00', '10-31-00');
  expect(Array.from(group([{ File: original }, { file: second }]).drives[0].routeFiles)).toEqual([original, second]);
});
