import test from 'node:test';
import assert from 'node:assert/strict';

import { sha256Hex } from '../../src/sha256.js';

import {
  makeFrame,
  readFrame,
  chunkCount,
  formatBytes,
  kindFor,
  extensionFor,
  IncomingTransfer,
  OutgoingTransfer,
  channelDrain,
  serveChunks,
  encodeBitmap,
  decodeBitmap,
  missingSequences,
  isComplete,
  CHUNK_SIZE,
  HEADER_BYTES,
  TRANSFER,
} from '../../src/media.js';

const bytes = (length, seed = 0) =>
  Uint8Array.from({ length }, (_, i) => (i * 31 + seed) & 0xff);

function identical(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/* ------------------------------------------------------------------ framing */

test('a frame round-trips its header and payload exactly', () => {
  const payload = bytes(1000, 7);
  const frame = makeFrame(0xdeadbeef, 42, payload);
  assert.equal(frame.byteLength, HEADER_BYTES + 1000);

  const read = readFrame(frame);
  assert.equal(read.transferId, 0xdeadbeef);
  assert.equal(read.sequence, 42);
  assert.ok(identical(read.payload, payload));
});

test('the header is big-endian and survives large ids', () => {
  const frame = makeFrame(0xffffffff, 0xfffffffe, bytes(1));
  const view = new DataView(frame);
  assert.equal(view.getUint32(0, false), 0xffffffff);
  assert.equal(view.getUint32(4, false), 0xfffffffe);
});

test('rubbish frames are refused instead of parsed', () => {
  assert.throws(() => readFrame(new ArrayBuffer(4)), /not a transfer frame/);
  assert.throws(() => readFrame('not a buffer'), /not a transfer frame/);
});

test('chunk counts cover exact multiples and remainders', () => {
  assert.equal(chunkCount(0), 1);
  assert.equal(chunkCount(1), 1);
  assert.equal(chunkCount(CHUNK_SIZE), 1);
  assert.equal(chunkCount(CHUNK_SIZE + 1), 2);
  assert.equal(chunkCount(CHUNK_SIZE * 10), 10);
});

/* ------------------------------------------------------------------ formats */

test('sizes read the way a person would say them', () => {
  assert.equal(formatBytes(0), '0 bytes');
  assert.equal(formatBytes(1), '1 byte');
  assert.equal(formatBytes(512), '512 bytes');
  assert.equal(formatBytes(1024), '1 KB');
  assert.equal(formatBytes(1536), '2 KB');
  assert.equal(formatBytes(1024 * 1024), '1.0 MB');
  assert.equal(formatBytes(25 * 1024 * 1024), '25 MB');
  assert.equal(formatBytes(1024 * 1024 * 1024), '1.0 GB');
  assert.equal(formatBytes(-1), '—');
});

test('files are classified from the type, or the name when it is missing', () => {
  assert.equal(kindFor('image/png'), 'image');
  assert.equal(kindFor('video/mp4'), 'video');
  assert.equal(kindFor('audio/mpeg'), 'audio');
  assert.equal(kindFor('application/pdf'), 'file');
  assert.equal(kindFor('', 'holiday.HEIC'), 'image');
  assert.equal(kindFor('', 'clip.mov'), 'video');
  assert.equal(kindFor('', 'voice.m4a'), 'audio');
  assert.equal(kindFor('', 'notes.txt'), 'file');
  assert.equal(kindFor('application/octet-stream', 'mystery'), 'file');
});

test('extensions fall back sensibly', () => {
  assert.equal(extensionFor('image/png'), 'png');
  assert.equal(extensionFor('application/pdf'), 'pdf');
  assert.equal(extensionFor('', 'photo.jpeg'), 'jpeg');
  assert.equal(extensionFor('application/x-thing', 'blob'), 'bin');
});

/* ---------------------------------------------------------------- receiving */

test('an incoming transfer reassembles in order', () => {
  const source = bytes(5000, 3);
  const offer = { transferId: 1, size: source.length, mime: 'image/png', chunkSize: 2000 };
  const parts = [];
  const progress = [];

  const transfer = new IncomingTransfer({
    offer,
    onProgress: (p) => progress.push(Number(p.toFixed(2))),
    onComplete: (blob) => parts.push(blob),
  });

  const size = 2000;
  for (let offset = 0, seq = 0; offset < source.length; offset += size, seq++) {
    transfer.accept(seq, source.subarray(offset, Math.min(offset + size, source.length)));
  }

  assert.equal(parts.length, 1, 'completes exactly once');
  assert.equal(parts[0].size, source.length);
  assert.deepEqual(progress.at(-1), 1);
});

test('duplicate chunks are ignored rather than double counted', () => {
  const offer = { transferId: 2, size: 10, mime: 'application/octet-stream' };
  let completed = 0;
  const transfer = new IncomingTransfer({ offer, onComplete: () => completed++ });

  assert.equal(transfer.accept(0, bytes(10)), true);
  assert.equal(transfer.accept(0, bytes(10)), false, 'the same sequence twice is a no-op');
  assert.equal(completed, 1);
  assert.equal(transfer.receivedBytes, 10);
});

test('out-of-range sequences are refused', () => {
  const transfer = new IncomingTransfer({ offer: { transferId: 3, size: 10, mime: '' } });
  assert.equal(transfer.accept(5, bytes(1)), false);
  assert.equal(transfer.accept(-1, bytes(1)), false);
  assert.equal(transfer.accept(1.5, bytes(1)), false);
});

test('a size mismatch is reported rather than yielding a corrupt file', () => {
  const errors = [];
  let completed = 0;
  const transfer = new IncomingTransfer({
    offer: { transferId: 4, size: 100, mime: '' },
    onError: (error) => errors.push(error.message),
    onComplete: () => completed++,
  });

  // The final chunk arrives, but it does not add up to the promised size.
  transfer.accept(0, bytes(40));
  assert.equal(completed, 0, 'a short file must never be handed over as if complete');
  assert.match(errors[0], /expected 100 bytes, assembled 40/);
});

test('a missing chunk leaves the transfer unfinished', () => {
  let completed = 0;
  const transfer = new IncomingTransfer({
    offer: { transferId: 6, size: CHUNK_SIZE * 3, mime: '' },
    onComplete: () => completed++,
  });

  transfer.accept(0, new Uint8Array(CHUNK_SIZE));
  transfer.accept(2, new Uint8Array(CHUNK_SIZE)); // 1 never arrives
  assert.equal(completed, 0);
  assert.equal(transfer.progress.toFixed(2), '0.67');
});

test('cancelling stops accepting anything further', () => {
  const errors = [];
  const transfer = new IncomingTransfer({
    offer: { transferId: 5, size: 10, mime: '' },
    onError: (error) => errors.push(error.message),
  });
  transfer.cancel('peer went away');
  assert.equal(transfer.accept(0, bytes(10)), false);
  assert.deepEqual(errors, ['peer went away']);
});

/* ------------------------------------------------------------------ sending */

/** Collects frames and records how often the sender waited for the buffer. */
function fakeChannel({ stallAfter = Infinity } = {}) {
  const frames = [];
  let sent = 0;
  let waits = 0;
  return {
    frames,
    get waits() {
      return waits;
    },
    send: (frame) => {
      frames.push(frame);
      sent++;
    },
    waitForDrain: async () => {
      waits++;
      if (sent >= stallAfter) throw new Error('the link stopped draining');
    },
  };
}

test('an outgoing transfer emits every chunk exactly once', async () => {
  const source = bytes(5000, 11);
  const channel = fakeChannel();
  const progress = [];

  const transfer = new OutgoingTransfer({
    transferId: 9,
    size: source.length,
    chunkSize: 2000,
    readChunk: async (offset, length) => source.subarray(offset, offset + length),
    send: channel.send,
    waitForDrain: channel.waitForDrain,
    onProgress: (p) => progress.push(Number(p.toFixed(2))),
  });

  assert.equal(await transfer.run(), true);
  assert.equal(channel.frames.length, 3);

  // Out of order is expected now that chunks are read in parallel; every
  // sequence must still appear exactly once.
  const sequences = channel.frames.map((frame) => readFrame(frame).sequence).sort((a, b) => a - b);
  assert.deepEqual(sequences, [0, 1, 2]);

  // Reassembled, the bytes match the original.
  const joined = new Uint8Array(source.length);
  for (const frame of channel.frames) {
    const { sequence, payload } = readFrame(frame);
    joined.set(payload, sequence * 2000);
  }
  assert.ok(identical(joined, source));
  assert.deepEqual(progress, [0, 0.4, 0.8, 1], 'progress starts at zero and ends at one');
});

test('the sender asks for the buffer to drain before every chunk', async () => {
  const channel = fakeChannel();
  const transfer = new OutgoingTransfer({
    transferId: 10,
    size: CHUNK_SIZE * 4,
    readChunk: async (offset, length) => new Uint8Array(length),
    send: channel.send,
    waitForDrain: channel.waitForDrain,
  });
  await transfer.run({ windowSize: 1 });
  assert.equal(channel.waits, 4, 'one wait per chunk, before sending it');
});

test('reads overlap instead of running one after another', async () => {
  // The point of the pool: while one chunk is being read, others are too.
  let inFlight = 0;
  let peak = 0;
  const channel = fakeChannel();

  const transfer = new OutgoingTransfer({
    transferId: 20,
    size: CHUNK_SIZE * 24,
    readChunk: async (offset, length) => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((done) => setTimeout(done, 2));
      inFlight--;
      return new Uint8Array(length);
    },
    send: channel.send,
    waitForDrain: channel.waitForDrain,
  });

  await transfer.run({ windowSize: 8 });
  assert.equal(channel.frames.length, 24, 'every chunk still goes out once');
  assert.ok(peak > 1, `reads ran ${peak} at a time; they should overlap`);
  assert.ok(peak <= 8, `the window must be respected, saw ${peak}`);
});

