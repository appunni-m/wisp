/**
 * File transfer over a WebRTC data channel.
 *
 * There is no upload endpoint here, so a file goes straight down the same pipe
 * the messages use. Two constraints shape everything below:
 *
 *   1. **A data channel is not a socket.** `send()` takes one message, and that
 *      message has a size limit (256 KB in Chrome, and the spec only guarantees
 *      64 KB). A photo must therefore be split into chunks.
 *   2. **`send()` is fire-and-forget.** Hand it megabytes faster than the link
 *      drains and `bufferedAmount` grows until the tab dies. The sender watches
 *      `bufferedAmount` and waits for it to fall before pushing more.
 *
 * Media travels as binary frames, not base64 in JSON: the same file shrinks by a
 * third and skips two encode/decode passes. Text frames carry the control
 * messages, so the two are told apart by `typeof data === 'string'`.
 *
 * Frame layout (8-byte header, then payload):
 *
 *   0              4              8
 *   +--------------+--------------+------------------+
 *   | transfer id  | sequence     | payload          |
 *   +--------------+--------------+------------------+
 *
 * The transfer logic is written against a minimal channel interface —
 * `send`, `bufferedAmount`, `waitForDrain` — so the whole protocol can be
 * exercised in tests without a browser or a peer.
 */

export const CHUNK_SIZE = 16 * 1024;
export const HEADER_BYTES = 8;

/** Refuse anything larger rather than discovering the limit mid-transfer. */
export const MAX_FILE_BYTES = 100 * 1024 * 1024;
export const WARN_FILE_BYTES = 25 * 1024 * 1024;

/**
 * Control messages. A transfer is: offer -> have -> chunks -> complete.
 *
 * The `have` step is what makes it resumable: the receiver answers an offer with
 * a bitmap of the chunks it already holds, so after a dropped link the sender
 * picks up where it stopped instead of starting again. For a fresh transfer the
 * bitmap is empty and the exchange costs one small message.
 */
export const TRANSFER = {
  OFFER: 'file-offer',
  HAVE: 'file-have',
  COMPLETE: 'file-complete',
  CANCEL: 'file-cancel',
  REJECT: 'file-reject',
  /** "I have this whole file" — announced so others can fetch it from us. */
  AVAILABLE: 'file-available',
  /** "Send me these chunks" — the swarm's request. */
  SERVE: 'file-serve',
  /** That request is finished. */
  SERVED: 'file-served',
};

/* ------------------------------------------------------------------ framing */

export function makeFrame(transferId, sequence, payload) {
  const buffer = new ArrayBuffer(HEADER_BYTES + payload.byteLength);
  const view = new DataView(buffer);
  view.setUint32(0, transferId, false);
  view.setUint32(4, sequence, false);
  new Uint8Array(buffer, HEADER_BYTES).set(payload);
  return buffer;
}

export function readFrame(buffer) {
  if (!(buffer instanceof ArrayBuffer) || buffer.byteLength < HEADER_BYTES) {
    throw new Error('not a transfer frame');
  }
  const view = new DataView(buffer);
  return {
    transferId: view.getUint32(0, false),
    sequence: view.getUint32(4, false),
    payload: new Uint8Array(buffer, HEADER_BYTES),
  };
}

export const chunkCount = (size, chunkSize = CHUNK_SIZE) =>
  size === 0 ? 1 : Math.ceil(size / chunkSize);

export function makeTransferId() {
  return crypto.getRandomValues(new Uint32Array(1))[0];
}

/* ------------------------------------------------------------------ bitmaps */

/**
 * One bit per chunk: what the receiver already holds.
 *
 * A 100 MB file is 6,400 chunks, so this is 800 bytes — small enough to send in
 * a control message on every reconnect, which a list of sequence numbers would
 * not be.
 */
