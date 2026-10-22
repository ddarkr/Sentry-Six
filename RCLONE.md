# Read-only remote recordings

Use the cloud button (**Remote folders**) beside the local-folder button in the
clip panel header. Sentry Studio uses the installed `rclone` executable and its
existing configuration. Manage connections under **Settings → Storage**.
If a GUI launch cannot find rclone on PATH, select its executable there.
Install rclone separately using https://rclone.org/install/; the app does not
install software automatically.

1. Select a configured remote, then navigate through folders.
2. Choose one event folder containing TeslaCam-named MP4 recordings, or a small
   RecentClips folder. Review the listed filenames and sizes.
3. **Open this folder** downloads only that folder's supported clips and event
   metadata. It does not recurse. Cancellation stops the transfer.
4. Existing local playback, seeking, multi-camera views and export consume the
   completed snapshot. Export needs no further cloud download. Partial files
   never enter the library. Original video basenames are retained for capture
   time parsing, regardless of the randomized parent cache directory.

The centered picker follows the app language and keeps long paths and file lists
inside the window. Errors show a short message with expandable details; refresh
retries the remote list. Escape or **Close** dismisses the picker and returns focus.

SentryClips/YYYY-MM-DD_HH-MM-SS and SavedClips/YYYY-MM-DD_HH-MM-SS wrappers,
event.json, event.png and thumb.png are retained. Other folders load as loose
clips; event categories and event metadata are not inferred for arbitrary paths.

## Connection settings

Existing remotes appear without registration. A listed remote starts unchecked;
the connection check reads its root folder before marking it usable. It does not
upload or delete files. Root checks have a 30-second wall-clock timeout; large
roots may time out because a one-level listing can still fetch many entries.

Google Drive connections can be added or reauthenticated through the system
browser. New connections request `drive.readonly`; reconnecting preserves the
existing scope, client settings, root folder and Shared Drive selection. Other
providers remain available for browsing and connection checks; manage their
authentication with rclone. Authentication-required errors link to connection
management rather than requiring a terminal command.

Configuration uses rclone's JSON `config create/update` protocol. It runs against
a private temporary copy, verifies access, checks for intervening changes, then
atomically replaces the original file. A detected conflict, failed verification
or cancellation does not publish the draft. Do not edit the same configuration
in another process during authentication: independent writers do not share an
atomic compare-and-swap lock. Only one app operation runs at a time.

Encrypted, read-only, symlinked and environment-overridden configurations cannot
be edited here. The app reports the limitation instead of overwriting them.
Browser authentication expires after ten minutes; cancel or close settings to
stop it. Browser sign-in alone is not reported as a verified connection.


## Bounds and privacy

- Recordings remain read-only: no remote deletion, upload, sync or mount.
  Commands use argv without a shell. Local connection changes are explicit.
  `rc --loopback` reads local rclone metadata without starting an RC server.
  OAuth uses rclone's temporary loopback callback listener.
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
- Backend stderr is classified into safe error codes, never sent to the renderer
  or logs. OAuth tokens and configuration contents do not enter the renderer or
  the app's preferences. rclone retains credentials in its own configuration.
- Authentication drafts can contain credentials from the existing configuration.
  They use private directories and mode `0600` files, and are removed on success,
  cancellation, failure and normal exit. Recording caches are removed at exit.
  A crash or forced kill can leave `sentry-rclone-*` directories in the OS temp
  folder, including authentication drafts. Remove stale directories only after
  all Sentry Studio instances have exited; OS temp cleanup also applies.
- Names unsupported on Windows, case-colliding names, and one-character remote
  names (drive-letter ambiguity) are rejected. Rename/configure these in rclone
  outside the app if needed.

## Explicit limits / verification

This browser requires rclone on the app computer. It does not connect to rclone
running on a Raspberry Pi, expose an RC endpoint, recursively index a whole
archive, stream before download, or integrate SentryUSB drive-data.json.
Downloads can incur provider bandwidth/egress costs.

Automated tests cover CLI failures, traversal/collision checks, limits,
cancellation, IPC sender checks, cache cleanup, configuration conflicts and
settings lifecycle races. Configuration tests verify that failures and
cancellation preserve existing credentials and that drafts are checked before
publication. A real installed-rclone test uses an isolated **local** backend and
synthetic recordings, never user cloud credentials; it skips when rclone is
unavailable.

Development verification also exercises real OAuth callback waiting and
cancellation without opening a browser, plus Electron settings, folder return,
download and playback with isolated configuration. This does not verify a
completed Google sign-in. Real cloud authorization, the native executable
picker and packaged macOS/Windows playback still require manual verification.
