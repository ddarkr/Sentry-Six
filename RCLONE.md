# Read-only remote recordings

Use the cloud button (**Remote folders**) beside the local-folder button in the
clip panel header. Sentry Studio uses the installed `rclone` executable and its
existing configuration. Manage connections under **Settings → Storage**.
If a GUI launch cannot find rclone on PATH, select its executable there.
Install rclone separately using https://rclone.org/install/; the app does not
install software automatically.

1. Select a configured remote, then navigate through folders.
2. Choose an event folder containing TeslaCam-named MP4 recordings, or a
   RecentClips folder. Review the listed filenames and sizes.
3. **Stream this folder** builds a manifest of supported clips and event metadata
   in that folder, without recursion or a complete-folder download.
4. Playback and seeking read remote byte ranges as needed. There is no 2 GiB
   playback-folder gate and no persistent offline recording cache. Original video
   basenames remain available for capture-time parsing.

Durations are loaded on demand; timeline positions and total duration can be
approximate until the relevant clip metadata is read. Telemetry reads only the
current or explicitly requested master clip, but may read that entire clip
incrementally to extract SEI data. Streaming is not a promise of minimal upstream
traffic: video buffering, telemetry and repeated seeks can transfer extra bytes.

During remote playback, the line below the timeline distinguishes loading,
buffering, seeking, readiness and playback errors. Buffered-ahead seconds are
the minimum contiguous media time available at the current position across
the active cameras, not download progress or a network-speed estimate. Gaps,
missing camera files and previous sources are not counted. The indicator resets
on source changes and is hidden for local playback.
Light gray regions on the seek bar show the buffered intervals shared by all
active cameras, positioned within the full collection timeline. Unbuffered gaps
stay dark. Only buffers still held by the current media elements are shown;
switching segments or sources clears the previous regions.

Export stages only the original files needed for the selected range and cameras
in a private temporary directory, then removes them after success, cancellation
or failure. The combined selected originals must fit within 2 GiB, with at least
128 MiB free disk headroom beyond their size. Even a short export can need a
complete original segment; the limit is not the encoded output size.

The centered picker follows the app language and keeps long paths and file lists
inside the window. Errors show a short message with expandable details; refresh
retries the remote list. Escape or **Close** dismisses the picker and returns focus.

Google Drive folders are selected by their IDs, not by their names. Same-name
folders remain separate rows with ID suffixes, and Parent follows the selected
navigation history. Refreshing remotes or returning from settings starts at the
root so references from a previous connection are not reused.

SentryClips/YYYY-MM-DD_HH-MM-SS and SavedClips/YYYY-MM-DD_HH-MM-SS wrappers,
event.json, event.png and thumb.png are retained. Other folders load as loose
clips; event categories and event metadata are not inferred for arbitrary paths.

## Connection settings

Existing remotes appear without registration. A listed remote starts unchecked;
the connection check reads its root folder before marking it usable. It does not
upload or delete files. Root checks and folder listings allow up to two minutes
and use rclone's existing backoff with up to five low-level attempts per request.
Google request-quota errors are reported separately from authentication errors;
signing in again does not clear a provider quota. Cancel remains available.

Google Drive connections use a personal Google Cloud OAuth client. Under
**Add Google Drive**, enter its **Client ID** and **Client secret**, then choose
**Sign in with browser**. New connections request `drive.readonly`; there is no
fallback to rclone's shared client. On an existing editable Drive connection,
**Personal OAuth settings** applies a new client and starts browser sign-in.
Ordinary **Reconnect** retains the configured client. Both paths preserve the
existing scope, root folder and Shared Drive selection.

Create the client outside the app at https://console.cloud.google.com/apis/credentials:
enable the Google Drive API and choose **Desktop app** as the OAuth application
type. Configure consent for `drive.readonly`. An external app in **Testing** must
include your account as a test user, and its refresh tokens expire after seven
days; publish the app for long-lived use. See
https://rclone.org/drive/#making-your-own-client-id for the Cloud setup steps.
A personal client has its own project quota; it does not remove Google's limits.

Other providers remain available for browsing and connection checks; manage
their authentication with rclone. Authentication-required errors link to
connection management rather than requiring a terminal command.

Configuration seeds the validated client fields in a private temporary copy,
then uses rclone's JSON `config update` protocol. A client change clears the
draft's old token and service-account authentication before browser sign-in;
it cannot pass verification using the previous account's token. The app verifies
access, checks for intervening changes, then atomically replaces the original
file. A detected conflict, failed verification or cancellation does not publish
the draft. Do not edit the same configuration in another process during
authentication: independent writers do not share an atomic compare-and-swap lock.
Only one app operation runs at a time.

**Remove connection** requires confirmation and removes only the selected entry
from the shared local rclone configuration, including for other apps using that
file. It does not delete cloud files or revoke account permissions. Removal also
works without valid cloud credentials. It runs `config delete` on a private copy,
checks that the target is gone and other connections remain, then uses the same
conflict check and atomic replacement. Environment-managed connections cannot
be removed here; change their environment configuration instead.

