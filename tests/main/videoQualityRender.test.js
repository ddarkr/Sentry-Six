// Optional integration check: uses the installed FFmpeg, never downloads a binary.
const { spawnSync } = require('child_process');
const { LIMITS, buildQualityFilter } = require('../../src/main/videoQuality');
const ffmpeg = process.env.FFMPEG_TEST_PATH || 'ffmpeg';
const available = spawnSync(ffmpeg, ['-version']).status === 0;
const integration = available ? describe : describe.skip;

integration('FFmpeg synthetic quality rendering', () => {
  function render(filter) {
    const result = spawnSync(ffmpeg, [
      '-hide_banner', '-loglevel', 'error', '-filter_threads', '1',
      '-f', 'lavfi', '-i', 'testsrc2=size=128x96:rate=6:duration=0.5',
      '-vf', filter || 'null', '-frames:v', '3', '-pix_fmt', 'yuv420p', '-f', 'framemd5', '-'
    ], { encoding: 'utf8', timeout: 15000 });
    if (result.status !== 0) throw new Error(result.stderr || String(result.error));
    return result.stdout.split('\n').filter(line => line && !line.startsWith('#')).join('\n');
  }

  test('off and enabled-neutral match unfiltered pixels exactly', () => {
    const original = render('');
    expect(render(buildQualityFilter({ enabled: false, brightness: 0.08, denoise: 1 }))).toBe(original);
    expect(render(buildQualityFilter({ enabled: true }))).toBe(original);
  });

  test.each([0, 1])('all bounded endpoints %i render, change pixels and keep three frames', endpoint => {
    const settings = { enabled: true };
    for (const [key, limits] of Object.entries(LIMITS)) settings[key] = limits[endpoint];
    const output = render(buildQualityFilter(settings));
    expect(output.split('\n')).toHaveLength(3);
    expect(output).not.toBe(render(''));
  });
});
