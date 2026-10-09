# Read-only rclone recordings (draft MVP)

Use **Open rclone** at the bottom left. Sentry Studio uses the `rclone` executable
on this computer's PATH and its existing configured remotes. Install/configure
rclone yourself using https://rclone.org/install/ and
https://rclone.org/commands/rclone_config/ . Restart the app after installation.
A macOS/Windows GUI launch can have a different PATH from your terminal.
The app neither installs rclone nor requests/stores your cloud credentials.

1. Select a configured remote, then navigate through folders.
2. Choose one event folder containing TeslaCam-named MP4 recordings, or a small
   RecentClips folder. Review the listed filenames and sizes.
3. **Download and open this folder** downloads only that folder's supported clips
   and event metadata. It does not recurse. Cancellation stops the transfer.
4. Existing local playback, seeking, multi-camera views and export consume the
   completed snapshot. Export needs no further cloud download. Partial files
   never enter the library. Original video basenames are retained for capture
   time parsing, regardless of the randomized parent cache directory.

SentryClips/YYYY-MM-DD_HH-MM-SS and SavedClips/YYYY-MM-DD_HH-MM-SS wrappers,
event.json, event.png and thumb.png are retained. Other folders load as loose
clips; event categories and event metadata are not inferred for arbitrary paths.

## Bounds and privacy

- Only `listremotes`, non-recursive `lsjson`, and `cat` are invoked, with argv and
  no shell. No remote deletion, upload, copy/sync, mount, RC/HTTP server, config
  editing or authorization flow is exposed. Normal provider token refresh by
  the user's existing rclone configuration may still occur.
- 2 GiB maximum complete snapshots per app session, including repeated opens.
  No eviction while playback/export may reference a snapshot. Close/restart
  the app to reclaim the session cache; other opened local media is unaffected.
- Private random temp directory, exclusive file creation, portable path checks,
  fixed filename allowlist, one operation at a time, and byte-limited transfers.
  At least 128 MiB disk headroom is checked before downloading. Disk-full errors
  abort and discard the incomplete snapshot. Each CLI operation times out after
  ten minutes. Listings are limited to 4 MiB and 10,000 entries.
- Clips whose advertised size changes during transfer are rejected. This is not
  a cryptographic snapshot guarantee: pause uploads to a folder before opening it.
- Backend stderr is not sent to the renderer or diagnostic logs because it may
  contain signed URLs or credentials. Check failures yourself in rclone.
- Cache is removed at normal app exit. An OS crash or forced kill can leave a
  `sentry-rclone-*` directory in the OS temp folder; remove stale directories only
  after all Sentry Studio instances have exited. OS temp cleanup also applies.
- Names unsupported on Windows, case-colliding names, and one-character remote
  names (drive-letter ambiguity) are rejected. Rename/configure these in rclone
  outside the app if needed.

## Explicit limits / verification

This MVP requires rclone on the app computer. It does not connect to rclone
running on a Raspberry Pi, expose an RC endpoint, recursively index a whole
archive, stream before download, or integrate SentryUSB drive-data.json.
Downloads can incur provider bandwidth/egress costs.

Automated tests cover mock CLI failures, traversal/collision checks, limits,
cancellation, IPC sender checks and cache cleanup. A real installed-rclone test
uses an isolated **local** backend and synthetic recordings, never user cloud
credentials. That integration test skips when rclone is unavailable. Real cloud
providers and packaged macOS/Windows playback require manual verification.
