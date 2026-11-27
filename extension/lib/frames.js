// Chunked WebSocket frame encoder/decoder for Browser Control Companion (MV3).
// Keeps every WebSocket frame under the 1 MiB transport cap while supporting up to 64 MiB
// post-auth JSON payloads via `{ type: "chunk", id, seq, last, data }` frames (data <= 512 KiB).

export const CHUNK_MAX_DATA_BYTES = 512 * 1024;
export const TRANSPORT_MAX_PAYLOAD_BYTES = 1024 * 1024;
export const POST_AUTH_MAX_BYTES = 64 * 1024 * 1024;

// Leave comfortable headroom below 1 MiB for JSON envelope keys and quote/backslash escaping.
const DEFAULT_MAX_FRAME_BYTES = 900 * 1024;
const DEFAULT_MAX_CONCURRENT_STREAMS = 32;
const DEFAULT_STREAM_TIMEOUT_MS = 60_000;

const encoder = new TextEncoder();

export function utf8ByteLength(str) {
  return encoder.encode(String(str)).byteLength;
}

function numericReqIdOf(streamId, explicitReqId) {
  if (typeof explicitReqId === "number" && Number.isInteger(explicitReqId)) return explicitReqId;
  if (typeof streamId === "number" && Number.isInteger(streamId)) return streamId;
  if (typeof streamId === "string" && /^\d+$/.test(streamId)) return Number(streamId);
  return undefined;
}

/**
 * Slice `text` starting at `start` without splitting UTF-16 surrogate pairs,
 * ensuring the slice's UTF-8 byte length is <= `maxDataBytes`.
 */
function sliceUtf8Chunk(text, start, maxDataBytes) {
  const remaining = text.length - start;
  if (remaining <= 0) return "";
  // Start with a greedy upper bound (in ASCII, 1 code unit == 1 byte).
  let end = Math.min(text.length, start + maxDataBytes);
  if (end < text.length) {
    const lastCode = text.charCodeAt(end - 1);
    if (lastCode >= 0xd800 && lastCode <= 0xdbff) end -= 1;
  }
  let slice = text.slice(start, end);
  if (utf8ByteLength(slice) <= maxDataBytes) return slice;

  // Binary search the largest code-unit length whose UTF-8 size fits in maxDataBytes.
  let lo = 1;
  let hi = end - start;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (utf8ByteLength(text.slice(start, start + mid)) <= maxDataBytes) {
      lo = mid;
    } else {
      hi = mid - 1;
    }
  }
  if (start + lo < text.length) {
    const c = text.charCodeAt(start + lo - 1);
    if (c >= 0xd800 && c <= 0xdbff && lo > 1) lo -= 1;
  }
  return text.slice(start, start + lo);
}

let autoStreamSeq = 1;

/**
 * Encode an outgoing JSON message into one or more WebSocket frames.
 * Messages <= `maxDataBytes` (and <= `maxFrameBytes`) are emitted as a single plain JSON frame.
 * Larger messages up to `maxTotalBytes` (64 MiB) are split into `{ type: "chunk", id, seq, last, data }` frames.
 */
export function encodeMessage(obj, options = {}) {
  const maxDataBytes = options.maxDataBytes ?? CHUNK_MAX_DATA_BYTES;
  const maxFrameBytes = options.maxFrameBytes ?? DEFAULT_MAX_FRAME_BYTES;
  const maxTotalBytes = options.maxTotalBytes ?? POST_AUTH_MAX_BYTES;
  const serialized = JSON.stringify(obj);
  const totalBytes = utf8ByteLength(serialized);

  if (totalBytes > maxTotalBytes) {
    return {
      ok: false,
      error: `EXECUTION_FAILED: Result too large (${totalBytes} bytes > ${maxTotalBytes} limit)`,
      totalBytes,
    };
  }

  const singleThreshold = Math.min(maxDataBytes, maxFrameBytes);
  if (totalBytes <= singleThreshold) {
    return { ok: true, frames: [serialized], chunked: false, totalBytes };
  }

  const streamId =
    options.id !== undefined
      ? String(options.id)
      : obj && obj.type === "res" && obj.id !== undefined
        ? String(obj.id)
        : `s-${autoStreamSeq++}`;

  const frames = [];
  let offset = 0;
  let seq = 0;
  while (offset < serialized.length) {
    let data = sliceUtf8Chunk(serialized, offset, maxDataBytes);
    let last = offset + data.length >= serialized.length;
    let frame = JSON.stringify({ type: "chunk", id: streamId, seq, last, data });

    // If JSON escaping (e.g. many quotes/backslashes) pushed the envelope over maxFrameBytes, shrink slice.
    while (utf8ByteLength(frame) > maxFrameBytes && data.length > 1) {
      let nextLen = Math.max(1, Math.floor(data.length / 2));
      const c = data.charCodeAt(nextLen - 1);
      if (c >= 0xd800 && c <= 0xdbff && nextLen > 1) nextLen -= 1;
      data = data.slice(0, nextLen);
      last = offset + data.length >= serialized.length;
      frame = JSON.stringify({ type: "chunk", id: streamId, seq, last, data });
    }

    frames.push(frame);
    offset += data.length;
    seq += 1;
  }

  return { ok: true, frames, chunked: true, totalBytes, id: streamId };
}