export function encodeBitmap(sequences, total) {
  const bytes = new Uint8Array(Math.ceil(total / 8));
  for (const sequence of sequences) {
    if (!Number.isInteger(sequence) || sequence < 0 || sequence >= total) continue;
    bytes[sequence >> 3] |= 0x80 >> (sequence & 7);
  }
  return bytes;
}

export function decodeBitmap(bytes, total) {
  const held = new Set();
  if (!bytes) return held;
  for (let sequence = 0; sequence < total; sequence++) {
    const byte = bytes[sequence >> 3];
    if (byte === undefined) break;
    if (byte & (0x80 >> (sequence & 7))) held.add(sequence);
  }
  return held;
}

/** Which chunks still need sending, in the order they should go. */
export function missingSequences(held, total) {
  const missing = [];
  for (let sequence = 0; sequence < total; sequence++) {
    if (!held.has(sequence)) missing.push(sequence);
  }
  return missing;
}

export const isComplete = (held, total) => held.size >= total;

/* ------------------------------------------------------------------- format */

export function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return '—';
  if (bytes < 1024) return `${bytes} byte${bytes === 1 ? '' : 's'}`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(bytes < 10 * 1024 * 1024 ? 1 : 0)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

/** How a file should be shown: inline media, or a document. */
export function kindFor(mime = '', name = '') {
  const type = String(mime).toLowerCase();
  if (type.startsWith('image/')) return 'image';
  if (type.startsWith('video/')) return 'video';
  if (type.startsWith('audio/')) return 'audio';
  if (type) return 'file';
  // Some pickers hand over an empty type, so fall back to the extension.
  const extension = String(name).toLowerCase().split('.').pop();
  if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'avif', 'heic'].includes(extension)) return 'image';
  if (['mp4', 'mov', 'webm', 'm4v'].includes(extension)) return 'video';
  if (['mp3', 'm4a', 'ogg', 'wav', 'opus'].includes(extension)) return 'audio';
  return 'file';
}

export function extensionFor(mime = '', name = '') {
  const fromName = String(name).includes('.') ? String(name).split('.').pop() : '';
  if (fromName && fromName.length <= 5) return fromName.toLowerCase();
  const map = {
    'image/png': 'png',
    'image/jpeg': 'jpg',
    'image/gif': 'gif',
    'image/webp': 'webp',
    'video/mp4': 'mp4',
    'video/webm': 'webm',
    'audio/mpeg': 'mp3',
    'audio/mp4': 'm4a',
    'application/pdf': 'pdf',
  };
  return map[String(mime).toLowerCase()] ?? 'bin';
}

/* ---------------------------------------------------------------- receiving */

/**
 * Reassembles one incoming file.
 *
 * Chunks arrive in order (the channel is ordered and reliable), but a duplicate
 * or a late frame after cancellation is dropped rather than corrupting the file.
 */
export class IncomingTransfer {
  #chunks;
  #receivedBytes = 0;
  #seen;
  #finished = false;
  #pieceSize;
  #pieceHashes;
  #verifiedPieces = new Set();
  cancelled = false;

  constructor({ offer, onProgress, onComplete, onError } = {}) {
    this.offer = offer;
    this.transferId = offer.transferId;
    this.size = offer.size;
    // The sender states its chunk size in the offer rather than both sides
    // assuming the same constant — one fewer way for a version skew to corrupt a
    // file.
    this.chunkSize = offer.chunkSize ?? CHUNK_SIZE;
    this.onProgress = onProgress;
    this.onComplete = onComplete;
    this.onError = onError;
    this.#chunks = new Array(chunkCount(offer.size, this.chunkSize));
    this.#seen = new Set();
    // With a piece manifest, data can be checked as it lands rather than only at
    // the end — which is what makes fetching from several peers at once safe.
    this.#pieceSize = offer.pieceSize ?? null;
    this.#pieceHashes = offer.pieceHashes ?? null;
  }

