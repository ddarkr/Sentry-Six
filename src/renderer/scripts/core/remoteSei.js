// Range-skip top-level boxes; stream only this explicitly requested clip's mdat.
const MAX_METADATA = 16 * 1024 * 1024;
const MAX_SEI = 1024 * 1024;

function checkAbort(signal) {
    if (signal?.aborted) throw signal.reason || new DOMException('Aborted', 'AbortError');
}

async function range(url, start, end, signal) {
    checkAbort(signal);
    const response = await fetch(url, { headers: { Range: `bytes=${start}-${end}` }, signal });
    const match = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(response.headers.get('Content-Range') || '');
    if (response.status !== 206 || !match || Number(match[1]) !== start ||
        Number(match[2]) !== end || !Number.isSafeInteger(Number(match[3])) || Number(match[3]) <= end) {
        await response.body?.cancel();
        throw new Error('Invalid telemetry range response');
    }
    if (!response.body) throw new Error('Missing telemetry response body');
    return { response, total: Number(match[3]) };
}

// Holds at most one transport chunk plus the explicitly bounded requested value.
class StreamReader {
    constructor(response, signal) {
        this.reader = response.body.getReader();
        this.signal = signal;
        this.chunk = new Uint8Array();
        this.offset = 0;
        this.abort = () => { this.reader.cancel().catch(() => {}); };
        signal?.addEventListener('abort', this.abort, { once: true });
    }
    async consume(size, keep = false) {
        const out = keep ? new Uint8Array(size) : null;
        let copied = 0;
        while (copied < size) {
            checkAbort(this.signal);
            if (this.offset === this.chunk.length) {
                const { value, done } = await this.reader.read();
                checkAbort(this.signal);
                if (done) throw new Error('Truncated telemetry MP4');
                this.chunk = value;
                this.offset = 0;
            }
            const count = Math.min(size - copied, this.chunk.length - this.offset);
            if (keep) out.set(this.chunk.subarray(this.offset, this.offset + count), copied);
            this.offset += count;
            copied += count;
        }
        return out;
    }
    async close() {
        this.signal?.removeEventListener('abort', this.abort);
        await this.reader.cancel();
        this.reader.releaseLock();
    }
}

async function bytes(url, start, end, signal) {
    const { response, total } = await range(url, start, end, signal);
    const reader = new StreamReader(response, signal);
    try { return { data: await reader.consume(end - start + 1, true), total }; }
    finally { await reader.close(); }
}

export async function extractRemoteFrames(url, SeiMetadata, signal) {
    const boxes = [];
    let offset = 0, total = Infinity, metadata;
    while (offset < total) {
        if (total - offset < 8) throw new Error('Truncated MP4 box header');
        const header = await bytes(url, offset, offset + 7, signal);
        if (total !== Infinity && total !== header.total) throw new Error('Telemetry source changed');
        total = header.total;
        const view = new DataView(header.data.buffer);
        let size = view.getUint32(0), headerSize = 8;
        const type = String.fromCharCode(...header.data.subarray(4, 8));
        if (size === 1) {
            if (total - offset < 16) throw new Error('Truncated extended MP4 box');
            const extended = await bytes(url, offset + 8, offset + 15, signal);
            const v = new DataView(extended.data.buffer);
            size = v.getUint32(0) * 4294967296 + v.getUint32(4);
            headerSize = 16;
        } else if (size === 0) size = total - offset;
        if (!Number.isSafeInteger(size) || size < headerSize || size > total - offset) {
            throw new Error('Invalid MP4 box size');
        }
        if (type === 'moov') {
            if (size > MAX_METADATA) throw new Error('MP4 metadata exceeds telemetry memory limit');
            metadata = (await bytes(url, offset, offset + size - 1, signal)).data;
        } else if (type === 'mdat') boxes.push({ start: offset + headerSize, size: size - headerSize });
        offset += size;
    }
    if (!metadata || !boxes.length) throw new Error('Missing MP4 telemetry boxes');
    const parser = new window.DashcamMP4(metadata.buffer);
    const config = parser.getConfig();
    const frames = [];
    let frameIndex = 0, timestamp = 0, pendingSei = null;
    for (const box of boxes) {
        if (!box.size) continue;
        const { response, total: currentTotal } = await range(url, box.start, box.start + box.size - 1, signal);
        const reader = new StreamReader(response, signal);
        try {
            if (currentTotal !== total) throw new Error('Telemetry source changed');
            let remaining = box.size;
            while (remaining) {
                if (remaining < 4) throw new Error('Truncated MP4 NAL length');
                const lengthBytes = await reader.consume(4, true);
                const length = new DataView(lengthBytes.buffer).getUint32(0);
                remaining -= 4;
                if (!length || length > remaining) throw new Error('Invalid MP4 NAL size');
                const type = (await reader.consume(1, true))[0] & 31;
                if (type === 6) {
                    if (length > MAX_SEI) throw new Error('SEI exceeds telemetry memory limit');
                    const nal = new Uint8Array(length);
                    nal[0] = type;
                    nal.set(await reader.consume(length - 1, true), 1);
                    pendingSei = parser.decodeSei(nal, SeiMetadata);
                } else {
                    await reader.consume(length - 1);
                    if (type === 1 || type === 5) {
                        if (frameIndex >= 1000000) throw new Error('MP4 frame count exceeds telemetry memory limit');
                        const duration = config.durations[frameIndex++] || 33.333;
                        const frameTimestampMs = timestamp;
                        timestamp += duration;
                        if (pendingSei) frames.push({ timestampMs: timestamp, frameTimestampMs, sei: pendingSei });
                        pendingSei = null;
                    }
                }
                remaining -= length;
            }
        } finally { await reader.close(); }
    }
    checkAbort(signal);
    return frames;
}
