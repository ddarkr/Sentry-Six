<h1 align="center">Sentry Drive</h1>

<p align="center">
  <strong>All in one beautiful app.</strong><br>
  View all six cameras simultaneously. Visualize SEI telemetry data. Export clips with hardware acceleration.
</p>

<p align="center">
  <a href="https://github.com/Sentry-Six/Sentry-Six/releases/latest"><img alt="Latest release" src="https://img.shields.io/github/v/release/Sentry-Six/Sentry-Six"></a>
  <a href="https://discord.gg/9QZEzVwdnt"><img alt="Discord" src="https://img.shields.io/badge/Discord-join-5865F2?logo=discord&logoColor=white"></a>
  <a href="LICENSE"><img alt="License" src="https://img.shields.io/badge/License-MIT-yellow.svg"></a>
</p>

---

Sentry Studio by Sentry Six is a modern, feature‑rich viewer and exporter for your TeslaCam. View sentry and dashcam events with an easy-to-use UI! Trim and export your clips with ease with a variety of options - from camera layouts to a telemetry overlay. Use it on your preferred OS - Windows, MacOS, or Linux.

## Part of Sentry Six

Sentry Studio is one of four free tools for Tesla owners from the [Sentry Six](https://sentry-six.com) project:

| Tool | What it does |
| --- | --- |
| **Sentry Studio** (this repo) | Desktop TeslaCam viewer and clip exporter for Windows, macOS, and Linux |
| [Sentry USB](https://github.com/Sentry-Six/Sentry-USB-Rusty) | Raspberry Pi smart USB drive: drive and charge tracking, auto-archiving, BLE telemetry |
| [Sentry Drive](https://github.com/Sentry-Six/Sentry-Drive) | Desktop drive history and FSD analytics, processed locally |
| [Sentry Connect](https://sentry-six.com/sentry-connect/) | iPhone companion app for Sentry USB (App Store, iOS 17+) |

Not affiliated with Tesla, Inc. Unrelated to the Sentry (sentry.io) error-monitoring service and the "Sentry Studio" product at sentrystudio.app.

## Features
- **Simple UI**
  - Select your TeslaCam folder using the folder explorer
  - Select a default folder in the settings
  - Load clips from any folder - no Tesla USB structure needed
  - Easily browse files by date
  - Supports Recent, Sentry, and Saved Clips
  - Event Triggers (e.g. "Manual Save", "Sentry", "Honk", "Object Detected", etc.)
  - Delete folders/events with the trash icon in the Clip Browser

    <img width="176.5" height="275.5" alt="image" src="https://github.com/user-attachments/assets/1b2f3970-965b-431a-b1c9-073a7fd30800" />

- **Multi-Camera Playback**
  - View all cameras at once
    - Front, Back, B-Pillars (HW4/AI4+), Repeaters
  - Synced playback across all cameras
  - Focus on the details with speed controls, from half speed (0.5x) to 4x.
  - Hover over the playback bar to preview the recording time at that position without seeking; the tooltip follows your 12/24-hour time preference.
 
- **SEI Telemetry**
  - Visualize the car's actions
    - See data such as speed, gear, autopilot status, accelerator pedal position, and more
  - GPS Map with route visualization
    - See the path your car took during the clip
    - Route line changes color based on driving state (Blue for Self Driving, Gray for Manual)
    - Zoom in/out and pan around the map (right-click drag follows the pointer in both north-up and heading-up modes, including rotation transitions)
  - Choose between default and compact dashboard layouts
  - *Requirements for SEI Telemetry*
    - *2025.44.25 or newer*
    - *Hardware 3 (HW3/AI3) or newer*

  ![Dashboard](https://github.com/user-attachments/assets/6bc6ff11-0066-427f-b2ab-c95530eaa2e3)

- **Clip Exporting**
  - Trim clips with ease using in/out points
  - Selecting one camera fills the layout preview; selecting multiple cameras restores their draggable positions.
  - Hardware-accelerated encoding (NVIDIA, AMD, Intel QuickSync, Apple Silicon)
  - Pick different export qualities
    - Mobile, Medium, High, Maximum
  - Add the SEI overlay to your export
    - Compact dashboard overlays
    - Configurable dashboard size (Small to X-Large)
    - Overlay is pre-rendered for optimal performance
  - Add a GPS minimap to your export (Alpha)
  - Add a timestamp overlay with multiple date formats
  - Use blur zones to ensure privacy
  - Minimize the export modal and track progress via floating notification

- **Clip Sharing**
  - Generate a shareable link after exporting a clip
  - Clips are hosted on Sentry Studio servers for 48 hours at clip.sentry-six.com
  - Manage your shared clips from the "My Shared Clips" modal
    - Preview, copy link, open in browser, or delete shared clips
  - Available for exports under 5 minutes
 <img width="468.5" height="410" alt="Export Modal" src="https://github.com/user-attachments/assets/0bd241b7-34a3-43fe-b577-e81359cd538e" />

- **Customizable Settings**
  - Adjustable glass blur intensity
  - Toggle between metric or imperial measurements (Km/H or MPH)
  - Choose between 12-hour and 24-hour time formats
  - Customizable keyboard shortcuts with adjustable fast forward/backward duration
  - Event Highlights
    - See which camera was triggered, visualized with a yellow or red highlight
  <img width="260" height="406" alt="Settings Modal" src="https://github.com/user-attachments/assets/8eb489b6-2b4c-4f64-ad91-af48be6a686b" />

- **Multi-Language Support**
  - 13 languages supported: English, Spanish, French, German, Chinese (Simplified), Japanese, Korean, Portuguese, Russian, Italian, Dutch, Polish, and Turkish
  - Export overlays respect your language setting

- **Built-in Support Chat**
  - Get help directly within the app
  - Submit feedback, bug reports, and feature requests

- **Auto Update**
  - Checks for new updates on start up with a one-click install.
    - You can also check for updates via the settings

## Privacy & Updates

Update checks use GitHub directly (Mac App Store builds update through the App Store).
They do not generate device identifiers or send fingerprints, system information,
or version-usage statistics to the Sentry Six update API. Server-directed forced
manual updates are no longer supported.

Vehicle SEI telemetry, GPS maps, and export overlays remain available. Map tiles,
cloud storage, and user-initiated sharing and support still use their respective
network services.

📄 **[Privacy Policy](https://sentry-six.com/privacy)** · **[Terms of Service](https://sentry-six.com/terms)**

## Community & Support

Have questions, feedback, or want to connect with other users?

Join our [Discord Server](https://discord.com/invite/9QZEzVwdnt)!

## Requirements
- Windows 10+ (x64) / macOS 13+ (Intel or Apple Silicon) / Linux (x64 or arm64)

## Automatic Installation for Windows & MacOS (Recommended, easiest)
1. Go to the Sentry Studio [Releases](https://github.com/ChadR23/Sentry-Six/releases/) page
2. Download the SentryStudioSetup.exe (SentryStudio.dmg for MacOS) 
3. Run the installer
4. Run Sentry Studio

 <img width="245.5" height="96.5" alt="Screenshot_2026-01-02_at_1 17 05_PM" src="https://github.com/user-attachments/assets/81c21fef-6eb6-49c9-a0d3-75765eb32685" />


## Manual Installation

1. Install [Node.js](https://nodejs.org/en/download) 22.12.0 or later.
2. Extract Sentry Studio to your desired location.
3. Open a new Terminal (Command Prompt or Power Shell) and head to the Sentry Studio folder `cd C:\users\yourname\downloads\Sentry-Studio`
4. In your Sentry Studio folder, use the following command: `npm install`
6. To run Sentry Studio, use `npm start`

Alternatively, with pnpm 11, run `pnpm install` and `pnpm dev`. The repository's `pnpm-workspace.yaml` limits build-script approval to five reviewed dependencies; Electron 45 and protobufjs 8 no longer use postinstall scripts. Use one package manager per checkout to avoid moving packages between installation layouts.

Electron 45 downloads its executable on first use rather than during package installation. To download it before starting the app, run `pnpm exec install-electron` (or `npm exec -- install-electron`). The renderer's vendored protobuf browser bundle matches the installed protobufjs 8 runtime.

### Development checks

Run `npm test -- --runInBand` for the regression suite. CI runs it before packaging on Windows, macOS, and Linux. FFmpeg pixel-rendering checks use a locally installed `ffmpeg` (or `FFMPEG_TEST_PATH`) and are skipped when it is unavailable; they do not download binaries.

Run `node_modules/.bin/electron tests/renderer/mapPanning.smoke.cjs` for the isolated, hidden-window Leaflet drag check. It verifies both orientation modes at five headings, a mode transition, and mouse release using the production pan handlers.

## Usage

1. Launch the app
2. Select your **TeslaCam folder**
3. Pick a clip from the sidebar
4. Use the playback controls and in/out markers to select the part of the clip you'd like to export.

For cloud recordings, use **Remote folders** beside the local-folder button.
With [rclone installed and configured](RCLONE.md), **Stream this folder** opens
a read-only manifest and plays remote byte ranges without downloading the whole
folder first. There is no 2 GiB playback-folder limit. Internet access and provider
quota are still required; there is no persistent offline playback cache.
Durations are approximate until read, and current or explicitly requested master
clip telemetry may read a complete clip incrementally. Export temporarily stages
only the selected original files (up to 2 GiB combined), then cleans them up.
Google Drive duplicates with matching sizes and stored MD5 checksums are used
once without changing the originals. Conflicting or unverifiable duplicates
still block opening. See [remote recording details](RCLONE.md) for loopback
authentication, tradeoffs and verification scope.

## Notes
- SEI telemetry is typically not recorded while parked
- SEI telemetry while using Smart Summon will be notated as manual
- Brake/accelerator pedal data is not logged during Self Driving. Pedal activity while Autopilot/Self Driving is engaged indicates driver input.
- A requested privacy blur must be applied successfully or the export stops. Invalid masks are not silently omitted.
- FFmpeg discovery and encoder/resolution probes run asynchronously. Failed or cancelled Leaflet minimap rendering releases its hidden window and encoder process.
- Collection playback corrects camera drift and ignores telemetry from superseded clip loads. SEI parsing reads video payloads without duplicating them.
- SentryUSB routes and tags are parsed in one streaming pass. Unused route fields are discarded, but chronological grouping still retains the required route data in memory. Park-split drives retain their segment durations; files with no recognizable route timestamps produce an empty drive list.

## Project Origin & Credits

Originally concepted by  [**ChadR23**](https://github.com/ChadR23), this project is now co-developed alongside [**Scottmg1**](https://github.com/Scottmg1). Both serve as Main Developers, utilizing the **Claude Opus 4.5 AI Model** to aid in development.

Special thanks to [**JeffFromTheIRS**](https://github.com/JeffFromTheIRS) for his contributions via Pull Requests and beta testing, and to  [**Parallax**](https://github.com/DennisGarvey) and **38tu** for their hands-on testing and invaluable feedback.

## License

MIT License - see LICENSE file for details.
