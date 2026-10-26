/**
 * Time Display Utilities
 * Formats and displays playback time information
 */

// DOM element references (lazily cached)
let currentTimeEl = null;
let totalTimeEl = null;

function getElements() {
    if (!currentTimeEl) {
        currentTimeEl = document.getElementById('currentTime');
        totalTimeEl = document.getElementById('totalTime');
    }
}

/**
 * Format seconds as HH:MM:SS or MM:SS
 * @param {number} seconds - Time in seconds
 * @returns {string} Formatted time string
 */
export function formatTimeHMS(seconds) {
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = Math.floor(seconds % 60);
    if (h > 0) {
        return `${h}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
    }
    return `${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
}

/**
 * Update the time display with current and total time
 * @param {number} currentSec - Current playback position in seconds
 * @param {number} totalSec - Total duration in seconds
 */
export function updateTimeDisplayNew(currentSec, totalSec) {
    getElements();
    if (currentTimeEl) currentTimeEl.textContent = formatTimeHMS(currentSec);
    if (totalTimeEl) totalTimeEl.textContent = formatTimeHMS(totalSec);
}

/**
 * Format time based on user's time format preference (12h or 24h)
 * @param {number} hours - Hours (0-23)
 * @param {number} minutes - Minutes (0-59)
 * @param {number} seconds - Seconds (0-59)
 * @param {string} timeFormat - '12h' or '24h'
 * @returns {string} Formatted time string
 */
function formatTimeWithPreference(hours, minutes, seconds, timeFormat) {
    const m = String(minutes).padStart(2, '0');
    const s = String(seconds).padStart(2, '0');
    
    if (timeFormat === '24h') {
        const h = String(hours).padStart(2, '0');
        return `${h}:${m}:${s}`;
    } else {
        const ampm = hours >= 12 ? 'PM' : 'AM';
        const h12 = hours % 12 || 12;
        return `${h12}:${m}:${s} ${ampm}`;
    }
}

function formatRecordingTime(group, positionSeconds) {
    const filename = group?.filesByCamera?.values().next().value?.file?.name;
    const match = (group?.timestampKey || filename || '').match(/\d{4}-\d{2}-\d{2}_(\d{2})-(\d{2})-(\d{2})/);
    if (!match || !Number.isFinite(positionSeconds)) return '';
    const seconds = (Number(match[1]) * 3600 + Number(match[2]) * 60 +
        Number(match[3]) + Math.floor(positionSeconds)) % 86400;
    return formatTimeWithPreference(Math.floor(seconds / 3600), Math.floor(seconds % 3600 / 60),
        seconds % 60, window._timeFormat || '12h');
}

// Map the same compressed segment timeline used by seeking, not elapsed wall time.
export function getTimelineHoverTime(state, nativeVideo, fraction) {
    const collection = state.collection.active;
    let group = state.library.clipGroupById.get(state.selection.selectedGroupId);
    let localSeconds;
    if (collection) {
        const native = state.ui.nativeVideoMode;
        const starts = native ? nativeVideo.cumulativeStarts : collection.segmentStartsMs;
        const duration = native ? starts?.[starts.length - 1] : collection.durationMs;
        if (!starts?.length || !Number.isFinite(duration) || duration <= 0) return '';
        const position = Math.max(0, Math.min(1, fraction)) * duration;
        let index = 0;
        while (index + 1 < collection.groups.length && starts[index + 1] <= position) index++;
        group = collection.groups[index];
        localSeconds = (position - starts[index]) / (native ? 1 : 1000);
    } else if (state.ui.nativeVideoMode) {
        localSeconds = fraction * nativeVideo.master?.duration;
    } else {
        const frames = state.player.frames;
        const index = Math.round(fraction * ((frames?.length || 1) - 1));
        localSeconds = frames?.[index]?.timestamp / 1000;
    }
    if (!Number.isFinite(localSeconds)) return '';
    return formatRecordingTime(group, localSeconds) || formatTimeHMS(localSeconds);
}

/**
 * Update the recording time display from segment timestamp
 * @param {Object} opts - Options
 * @param {Object} opts.collection - Active collection
 * @param {number} opts.segIdx - Current segment index
 * @param {number} opts.videoCurrentTime - Current video time in seconds
 */
export function updateRecordingTime(opts) {
    const { collection, segIdx, videoCurrentTime } = opts;
    const timeText = document.getElementById('recordingTimeText');
    const timeTextCompact = document.getElementById('recordingTimeTextCompact');
    if (!timeText && !timeTextCompact) return;
    
    try {
        const formattedTime = formatRecordingTime(collection?.groups?.[segIdx], videoCurrentTime || 0);
        if (formattedTime && timeText) timeText.textContent = formattedTime;
        if (formattedTime && timeTextCompact) timeTextCompact.textContent = formattedTime;
    } catch (e) {
        console.warn('updateRecordingTime error:', e);
    }
}
