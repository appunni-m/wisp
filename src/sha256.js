/**
 * Incremental SHA-256.
 *
 * The Web Crypto API can only digest a buffer it holds entirely in memory, which
 * is the wrong shape for a 100 MB video on a phone: it would mean a 100 MB
 * allocation on top of the file itself. This implementation takes bytes as they
 * stream past, so hashing works at any size and can report progress.
 *
 * It also gives the transfer layer its file identity: the digest *is* the file
 * id, so identical files deduplicate and a resumed transfer can be matched to
 * the one that was interrupted.
 *
 * Verified against the NIST vectors and cross-checked against Node's own
 * `crypto` over random inputs.
 */

const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

const rotr = (value, bits) => (value >>> bits) | (value << (32 - bits));

export class Sha256 {
  #state = new Uint32Array([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
  ]);
  #buffer = new Uint8Array(64);
  #bufferLength = 0;
  #totalBytes = 0;
  #finished = false;
  #result = null;
  #schedule = new Uint32Array(64);

  get bytesHashed() {
    return this.#totalBytes;
  }

  update(bytes) {
    if (this.#finished) throw new Error('this digest is already finalised');
    return this.#absorb(bytes);
  }

  /** Absorb bytes. No finalisation guard: `digest()` uses this for its padding. */
  #absorb(bytes) {
    const input = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    this.#totalBytes += input.length;

    let offset = 0;

    // Top up a partial block first.
    if (this.#bufferLength > 0) {
      const needed = 64 - this.#bufferLength;
      const take = Math.min(needed, input.length);
      this.#buffer.set(input.subarray(0, take), this.#bufferLength);
      this.#bufferLength += take;
      offset = take;
      if (this.#bufferLength === 64) {
        this.#compress(this.#buffer, 0);
        this.#bufferLength = 0;
      }
    }

    // Then whole blocks straight from the input, with no copying.
    while (offset + 64 <= input.length) {
      this.#compress(input, offset);
      offset += 64;
    }

    // Whatever is left waits for the next call.
    if (offset < input.length) {
      this.#buffer.set(input.subarray(offset), 0);
      this.#bufferLength = input.length - offset;
    }
    return this;
  }

  /**
   * Finalise and return the 32-byte digest. Safe to call more than once; the
   * instance will not absorb anything further.
   */
  digest() {
    if (!this.#finished) {
      this.#finished = true;
      const bitLength = this.#totalBytes * 8;
      // 0x80, then zeros, then the 64-bit length.
      const padding = new Uint8Array((this.#bufferLength < 56 ? 56 : 120) - this.#bufferLength + 8);
      padding[0] = 0x80;
      const view = new DataView(padding.buffer);
      // A browser tab cannot reach 2^32 bits of input, but the high word is
      // written anyway so the encoding is correct rather than merely adequate.
      view.setUint32(padding.length - 8, Math.floor(bitLength / 0x100000000), false);
      view.setUint32(padding.length - 4, bitLength >>> 0, false);
      this.#absorb(padding);
      this.#result = new Uint8Array(32);
      const out = new DataView(this.#result.buffer);
      for (let i = 0; i < 8; i++) out.setUint32(i * 4, this.#state[i], false);
    }
    return this.#result;
  }

  hex() {
    return [...this.digest()].map((b) => b.toString(16).padStart(2, '0')).join('');
  }

  #compress(block, offset) {
    const w = this.#schedule;

    for (let i = 0; i < 16; i++) {
      const j = offset + i * 4;
      w[i] = (block[j] << 24) | (block[j + 1] << 16) | (block[j + 2] << 8) | block[j + 3];
    }
    for (let i = 16; i < 64; i++) {
      const s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3);
      const s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) | 0;
    }

    let [a, b, c, d, e, f, g, h] = this.#state;

    for (let i = 0; i < 64; i++) {
      const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const ch = (e & f) ^ (~e & g);
      const temp1 = (h + S1 + ch + K[i] + w[i]) | 0;
      const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const temp2 = (S0 + maj) | 0;

      h = g;
      g = f;
      f = e;
      e = (d + temp1) | 0;
      d = c;
      c = b;
      b = a;
      a = (temp1 + temp2) | 0;
    }

    this.#state[0] = (this.#state[0] + a) | 0;
    this.#state[1] = (this.#state[1] + b) | 0;
    this.#state[2] = (this.#state[2] + c) | 0;
    this.#state[3] = (this.#state[3] + d) | 0;
    this.#state[4] = (this.#state[4] + e) | 0;
    this.#state[5] = (this.#state[5] + f) | 0;
    this.#state[6] = (this.#state[6] + g) | 0;
    this.#state[7] = (this.#state[7] + h) | 0;
  }
}

export function sha256Hex(bytes) {
  return new Sha256().update(bytes).hex();
}

/** Default piece size for the manifest: 16 chunks of 16 KB. */
export const PIECE_SIZE = 256 * 1024;

export const toHex = (bytes) => [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');

/**
 * Hash a Blob or File without holding it in memory, producing both the file's
 * identity and a hash per piece.
 *
 * The piece hashes are what allow a file to be fetched from several places at
 * once: a chunk can be checked the moment its piece completes, so a peer that
 * serves rubbish is caught immediately instead of after a whole-file download.
 * They cost almost nothing here because the file is already being read once.
 *
 * `onProgress` is called with 0..1 so a large file can show that something is
 * happening, and `signal` lets a cancelled send stop the work.
 */
export async function hashBlob(
  blob,
  { chunkSize = 1024 * 1024, pieceSize = PIECE_SIZE, onProgress, signal } = {},
) {
  const wholeFile = new Sha256();
  const total = blob.size || 1;
  const pieces = [];
  let pieceHasher = new Sha256();
  let inPiece = 0;

  for (let offset = 0; offset < blob.size; offset += chunkSize) {
    if (signal?.aborted) throw new Error('hashing was cancelled');
    const slice = blob.slice(offset, Math.min(offset + chunkSize, blob.size));
    const bytes = new Uint8Array(await slice.arrayBuffer());

    wholeFile.update(bytes);

    // Feed the piece hasher a piece at a time, so a piece never has to be held
    // in memory in full.
    let read = 0;
    while (read < bytes.length) {
      const room = pieceSize - inPiece;
      const take = Math.min(room, bytes.length - read);
      pieceHasher.update(bytes.subarray(read, read + take));
      inPiece += take;
      read += take;
      if (inPiece === pieceSize) {
        pieces.push(toHex(pieceHasher.digest()));
        pieceHasher = new Sha256();
        inPiece = 0;
      }
    }

    onProgress?.(Math.min(1, (offset + chunkSize) / total));
  }

  // An empty file still has a digest and one (empty) piece.
  if (blob.size === 0) onProgress?.(1);
  if (inPiece > 0 || pieces.length === 0) pieces.push(toHex(pieceHasher.digest()));

  return {
    digest: wholeFile.digest(),
    hex: toHex(wholeFile.digest()),
    pieceSize,
    pieceHashes: pieces,
  };
}