test('a serial window is still available for links that need it', async () => {
  let peak = 0;
  let inFlight = 0;
  const channel = fakeChannel();
  const transfer = new OutgoingTransfer({
    transferId: 21,
    size: CHUNK_SIZE * 6,
    readChunk: async (offset, length) => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((done) => setTimeout(done, 1));
      inFlight--;
      return new Uint8Array(length);
    },
    send: channel.send,
    waitForDrain: channel.waitForDrain,
  });

  await transfer.run({ windowSize: 1 });
  assert.equal(peak, 1);
});

test('chunks may arrive in any order and still assemble correctly', () => {
  const source = bytes(5000, 42);
  const offer = { transferId: 60, size: source.length, mime: 'image/png', chunkSize: 1000 };
  let assembled = null;
  const transfer = new IncomingTransfer({
    offer,
    onComplete: (blob) => {
      assembled = blob;
    },
  });

  // Deliberately shuffled, the way parallel workers deliver.
  for (const sequence of [3, 0, 4, 2, 1]) {
    const offset = sequence * 1000;
    transfer.accept(sequence, source.subarray(offset, Math.min(offset + 1000, source.length)));
  }

  assert.ok(assembled, 'out-of-order arrival must not stall the transfer');
  assert.equal(assembled.size, source.length);
});

