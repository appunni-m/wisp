/**
 * SHA-256 is verified against the published vectors and, more usefully, against
 * Node's own implementation over random inputs at every awkward length. A
 * hand-written hash is exactly the kind of code that looks right and is subtly
 * wrong, so the oracle matters more than the vectors.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';

import { Sha256, sha256Hex, hashBlob } from '../../src/sha256.js';

const nodeHash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const utf8 = (text) => new TextEncoder().encode(text);

test('the published vectors match', () => {
  assert.equal(
    sha256Hex(utf8('')),
    'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
  );
  assert.equal(
    sha256Hex(utf8('abc')),
    'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
  );
  assert.equal(
    sha256Hex(utf8('abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq')),
    '248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1',
  );
  const million = new Uint8Array(1_000_000).fill(0x61);
  assert.equal(
    sha256Hex(million),
    'cdc76e5c9914fb9281a1c7e284d73e67f1809a48a497200e046d39ccc7112cd0',
  );
});

test('it agrees with Node at every awkward length', () => {
  // Boundaries around the 64-byte block and the 56-byte padding threshold are
  // where a hand-written implementation goes wrong.
  const lengths = [0, 1, 2, 3, 31, 32, 55, 56, 57, 63, 64, 65, 119, 120, 121, 127, 128, 129, 1000, 4096];
  for (const length of lengths) {
    const bytes = new Uint8Array(randomBytes(length));
    assert.equal(sha256Hex(bytes), nodeHash(bytes), `length ${length}`);
  }
});

test('it agrees with Node when fed in arbitrary pieces', async () => {
  const bytes = new Uint8Array(randomBytes(5000));
  const expected = nodeHash(bytes);

  // Every split size from 1 to 70, which covers partial blocks, exact blocks and
  // multi-block writes.
  for (let piece = 1; piece <= 70; piece++) {
    const hasher = new Sha256();
    for (let offset = 0; offset < bytes.length; offset += piece) {
      hasher.update(bytes.subarray(offset, Math.min(offset + piece, bytes.length)));
    }
    assert.equal(hasher.hex(), expected, `piece size ${piece}`);
  }
});

test('one byte at a time is still correct', () => {
  const bytes = new Uint8Array(randomBytes(300));
  const hasher = new Sha256();
  for (const byte of bytes) hasher.update(new Uint8Array([byte]));
  assert.equal(hasher.hex(), nodeHash(bytes));
});

test('the byte counter tracks the input', () => {
  const hasher = new Sha256();
  assert.equal(hasher.bytesHashed, 0);
  hasher.update(new Uint8Array(100));
  hasher.update(new Uint8Array(50));
  assert.equal(hasher.bytesHashed, 150);
});

test('a finalised digest cannot be extended', () => {
  const hasher = new Sha256();
  hasher.update(utf8('abc'));
  hasher.digest();
  assert.throws(() => hasher.update(utf8('more')), /already finalised/);
});

test('update accepts an ArrayBuffer as well as a view', () => {
  const bytes = new Uint8Array(randomBytes(500));
  const hasher = new Sha256();
  hasher.update(bytes.buffer);
  assert.equal(hasher.hex(), nodeHash(bytes));
});

test('dumping the same state twice gives the same answer', () => {
  const bytes = new Uint8Array(randomBytes(200));
  const hasher = new Sha256();
  hasher.update(bytes);
  const first = hasher.hex();
  const second = hasher.hex();
  assert.equal(first, second, 'digest is repeatable once finalised');
});

test('blobs hash without being held in memory', async () => {
  const bytes = new Uint8Array(randomBytes(300_000));
  const blob = new Blob([bytes]);
  const { hex, digest } = await hashBlob(blob);
  assert.equal(hex, nodeHash(bytes));
  assert.equal(digest.length, 32);
  assert.equal(
    [...digest].map((b) => b.toString(16).padStart(2, '0')).join(''),
    hex,
  );
});

test('hashing reports progress and can be cancelled', async () => {
  const blob = new Blob([new Uint8Array(250_000)]);
  const progress = [];
  await hashBlob(blob, { chunkSize: 100_000, onProgress: (p) => progress.push(Number(p.toFixed(2))) });
  assert.ok(progress.length >= 3);
  assert.equal(progress.at(-1), 1);

  const controller = new AbortController();
  controller.abort();
  await assert.rejects(() => hashBlob(blob, { signal: controller.signal }), /cancelled/);
});

test('an empty blob has the empty digest', async () => {
  const { hex } = await hashBlob(new Blob([]));
  assert.equal(hex, 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
});

test('identical content produces identical ids, different content does not', async () => {
  const a = await hashBlob(new Blob([utf8('same bytes')]));
  const b = await hashBlob(new Blob([utf8('same bytes')]));
  const c = await hashBlob(new Blob([utf8('other bytes')]));
  assert.equal(a.hex, b.hex, 'this is what makes deduplication and resume possible');
  assert.notEqual(a.hex, c.hex);
});