Encrypted, read-only, symlinked and environment-overridden configurations cannot
be edited here. The app reports the limitation instead of overwriting them.
Browser authentication expires after ten minutes; cancel or close settings to
stop it. Browser sign-in alone is not reported as a verified connection.


## Bounds and privacy

- Recordings remain read-only: no remote deletion, upload, sync or mount.
  Commands use argv without a shell. Local connection changes are explicit.
  `rc --loopback` reads local rclone metadata without starting an RC server.
  OAuth uses rclone's temporary loopback callback listener.
- Playback uses two loopback-only HTTP listeners: an authenticated, read-only
  rclone server with VFS disk caching disabled, and an app gateway exposing only
  manifest-listed files through random session-scoped capability URLs. The gateway
  permits GET/HEAD (and CORS preflight), rejects foreign web origins, and supports
  byte ranges. These URLs are credentials; do not share them. Opening a replacement
  remote source or shutting down revokes the previous session.
- There is no full-folder byte limit for playback. Listings remain limited to
  4 MiB and 10,000 entries; root checks and listings time out after two minutes.
  Export staging alone has the 2 GiB selected-originals limit. Transfers are
  byte-limited to the manifest sizes; incomplete staged files never reach FFmpeg.
- Portable path checks, a fixed filename allowlist and private temporary files
  restrict what can be served or staged. Advertised-size inconsistencies are
  rejected, but this is not a cryptographic snapshot guarantee: pause uploads to
  a folder before opening it. Same-size remote changes cannot be ruled out.
- Backend stderr is classified into safe error codes, never sent to the renderer
  or logs. Existing OAuth tokens and configuration credentials are not read back
  into the renderer. Submitted Client ID/secret values are transient form input,
  cleared on submission, cancellation or closing settings, and never saved in
  app preferences or localStorage. They reach rclone through the private draft,
  not command-line arguments or environment variables. rclone retains the
  verified credentials in its own configuration.
- Authentication drafts can contain credentials from the existing configuration.
  They use private directories and mode `0600` files, and are removed on success,
  cancellation, failure and normal exit. Export staging is removed after use.
  A crash or forced kill can leave `sentry-rclone-*` directories in the OS temp
  folder, including authentication drafts. Remove stale directories only after
  all Sentry Studio instances have exited; OS temp cleanup also applies.
- Google Drive directory IDs are accepted only from a listing for the selected
  remote. Names are display labels, not local staging paths. Other providers use
  validated relative paths and cannot distinguish identical directory names;
  configure Google Drive directly rather than through an alias for ID browsing.
  One-character remote names remain unsupported because of drive-letter ambiguity.
- Unrelated duplicate filenames do not block browsing. Only selected recording
  and event files are checked for portable names and case-insensitive collisions
  before streaming starts. Google Drive copies with matching sizes and valid,
  matching stored MD5 checksums are represented once in the playback manifest;
  originals are never modified or deleted. Hashes are requested when opening,
  not browsing, and do not require downloading videos. Conflicting copies or
  copies without checksums still block opening. Other providers retain the
  collision check without reading whole files to calculate hashes. rclone serves
  files by name, even when their parent Drive folder is ID-scoped.

## Explicit limits / verification

This browser requires rclone on the app computer and an internet connection for
cloud playback. It does not connect to rclone running on a Raspberry Pi, expose
an RC endpoint, recursively index a whole archive, or integrate SentryUSB
drive-data.json. Provider quotas, network latency and bandwidth/egress charges
still apply. There is no persistent offline playback copy.

The scoped streaming snapshot passed 17 suites / 211 tests. Backend checks with
the installed rclone CLI opened a local manifest over 3 GiB without downloading
the folder, checked range responses (206/416), origin and method restrictions,
unknown-file rejection, selected export staging and cleanup/cancellation, the
2 GiB export limit, source replacement revocation and shutdown. An authenticated
Google Drive folder with 80 recordings (2,617,398,463 bytes) opened without a
whole-folder download and returned HEAD 200 and a 64 KiB range response (206).
These checks prove the backend transport behavior, not upstream prefetch volume,
which has not been measured.

A real Drive folder containing 1,211 recordings, including five identical
duplicate pairs, opened as 1,206 unique recordings after checksum verification.
All five formerly blocked names returned 64 KiB range responses (206); a
mid-file range and FFmpeg decoding of one video frame also passed. This duplicate
handling check exercised the backend, not the running application's UI.

An isolated Electron run with synthetic recordings verified four-camera streamed
playback and synchronized seeking, event metadata and thumbnail reads, read-only
deletion protection, Advanced Editor video loading and an origin-clean blur
preview canvas. A two-second H.264 export staged only the selected front-camera
source and removed its staging directory after completion. Real-rclone checks
also verified cancellation after transfer data arrived, release during an active
listing, and startup with inherited logging overrides.
Bandwidth-limited rclone playback also verified the buffering status transitions,
minimum buffered-ahead value, cross-segment seek recovery, camera-specific
corrupt-media errors and hiding the indicator after switching to local files.
The English/Korean footer fit at 1384px and 1400px without increasing its height.

Packaged macOS/Windows playback, the native executable picker and complete
browser sign-in with a real personal OAuth client were not exercised in this
streaming verification.