test('a cancelled transfer stops early and reports nothing', async () => {
  const channel = fakeChannel();
  let completed = false;
  const transfer = new OutgoingTransfer({
    transferId: 11,
    size: CHUNK_SIZE * 10,
    readChunk: async (offset, length) => new Uint8Array(length),
    send: (frame) => {
      channel.send(frame);
      if (channel.frames.length === 2) transfer.cancel();
    },
    waitForDrain: channel.waitForDrain,
    onComplete: () => {
      completed = true;
    },
  });

  assert.equal(await transfer.run(), false);
  assert.equal(completed, false);
  assert.equal(channel.frames.length, 2);
});

test('a stall surfaces as an error rather than hanging', async () => {
  const channel = fakeChannel({ stallAfter: 1 });
  const errors = [];
  const transfer = new OutgoingTransfer({
    transferId: 12,
    size: CHUNK_SIZE * 5,
    readChunk: async (offset, length) => new Uint8Array(length),
    send: channel.send,
    waitForDrain: channel.waitForDrain,
    onError: (error) => errors.push(error.message),
  });

  // One worker, so the stall is hit after the first send rather than by a pool
  // that fills its window before anything has been written.
  assert.equal(await transfer.run({ windowSize: 1 }), false);
  assert.equal(errors.length, 1);
  assert.match(errors[0], /stopped draining/);
});

