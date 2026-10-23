// Buffered seconds describe media time, not download progress or wall-clock time.
export function bufferedAhead(video) {
    const time = video.currentTime;
    if (!Number.isFinite(time)) return 0;
    for (let i = 0; i < video.buffered.length; i++) {
        const start = video.buffered.start(i);
        const end = video.buffered.end(i);
        if (Number.isFinite(start) && Number.isFinite(end) && start <= time + 0.01 && end >= time) return Math.max(0, end - time);
    }
    return 0;
}

export function bufferingState(entries) {
    const errors = entries.filter(entry => entry.error);
    const ahead = entries.length ? Math.min(...entries.map(entry => entry.ahead)) : 0;
    const waiting = entries.filter(entry => !entry.ready || (!entry.paused && entry.waiting)).length;
    const state = errors.length ? 'error' : entries.some(entry => entry.seeking) ? 'seeking'
        : entries.every(entry => !entry.seen) ? 'loading' : waiting ? 'buffering' : 'ready';
    return { state, waiting, ahead: Number.isFinite(ahead) ? Math.max(0, ahead) : 0, errors };
}

// Intersect active cameras before mapping this segment onto the collection timeline.
export function bufferedTimelineRanges(videos, { offset, duration, segmentDuration }) {
    if (!videos.length || !Number.isFinite(offset) || offset < 0 ||
        !Number.isFinite(duration) || duration <= 0 ||
        !Number.isFinite(segmentDuration) || segmentDuration <= 0) return [];
    let common = [[0, Math.min(segmentDuration, duration - offset)]];
    for (const video of videos) {
        const buffered = video.buffered;
        const next = [];
        for (const [start, end] of common) {
            for (let i = 0; i < buffered.length; i++) {
                const from = Math.max(start, buffered.start(i));
                const to = Math.min(end, buffered.end(i));
                if (Number.isFinite(from) && Number.isFinite(to) && to > from) next.push([from, to]);
            }
        }
        common = next;
    }
    return common.map(([start, end]) => [(offset + start) / duration * 100, (offset + end) / duration * 100]);
}

export function createPlaybackBuffering({ root, status, detail, slider, t, cameraLabel }) {
    let entries = [];
    let isActive = () => true;
    let getTimeline = () => ({});
    const cleanups = [];
    let timelineSnapshot = null;
    function render() {
        if (!root) return;
        const hidden = !entries.length || !isActive();
        if (root.hidden !== hidden) root.hidden = hidden;
        if (slider) {
            const current = !root.hidden && entries.every(({ video, src, started }) =>
                started && video.src === src && video.currentSrc === src && !video.error);
            const timeline = current ? getTimeline() : {};
            const snapshot = current ? [timeline.offset, timeline.duration, timeline.segmentDuration] : [];
            if (current) {
                for (const { video } of entries) {
                    const buffered = video.buffered;
                    snapshot.push(buffered.length);
                    for (let i = 0; i < buffered.length; i++) snapshot.push(buffered.start(i), buffered.end(i));
                }
            }
            if (!timelineSnapshot || snapshot.length !== timelineSnapshot.length ||
                snapshot.some((value, index) => !Object.is(value, timelineSnapshot[index]))) {
                timelineSnapshot = snapshot;
                const ranges = current ? bufferedTimelineRanges(entries.map(entry => entry.video), timeline) : [];
                const gradient = ranges.map(([start, end]) =>
                    `linear-gradient(to right, transparent ${start}%, var(--text-secondary) ${start}%, var(--text-secondary) ${end}%, transparent ${end}%)`).join(', ');
                if (slider.style.getPropertyValue('--buffered-ranges') !== gradient) {
                    if (gradient) slider.style.setProperty('--buffered-ranges', gradient);
                    else slider.style.removeProperty('--buffered-ranges');
                }
            }
        }
        if (root.hidden) return;
        const result = bufferingState(entries.map(entry => {
            const { video } = entry;
            return { ...entry, ready: entry.seen && video.readyState >= 2,
                paused: video.paused, seeking: entry.started && video.seeking,
                waiting: entry.waiting && video.readyState < 3,
                error: entry.started && video.error, ahead: entry.seen ? bufferedAhead(video) : 0 };
        }));
        if (root.dataset.state !== result.state) root.dataset.state = result.state;
        const cameras = entries.map(entry => cameraLabel(entry.camera)).join(', ');
        const tooltip = t('ui.buffering.cameras', { cameras });
        if (root.getAttribute('data-tip') !== tooltip) root.setAttribute('data-tip', tooltip);
        const text = t(`ui.buffering.${result.state}`, {
            waiting: result.waiting, total: entries.length,
            cameras: result.errors.map(entry => cameraLabel(entry.camera)).join(', ')
        });
        if (status.textContent !== text) status.textContent = text;
        const ahead = t('ui.buffering.ahead', { seconds: result.ahead.toFixed(1) });
        if (detail.textContent !== ahead) detail.textContent = ahead;
    }
    function reset() {
        cleanups.splice(0).forEach(cleanup => cleanup());
        entries = [];
        render();
    }
    function setSources(sources, active = () => true, timeline = () => ({})) {
        reset();
        isActive = active;
        getTimeline = timeline;
        entries = sources.map(source => ({ ...source, seen: false, started: false, waiting: false }));
        for (const entry of entries) {
            const { video, src } = entry;
            const listener = event => {
                if (!isActive()) { render(); return; }
                if (video.src !== src || (video.currentSrc && video.currentSrc !== src)) return;
                if (event.type === 'loadstart') entry.started = true;
                if (['loadeddata', 'canplay', 'canplaythrough', 'playing', 'seeked', 'timeupdate'].includes(event.type)) {
                    entry.started = true;
                    if (video.readyState >= 2) entry.seen = true;
                }
                if (!entry.started) return;
                if (['waiting', 'stalled'].includes(event.type)) entry.waiting = true;
                if (video.readyState >= 3) entry.waiting = false;
                if (['playing', 'canplay', 'canplaythrough', 'seeked', 'pause', 'emptied', 'abort'].includes(event.type)) entry.waiting = false;
                if (event.type === 'emptied') entry.seen = false;
                render();
            };
            const events = ['loadstart', 'loadedmetadata', 'durationchange', 'loadeddata', 'progress', 'timeupdate', 'waiting', 'stalled', 'playing', 'canplay', 'canplaythrough', 'seeking', 'seeked', 'pause', 'play', 'error', 'abort', 'emptied'];
            events.forEach(event => video.addEventListener(event, listener));
            cleanups.push(() => events.forEach(event => video.removeEventListener(event, listener)));
        }
        render();
    }
    return { setSources, reset, render };
}
