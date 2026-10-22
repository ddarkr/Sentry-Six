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
- 2 GiB maximum complete snapshots per app session, including repeated opens.
  No eviction while playback/export may reference a snapshot. Close/restart
  the app to reclaim the session cache; other opened local media is unaffected.
- Private random temp directory, exclusive file creation, portable path checks,
  fixed filename allowlist, one operation at a time, and byte-limited transfers.
  At least 128 MiB disk headroom is checked before downloading. Disk-full errors
  abort and discard the incomplete snapshot. Downloads time out after ten
  minutes; root checks and folder listings after two minutes. Listings are
  limited to 4 MiB and 10,000 entries.
- Clips whose advertised size changes during transfer are rejected. This is not
  a cryptographic snapshot guarantee: pause uploads to a folder before opening it.
- Backend stderr is classified into safe error codes, never sent to the renderer
  or logs. Existing OAuth tokens and configuration credentials are not read back
  into the renderer. Submitted Client ID/secret values are transient form input,
  cleared on submission, cancellation or closing settings, and never saved in
  app preferences or localStorage. They reach rclone through the private draft,
  not command-line arguments or environment variables. rclone retains the
  verified credentials in its own configuration.
- Authentication drafts can contain credentials from the existing configuration.
  They use private directories and mode `0600` files, and are removed on success,
  cancellation, failure and normal exit. Recording caches are removed at exit.
  A crash or forced kill can leave `sentry-rclone-*` directories in the OS temp
  folder, including authentication drafts. Remove stale directories only after
  all Sentry Studio instances have exited; OS temp cleanup also applies.
- Google Drive directory IDs are accepted only from a listing for the selected
  remote. Names are display labels, not local cache paths. Other providers use
  validated relative paths and cannot distinguish identical directory names;
  configure Google Drive directly rather than through an alias for ID browsing.
  One-character remote names remain unsupported because of drive-letter ambiguity.
- Unrelated duplicate filenames do not block browsing. Only selected recording
  and event files are checked for portable names and case-insensitive collisions
  before any download starts; ambiguous recording files are never overwritten.

## Explicit limits / verification

This browser requires rclone on the app computer. It does not connect to rclone
running on a Raspberry Pi, expose an RC endpoint, recursively index a whole
archive, stream before download, or integrate SentryUSB drive-data.json.
Downloads can incur provider bandwidth/egress costs.

Automated tests cover CLI failures, folder-reference isolation, same-name Drive
selection, download collisions, limits, cancellation, IPC sender checks, cache
cleanup, configuration conflicts and settings lifecycle races. Configuration
tests verify that failures and cancellation preserve existing credentials and
that drafts are checked before
publication. A real installed-rclone test uses an isolated **local** backend and
synthetic recordings, never user cloud credentials; it skips when rclone is
unavailable.

Development verification exercises real personal-client OAuth authorization
requests and cancellation without opening a browser or following the Google
redirect, plus Electron settings, folder return, download and playback with
isolated configuration. Read-only checks against an authenticated Google Drive
also verify root listing and separate ID-scoped access to same-name folders.
These checks do not exercise complete browser sign-in with a real personal
client, the native executable picker or packaged macOS/Windows playback.