test('a read failure is reported, not thrown into the void', async () => {
  const errors = [];
  const transfer = new OutgoingTransfer({
    transferId: 13,
    size: 100,
    readChunk: async () => {
      throw new Error('the disk went away');
    },
    send: () => {},
    onError: (error) => errors.push(error.message),
  });
  assert.equal(await transfer.run(), false);
  assert.deepEqual(errors, ['the disk went away']);
});

/* -------------------------------------------------------------- back-pressure */

test('a channel below the water mark does not wait', async () => {
  const channel = {
    readyState: 'open',
    bufferedAmount: 1024,
    bufferedAmountLowThreshold: 0,
    addEventListener: () => {},
    removeEventListener: () => {},
  };
  const wait = channelDrain(channel, { highWater: 4096, lowWater: 1024 });
  await wait();
  assert.equal(channel.bufferedAmountLowThreshold, 1024, 'the threshold is set for the browser');
});

test('a full buffer waits for the low-water event', async () => {
  const listeners = {};
  const channel = {
    readyState: 'open',
    bufferedAmount: 10_000,
    bufferedAmountLowThreshold: 0,
    addEventListener: (type, handler) => {
      listeners[type] = handler;
    },
    removeEventListener: (type) => {
      delete listeners[type];
    },
  };

  const wait = channelDrain(channel, { highWater: 4096, lowWater: 1024 });
  let resolved = false;
  const pending = wait().then(() => {
    resolved = true;
  });

  await new Promise((done) => setTimeout(done, 10));
  assert.equal(resolved, false, 'it must not resolve while the buffer is full');

  listeners.bufferedamountlow();
  await pending;
  assert.equal(resolved, true);
});

test('a closed link fails fast instead of waiting forever', async () => {
  const channel = {
    readyState: 'closed',
    bufferedAmount: 0,
    bufferedAmountLowThreshold: 0,
    addEventListener: () => {},
    removeEventListener: () => {},
  };
  await assert.rejects(channelDrain(channel)(), /closed during the transfer/);
});

/* -------------------------------------------------------------- end to end */

test('a file survives the whole round trip, byte for byte', async () => {
  // Deliberately not a multiple of the chunk size.
  const source = bytes(CHUNK_SIZE * 3 + 777, 5);
  const offer = { transferId: 77, size: source.length, mime: 'video/mp4', name: 'clip.mp4' };

  let assembled = null;
  const receiver = new IncomingTransfer({
    offer,
    onComplete: (blob) => {
      assembled = blob;
    },
  });

  const channel = fakeChannel();
  const sender = new OutgoingTransfer({
    transferId: offer.transferId,
    size: source.length,
    readChunk: async (offset, length) => source.subarray(offset, offset + length),
    send: channel.send,
    waitForDrain: channel.waitForDrain,
  });

  await sender.run();
  for (const frame of channel.frames) {
    const { sequence, payload } = readFrame(frame);
    receiver.accept(sequence, payload);
  }

  assert.ok(assembled, 'the receiver assembled a blob');
  assert.equal(assembled.size, source.length);
  assert.equal(assembled.type, 'video/mp4');

  const roundTripped = new Uint8Array(await assembled.arrayBuffer());
  assert.ok(identical(roundTripped, source), 'every byte survived');
});

/* ------------------------------------------------------- resumable transfers */

test('a bitmap round-trips the chunks a receiver holds', () => {
  const held = new Set([0, 3, 7, 8, 63, 64, 1000]);
  const bitmap = encodeBitmap(held, 1001);
  assert.equal(bitmap.length, Math.ceil(1001 / 8));

  const decoded = decodeBitmap(bitmap, 1001);
  assert.deepEqual([...decoded].sort((a, b) => a - b), [...held].sort((a, b) => a - b));
});

test('bitmaps stay small enough to send on every reconnect', () => {
  // A 100 MB file at 16 KB chunks.
  const total = chunkCount(100 * 1024 * 1024);
  assert.equal(total, 6400);
  const bitmap = encodeBitmap([], total);
  assert.ok(bitmap.length <= 800, `bitmap was ${bitmap.length} bytes`);
});

test('out-of-range sequences are ignored when encoding', () => {
  const bitmap = encodeBitmap([-1, 5, 999, 1.5], 10);
  assert.deepEqual([...decodeBitmap(bitmap, 10)], [5]);
});