  /** Which piece a sequence belongs to. */
  pieceOf(sequence) {
    if (!this.#pieceSize) return null;
    return Math.floor((sequence * this.chunkSize) / this.#pieceSize);
  }

  get verifiedPieces() {
    return this.#verifiedPieces.size;
  }

  get receivedBytes() {
    return this.#receivedBytes;
  }

  get progress() {
    if (!this.size) return 1;
    return Math.min(1, this.#receivedBytes / this.size);
  }

  /** Bytes this sequence occupies, which differs for the final short chunk. */
  sizeOf(sequence) {
    const offset = sequence * this.chunkSize;
    return Math.max(0, Math.min(this.chunkSize, this.size - offset));
  }

  /**
   * Mark chunks that are already on disk from an earlier attempt.
   *
   * They count towards completeness and progress, but are deliberately not held
   * in memory: the assembled file is built from storage, not from this object.
   */
  seed(sequences) {
    for (const sequence of sequences) {
      if (!Number.isInteger(sequence) || sequence < 0 || sequence >= this.#chunks.length) continue;
      if (this.#seen.has(sequence)) continue;
      this.#seen.add(sequence);
      this.#chunks[sequence] = null;
      this.#receivedBytes += this.sizeOf(sequence);
    }
    this.onProgress?.(this.progress, this.#receivedBytes);
    return this.#seen.size;
  }

  get heldCount() {
    return this.#seen.size;
  }

  /** Returns false when the frame was ignored. */
  accept(sequence, payload) {
    if (this.cancelled || this.#finished) return false;
    if (!Number.isInteger(sequence) || sequence < 0 || sequence >= this.#chunks.length) return false;
    if (this.#seen.has(sequence)) return false;

    this.#seen.add(sequence);
    this.#chunks[sequence] = payload;
    this.#receivedBytes += payload.length;
    this.onProgress?.(this.progress, this.#receivedBytes);

    if (this.#seen.size === this.#chunks.length) {
      this.#finished = true;
      // Chunks seeded from disk are not in memory, so the caller assembles from
      // storage; the blob here is a convenience for the in-memory case.
      if (this.#chunks.some((chunk) => !chunk)) {
        this.onComplete?.(null);
        return true;
      }
      // A Blob assembled from parts stays off the JS heap where the browser can
      // manage it, which matters for a video.
      const blob = new Blob(this.#chunks, { type: this.offer.mime || 'application/octet-stream' });
      if (blob.size !== this.size) {
        this.onError?.(new Error(`expected ${this.size} bytes, assembled ${blob.size}`));
        return true;
      }
      this.onComplete?.(blob);
    }
    return true;
  }

  cancel(reason = 'cancelled') {
    if (this.#finished) return;
    this.cancelled = true;
    this.#chunks = [];
    this.onError?.(new Error(reason));
  }
}

/* ------------------------------------------------------------------ sending */

const DEFAULT_HIGH_WATER = 4 * 1024 * 1024;
const DEFAULT_LOW_WATER = 512 * 1024;

/**
 * Streams a file out in chunks, respecting back-pressure.
 *
 * `readChunk(offset, length)` and `send(frame)` are injected so the pacing can
 * be tested with a fake channel; in the app they slice a File and call
 * `RTCDataChannel.send`.
 */
export class OutgoingTransfer {
  #sentBytes = 0;
  #skippedBytes = 0;
  #cancelled = false;

  constructor({
    transferId,
    size,
    readChunk,
    send,
    waitForDrain = async () => {},
    onProgress,
    onComplete,
    onError,
    chunkSize = CHUNK_SIZE,
  }) {
    this.transferId = transferId;
    this.size = size;
    this.chunkSize = chunkSize;
    this.readChunk = readChunk;
    this.send = send;
    this.waitForDrain = waitForDrain;
    this.onProgress = onProgress;
    this.onComplete = onComplete;
    this.onError = onError;
  }

  get sentBytes() {
    return this.#sentBytes;
  }

  /** Bytes the receiver already had, and so were not sent again. */
  get skippedBytes() {
    return this.#skippedBytes;
  }

  get progress() {
    if (!this.size) return 1;
    // Counts skipped chunks too, so a resumed transfer starts where it left off
    // rather than jumping backwards.
    return Math.min(1, (this.#sentBytes + this.#skippedBytes) / this.size);
  }

  cancel() {
    this.#cancelled = true;
  }

  get cancelled() {
    return this.#cancelled;
  }

  /**
   * `held` is what the receiver reported; those chunks are not sent again.
   *
   * Chunks are read and sent by a pool of workers rather than one at a time.
   * Reading a chunk is not instant — it is a slice of a file off the disk — and
   * doing that serially leaves the link idle for a moment between every 16 KB.
   * With a pool the reads overlap, the send buffer stays fed, and the transfer
   * runs at the speed of the link instead of the speed of the round trips.
   */
  async run({ held = new Set(), windowSize = 8 } = {}) {
    try {
      const total = chunkCount(this.size, this.chunkSize);
      const queue = [];
      for (let sequence = 0; sequence < total; sequence++) {
        if (held.has(sequence)) {
          const offset = sequence * this.chunkSize;
          this.#skippedBytes += Math.min(this.chunkSize, this.size - offset);
          continue;
        }
        queue.push(sequence);
      }
      this.onProgress?.(this.progress, this.#sentBytes);

      let next = 0;
      const worker = async () => {
        for (;;) {
          if (this.#cancelled) return;
          const index = next++;
          if (index >= queue.length) return;
          const sequence = queue[index];

          // Wait before sending, not after: the point is to never let the buffer
          // build up in the first place.
          await this.waitForDrain();
          if (this.#cancelled) return;

          const offset = sequence * this.chunkSize;
          const length = Math.min(this.chunkSize, this.size - offset);
          const payload = await this.readChunk(offset, length);
          if (this.#cancelled) return;

          // Out of order is fine: the receiver files every chunk by its
          // sequence number, so waiting to send them in order would only slow
          // things down.
          this.send(makeFrame(this.transferId, sequence, payload));
          this.#sentBytes += payload.length;
          this.onProgress?.(this.progress, this.#sentBytes);
        }
      };

      const workers = Math.max(1, Math.min(windowSize, queue.length || 1));
      await Promise.all(Array.from({ length: workers }, worker));

      if (this.#cancelled) return false;
      this.onComplete?.();
      return true;
    } catch (error) {
      if (!this.#cancelled) this.onError?.(error);
      return false;
    }
  }
}

/** Back-pressure helper for a real RTCDataChannel. */
export function channelDrain(channel, { highWater = DEFAULT_HIGH_WATER, lowWater = DEFAULT_LOW_WATER } = {}) {
  channel.bufferedAmountLowThreshold = lowWater;
  return async function waitForDrain() {
    if (channel.readyState !== 'open') throw new Error('the link closed during the transfer');
    if (channel.bufferedAmount < highWater) return;
    await new Promise((resolve, reject) => {
      const done = () => {
        channel.removeEventListener('bufferedamountlow', done);
        clearTimeout(timer);
        resolve();
      };
      const timer = setTimeout(() => {
        channel.removeEventListener('bufferedamountlow', done);
        reject(new Error('the link stopped draining'));
      }, 30000);
      channel.addEventListener('bufferedamountlow', done);
    });
  };
}

/* ------------------------------------------------------------- thumbnails */

/**
 * A small preview so a bubble can draw something instantly instead of waiting
 * for a video to arrive. Browser-only: it needs a canvas.
 */
export async function makeThumbnail(blob, { max = 320, quality = 0.6 } = {}) {
  if (typeof document === 'undefined' || typeof createImageBitmap !== 'function') return null;
  const kind = kindFor(blob.type, blob.name ?? '');
  try {
    if (kind === 'image') return await imageThumbnail(blob, max, quality);
    if (kind === 'video') return await videoThumbnail(blob, max, quality);
  } catch {
    // A preview is a nicety; never let it stop a send.
    return null;
  }
  return null;
}

function scaleToFit(width, height, max) {
  const ratio = Math.min(1, max / Math.max(width, height));
  return { width: Math.max(1, Math.round(width * ratio)), height: Math.max(1, Math.round(height * ratio)) };
}

async function imageThumbnail(blob, max, quality) {
  const bitmap = await createImageBitmap(blob);
  const size = scaleToFit(bitmap.width, bitmap.height, max);
  const canvas = document.createElement('canvas');
  canvas.width = size.width;
  canvas.height = size.height;
  canvas.getContext('2d').drawImage(bitmap, 0, 0, size.width, size.height);
  bitmap.close?.();
  return {
    thumb: canvas.toDataURL('image/jpeg', quality),
    width: bitmap.width,
    height: bitmap.height,
  };
}

function videoThumbnail(blob, max, quality) {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(blob);
    const video = document.createElement('video');
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      URL.revokeObjectURL(url);
      resolve(result);
    };

    const capture = () => {
      try {
        const size = scaleToFit(video.videoWidth || max, video.videoHeight || max, max);
        const canvas = document.createElement('canvas');
        canvas.width = size.width;
        canvas.height = size.height;
        canvas.getContext('2d').drawImage(video, 0, 0, size.width, size.height);
        finish({
          thumb: canvas.toDataURL('image/jpeg', quality),
          width: video.videoWidth,
          height: video.videoHeight,
          duration: Number.isFinite(video.duration) ? video.duration : undefined,
        });
      } catch {
        finish(null);
      }
    };

    video.preload = 'metadata';
    video.muted = true;
    video.playsInline = true;
    video.addEventListener('loadeddata', () => {
      // A frame at the very start is often black; a moment in is more use.
      if (Number.isFinite(video.duration) && video.duration > 1.2) {
        video.addEventListener('seeked', capture, { once: true });
        video.currentTime = 1;
      } else {
        capture();
      }
    });
    video.addEventListener('error', () => finish(null));
    setTimeout(() => finish(null), 8000);
    video.src = url;
  });
}

/** Dimensions and duration without a preview, for non-visual media. */
export async function probeMedia(blob) {
  const kind = kindFor(blob.type, blob.name ?? '');
  if (kind !== 'image' || typeof createImageBitmap !== 'function') return {};
  try {
    const bitmap = await createImageBitmap(blob);
    const size = { width: bitmap.width, height: bitmap.height };
    bitmap.close?.();
    return size;
  } catch {
    return {};
  }
}

/* ------------------------------------------------------------------ serving */

/**
 * Serve a set of chunks from a blob we already hold, for somebody else's swarm.
 *
 * This is the other half of fetching from several peers: anyone who has the file
 * can hand out pieces of it. Reading is pooled for the same reason sending is.
 */
export async function serveChunks({
  blob,
  fileId,
  transferId,
  sequences,
  send,
  waitForDrain = async () => {},
  chunkSize = CHUNK_SIZE,
  onProgress,
  windowSize = 4,
  isCancelled = () => false,
}) {
  let next = 0;
  let served = 0;

  const worker = async () => {
    for (;;) {
      if (isCancelled()) return;
      const index = next++;
      if (index >= sequences.length) return;
      const sequence = sequences[index];

      await waitForDrain();
      if (isCancelled()) return;

      const offset = sequence * chunkSize;
      const slice = blob.slice(offset, Math.min(offset + chunkSize, blob.size));
      const payload = new Uint8Array(await slice.arrayBuffer());
      send(makeFrame(transferId, sequence, payload));
      served++;
      onProgress?.(served / sequences.length);
    }
  };

  const workers = Math.max(1, Math.min(windowSize, sequences.length));
  await Promise.all(Array.from({ length: workers }, worker));
  return served;
}
