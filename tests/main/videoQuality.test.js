const fs = require('fs');
const os = require('os');
const path = require('path');
const { LIMITS, normalizeQualityAdjustment, buildQualityFilter, assertOutputIsNotSource } = require('../../src/main/videoQuality');

describe('conservative quality filter', () => {
  test.each([undefined, null, {}, { enabled: false, brightness: 0.08 }, { enabled: 'true', sharpen: 0.3 }, { enabled: true }])('defaults and off are exact passthrough: %p', value => {
    expect(buildQualityFilter(value)).toBe('');
  });

  test('clamps every finite setting and rejects non-numeric input', () => {
    for (const [key, [min, max, neutral]] of Object.entries(LIMITS)) {
      expect(normalizeQualityAdjustment({ [key]: -999 })[key]).toBe(min);
      expect(normalizeQualityAdjustment({ [key]: 999 })[key]).toBe(max);
      for (const invalid of [NaN, Infinity, -Infinity, null, '1', '1,drawtext=text=bad', {}, true]) {
        expect(normalizeQualityAdjustment({ [key]: invalid })[key]).toBe(neutral);
      }
    }
  });

  test('only includes requested operations in a fixed order', () => {
    expect(buildQualityFilter({ enabled: true, brightness: 0.04, red: 0.02, denoise: 1, sharpen: 0.3 }))
      .toBe('eq=brightness=0.04:gamma=1:contrast=1:saturation=1,colorbalance=rm=0.02:gm=0:bm=0:pl=1,hqdn3d=1:0.75:1.5:1.125,unsharp=3:3:0.3:3:3:0');
    expect(buildQualityFilter({ enabled: true, sharpen: 0.1 })).toBe('unsharp=3:3:0.1:3:3:0');
  });

  test('rounds numeric values and does not mutate input', () => {
    const input = Object.freeze({ enabled: true, brightness: 0.0123456, arbitraryFilter: 'movie=/tmp/private' });
    expect(buildQualityFilter(input)).toBe('eq=brightness=0.012:gamma=1:contrast=1:saturation=1');
  });

  test('all three camera composition paths apply correction only to real video', () => {
    const main = fs.readFileSync(path.join(__dirname, '../../src/main.js'), 'utf8');
    expect(main.match(/if \(hasVideo && qualityFilter\) chain \+=/g)).toHaveLength(3);
    expect(main.indexOf('assertOutputIsNotSource(exportData.segments, exportData.outputPath)'))
      .toBeLessThan(main.indexOf('await performVideoExport(event, exportId, exportData, ffmpegPath)'));
  });
});

describe('original recording protection', () => {
  let dir;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sentry-quality-')); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  test('rejects direct, relative, symbolic and hard link aliases without touching source', () => {
    const source = path.join(dir, 'original.mp4');
    fs.writeFileSync(source, 'original bytes');
    const segments = [{ files: { front: source } }];
    const symlink = path.join(dir, 'symbolic.mp4');
    const hardlink = path.join(dir, 'hard.mp4');
    fs.symlinkSync(source, symlink);
    fs.linkSync(source, hardlink);
    for (const output of [source, path.relative(process.cwd(), source), symlink, hardlink]) {
      expect(() => assertOutputIsNotSource(segments, output)).toThrow('Original camera recordings');
    }
    expect(fs.readFileSync(source, 'utf8')).toBe('original bytes');
    expect(() => assertOutputIsNotSource(segments, path.join(dir, 'new.mp4'))).not.toThrow();
  });
});