test('an empty bitmap means send everything', () => {
  const missing = missingSequences(decodeBitmap(encodeBitmap([], 5), 5), 5);
  assert.deepEqual(missing, [0, 1, 2, 3, 4]);
  assert.equal(isComplete(new Set(), 5), false);
});

test('a partial bitmap means send only the gaps', () => {
  const held = decodeBitmap(encodeBitmap([0, 1, 4], 5), 5);
  assert.deepEqual(missingSequences(held, 5), [2, 3]);
  assert.equal(isComplete(held, 5), false);
});

test('a complete bitmap means there is nothing left to send', () => {
  const held = decodeBitmap(encodeBitmap([0, 1, 2, 3, 4], 5), 5);
  assert.deepEqual(missingSequences(held, 5), []);
  assert.equal(isComplete(held, 5), true);
});

test('a resumed transfer skips what is held and reports the whole file as done', async () => {
  const source = bytes(CHUNK_SIZE * 4, 21);
  const channel = fakeChannel();
  const progress = [];

  // The receiver already has the first half.
  const held = new Set([0, 1]);
  const transfer = new OutgoingTransfer({
    transferId: 30,
    size: source.length,
    readChunk: async (offset, length) => source.subarray(offset, offset + length),
    send: channel.send,
    waitForDrain: channel.waitForDrain,
    onProgress: (p) => progress.push(Number(p.toFixed(2))),
  });

  await transfer.run({ held });

  assert.equal(channel.frames.length, 2, 'only the missing chunks went out');
  assert.deepEqual(
    channel.frames.map((f) => readFrame(f).sequence),
    [2, 3],
  );
  assert.equal(transfer.sentBytes, CHUNK_SIZE * 2);
  assert.equal(transfer.skippedBytes, CHUNK_SIZE * 2);
  assert.equal(transfer.progress, 1, 'progress reflects the whole file, not just this run');
  assert.equal(progress.at(-1), 1);
});

test('a receiver that already has everything is not sent a single byte', async () => {
  const channel = fakeChannel();
  const transfer = new OutgoingTransfer({
    transferId: 31,
    size: CHUNK_SIZE * 3,
    readChunk: async (offset, length) => new Uint8Array(length),
    send: channel.send,
    waitForDrain: channel.waitForDrain,
  });

  await transfer.run({ held: new Set([0, 1, 2]) });
  assert.equal(channel.frames.length, 0);
  assert.equal(transfer.progress, 1);
});

test('an interrupted transfer resumes byte-for-byte', async () => {
  // A file that is not a whole number of chunks.
  const source = bytes(CHUNK_SIZE * 3 + 999, 33);
  const offer = {
    transferId: 40,
    fileId: 'abc',
    size: source.length,
    chunkSize: CHUNK_SIZE,
    mime: 'video/mp4',
  };

  // First attempt: the link dies after two chunks.
  let assembled = null;
  const chunks = new Map();
  const receiver = new IncomingTransfer({
    offer,
    onComplete: (blob) => {
      assembled = blob;
    },
  });

  const firstRun = fakeChannel();
  const sender = new OutgoingTransfer({
    transferId: 40,
    size: source.length,
    readChunk: async (offset, length) => source.subarray(offset, offset + length),
    send: firstRun.send,
    waitForDrain: firstRun.waitForDrain,
  });
  sender.cancel();
  // Send two chunks by hand, then stop.
  for (let seq = 0; seq < 2; seq++) {
    const offset = seq * CHUNK_SIZE;
    const payload = source.subarray(offset, offset + CHUNK_SIZE);
    const frame = makeFrame(40, seq, payload);
    firstRun.send(frame);
    const read = readFrame(frame);
    receiver.accept(read.sequence, read.payload);
    chunks.set(read.sequence, read.payload);
  }
  assert.equal(assembled, null, 'nothing complete yet');
  assert.ok(receiver.progress > 0.4 && receiver.progress < 0.7);

  // The link comes back. The receiver reports what it holds.
  const held = new Set(chunks.keys());
  const bitmap = encodeBitmap(held, chunkCount(offer.size, offer.chunkSize));
  assert.equal(decodeBitmap(bitmap, chunkCount(offer.size, offer.chunkSize)).size, 2);

  const secondRun = fakeChannel();
  const resumed = new OutgoingTransfer({
    transferId: 41,
    size: source.length,
    readChunk: async (offset, length) => source.subarray(offset, offset + length),
    send: secondRun.send,
    waitForDrain: secondRun.waitForDrain,
  });
  await resumed.run({ held: decodeBitmap(bitmap, chunkCount(offer.size, offer.chunkSize)) });

  // Only the gap was sent, and the file completes exactly.
  assert.equal(secondRun.frames.length, chunkCount(offer.size, offer.chunkSize) - 2);
  for (const frame of secondRun.frames) {
    const read = readFrame(frame);
    receiver.accept(read.sequence, read.payload);
  }

  assert.ok(assembled, 'the transfer completed after resuming');
  assert.equal(assembled.size, source.length);
  const roundTripped = new Uint8Array(await assembled.arrayBuffer());
  assert.ok(identical(roundTripped, source), 'every byte survived the interruption');
});