/**
 * Stateful reassembler for incoming `{ type: "chunk", id, seq, last, data }` streams.
 * Rejects out-of-order sequences, per-chunk > 512 KiB payloads, and > 64 MiB total streams
 * with a clean per-request error result without requiring the socket to close.
 */
export function createFrameDecoder(options = {}) {
  const maxDataBytes = options.maxDataBytes ?? CHUNK_MAX_DATA_BYTES;
  const maxTotalBytes = options.maxTotalBytes ?? POST_AUTH_MAX_BYTES;
  const maxConcurrent = options.maxConcurrent ?? DEFAULT_MAX_CONCURRENT_STREAMS;
  const streamTimeoutMs = options.streamTimeoutMs ?? DEFAULT_STREAM_TIMEOUT_MS;
  const now = options.now ?? (() => Date.now());

  const streams = new Map(); // id -> { nextSeq, totalBytes, parts, startedAt }
  const aborted = new Map(); // id -> abortedAt

  function pruneExpired() {
    const t = now();
    for (const [id, entry] of streams) {
      if (t - entry.startedAt > streamTimeoutMs) streams.delete(id);
    }
    for (const [id, ts] of aborted) {
      if (t - ts > streamTimeoutMs) aborted.delete(id);
    }
  }

  function abortStream(id, isLast) {
    streams.delete(id);
    if (isLast) {
      aborted.delete(id);
    } else {
      aborted.set(id, now());
    }
  }

  return {
    push(msg) {
      if (!msg || typeof msg !== "object" || msg.type !== "chunk") {
        return { kind: "message", message: msg };
      }

      pruneExpired();

      const rawId = msg.id;
      const validId =
        (typeof rawId === "string" && rawId.trim() !== "") ||
        (typeof rawId === "number" && Number.isInteger(rawId));
      const seq = msg.seq;
      const last = msg.last;
      const data = msg.data;

      if (
        !validId ||
        typeof seq !== "number" ||
        !Number.isInteger(seq) ||
        seq < 0 ||
        typeof last !== "boolean" ||
        typeof data !== "string"
      ) {
        const idStr = validId ? String(rawId) : "";
        return {
          kind: "error",
          id: idStr,
          reqId: numericReqIdOf(rawId, msg.reqId),
          error: "EXECUTION_FAILED: malformed chunk frame",
        };
      }

      const id = String(rawId);
      const reqId = numericReqIdOf(rawId, msg.reqId);

      if (aborted.has(id)) {
        if (last) aborted.delete(id);
        return { kind: "ignored", id, reqId };
      }

      const chunkBytes = utf8ByteLength(data);
      if (chunkBytes > maxDataBytes) {
        abortStream(id, last);
        return {
          kind: "error",
          id,
          reqId,
          error: `EXECUTION_FAILED: chunk data too large (${chunkBytes} bytes > ${maxDataBytes} limit)`,
        };
      }

      let entry = streams.get(id);
      if (!entry) {
        if (seq !== 0) {
          abortStream(id, last);
          return {
            kind: "error",
            id,
            reqId,
            error: `EXECUTION_FAILED: chunked frame out of order (stream ${id}: expected seq 0, got ${seq})`,
          };
        }
        if (streams.size >= maxConcurrent) {
          abortStream(id, last);
          return {
            kind: "error",
            id,
            reqId,
            error: `EXECUTION_FAILED: too many concurrent chunked streams (limit ${maxConcurrent})`,
          };
        }
        entry = { nextSeq: 0, totalBytes: 0, parts: [], startedAt: now() };
        streams.set(id, entry);
      }

      if (seq !== entry.nextSeq) {
        abortStream(id, last);
        return {
          kind: "error",
          id,
          reqId,
          error: `EXECUTION_FAILED: chunked frame out of order (stream ${id}: expected seq ${entry.nextSeq}, got ${seq})`,
        };
      }

      if (entry.totalBytes + chunkBytes > maxTotalBytes) {
        abortStream(id, last);
        return {
          kind: "error",
          id,
          reqId,
          error: `EXECUTION_FAILED: chunked message too large (stream ${id} exceeds ${maxTotalBytes} bytes)`,
        };
      }

      entry.parts.push(data);
      entry.totalBytes += chunkBytes;
      entry.nextSeq += 1;

      if (!last) {
        return { kind: "pending", id, seq, totalBytes: entry.totalBytes };
      }

      streams.delete(id);
      const joined = entry.parts.join("");
      try {
        const parsed = JSON.parse(joined);
        if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
          throw new Error("reassembled payload is not a JSON object");
        }
        return { kind: "message", message: parsed, id, totalBytes: entry.totalBytes };
      } catch (err) {
        return {
          kind: "error",
          id,
          reqId,
          error: `EXECUTION_FAILED: invalid JSON in reassembled chunk stream ${id}: ${err?.message || err}`,
        };
      }
    },

    clear(id) {
      if (id === undefined) {
        streams.clear();
        aborted.clear();
      } else {
        const key = String(id);
        streams.delete(key);
        aborted.delete(key);
      }
    },

    size() {
      return streams.size;
    },
  };
}
