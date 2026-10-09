# Optional manual image correction

The simple Export Video dialog has a separate **Manual image correction** section.
It starts off whenever a new export dialog session opens. Enable it explicitly,
adjust the sliders, and export a separate copy. Reset turns it off and restores
neutral values. Nothing is saved back into camera recordings.

## Scope and limits

- Brightness ±0.08; gamma 0.8–1.2; contrast 0.85–1.15; saturation 0.8–1.2.
- Red, green and blue midtone balance ±0.08, preserving lightness.
- Optional mild denoise (0–1) and luma sharpening (0–0.3). Both default to zero.
- Main-process validation clamps numeric settings and rejects arbitrary filter expressions.
- Disabled and enabled-neutral settings add no filters at all.
- Corrections run once on each real camera stream before resizing, privacy masks,
  dashboard, map and timestamp overlays. Empty camera tiles stay black.
- The existing export encoder and quality selection are retained; there is no
  additional intermediate video encode. Use High or Maximum for a review copy.
- Direct, symlink and hard-link output aliases of supplied source recordings are
  rejected before export starts, including when correction is disabled.

Player/layout previews do **not** show these adjustments. Export a short section
first and compare that actual output with the original. There is no simulated
CSS before/after preview. Controls are currently English-only and available only
in the simple export modal; they are not carried into the Advanced Editor.

These are generic FFmpeg adjustments, not a verified Tesla/HW3 correction LUT.
No real recording was supplied for calibration. Denoise can erase details and
sharpening can add halos; correction cannot reconstruct a missing plate or lost
detail, and makes no claim about legal admissibility. It adds no AI processing,
frame interpolation or stabilization. Existing export frame-rate handling is
unchanged. Preserve originals separately and disclose adjustments when sharing.

## Validation

Run `npm test -- --runInBand`. The synthetic-render tests use an installed
`ffmpeg` (or `FFMPEG_TEST_PATH`) and are skipped if none is available. They check
exact unfiltered pixel parity when off/neutral and rendering at bounded endpoints.
Unit tests cover normalization, filter construction, source-file protection and
control enable/reset/reopen behavior. Real vehicle footage and packaged macOS /
Windows playback still need manual validation. Synthetic tests exercise the
filter primitives, not the complete Electron export workflow or every composed
layout/overlay combination.

Filter references: [eq](https://ffmpeg.org/ffmpeg-filters.html#eq),
[colorbalance](https://ffmpeg.org/ffmpeg-filters.html#colorbalance),
[hqdn3d](https://ffmpeg.org/ffmpeg-filters.html#hqdn3d),
[unsharp](https://ffmpeg.org/ffmpeg-filters.html#unsharp).