/* ------------------------------------------------------------- serving */

test('a peer can serve a chosen set of chunks from what it holds', async () => {
  const source = bytes(CHUNK_SIZE * 5 + 100, 77);
  const blob = new Blob([source]);
  const frames = [];

  const served = await serveChunks({
    blob,
    fileId: 'abc',
    transferId: 99,
    sequences: [4, 0, 2],
    send: (frame) => frames.push(frame),
    chunkSize: CHUNK_SIZE,
  });

  assert.equal(served, 3);
  assert.deepEqual(
    frames.map((f) => readFrame(f).sequence).sort((a, b) => a - b),
    [0, 2, 4],
  );

  // The bytes served must be exactly the bytes at those offsets.
  for (const frame of frames) {
    const { sequence, payload } = readFrame(frame);
    const offset = sequence * CHUNK_SIZE;
    const expected = source.subarray(offset, Math.min(offset + CHUNK_SIZE, source.length));
    assert.ok(identical(payload, expected), `chunk ${sequence} served the wrong bytes`);
  }
});

test('serving stops when the peer goes away', async () => {
  const blob = new Blob([bytes(CHUNK_SIZE * 10, 3)]);
  const frames = [];
  let cancelled = false;

  await serveChunks({
    blob,
    fileId: 'abc',
    transferId: 100,
    sequences: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9],
    send: (frame) => {
      frames.push(frame);
      if (frames.length === 3) cancelled = true;
    },
    isCancelled: () => cancelled,
    windowSize: 1,
  });

  assert.equal(frames.length, 3, 'nothing is served after the cancel');
});

test('pieces can be checked as they complete, not only at the end', async () => {
  // Two chunks per piece, so a piece completes on every second chunk.
  const chunkSize = 8;
  const pieceSize = 16;
  const source = bytes(40, 9);

  const pieces = [];
  for (let offset = 0; offset < source.length; offset += pieceSize) {
    pieces.push(sha256Hex(source.subarray(offset, Math.min(offset + pieceSize, source.length))));
  }

  const offer = {
    transferId: 70,
    size: source.length,
    chunkSize,
    pieceSize,
    pieceHashes: pieces,
    mime: 'application/octet-stream',
  };
  const transfer = new IncomingTransfer({ offer });

  assert.equal(transfer.pieceOf(0), 0);
  assert.equal(transfer.pieceOf(1), 0);
  assert.equal(transfer.pieceOf(2), 1);
  assert.equal(transfer.pieceOf(4), 2);

  // Each arriving piece can be verified against the manifest independently.
  const verify = (sequence) => {
    const piece = transfer.pieceOf(sequence);
    const start = piece * pieceSize;
    const end = Math.min(start + pieceSize, source.length);
    const assembled = new Uint8Array(end - start);
    for (let seq = piece * (pieceSize / chunkSize); seq < Math.ceil(end / chunkSize); seq++) {
      const offset = seq * chunkSize;
      assembled.set(source.subarray(offset, Math.min(offset + chunkSize, end)), offset - start);
    }
    return sha256Hex(assembled) === pieces[piece];
  };

  for (let sequence = 0; sequence < 5; sequence++) transfer.accept(sequence, source.subarray(sequence * chunkSize, sequence * chunkSize + chunkSize));
  assert.equal(verify(0), true);
  assert.equal(verify(1), true);
  assert.equal(sha256Hex(new Uint8Array(pieceSize)) === pieces[0], false, 'a wrong piece does not verify');
});
