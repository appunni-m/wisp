/**
 * Wire codec primitives: byte packing, base64url, raw DEFLATE.
 *
 * Deliberately free of DOM and Node-specific globals so the exact same module
 * runs in the browser and under `node --test`.
 */

export class CodecError extends Error {
  constructor(message) {
    super(message);
    this.name = 'CodecError';
  }
}

const TEXT_ENCODER = new TextEncoder();
const TEXT_DECODER = new TextDecoder();

export const utf8Encode = (s) => TEXT_ENCODER.encode(s);
export const utf8Decode = (b) => TEXT_DECODER.decode(b);

export function concatBytes(...chunks) {
  let total = 0;
  for (const c of chunks) total += c.length;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.length;
  }
  return out;
}

/** Constant-time-ish comparison; not secret-dependent in a way that matters here. */
export function bytesEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

export function bytesToHex(bytes) {
  let out = '';
  for (const b of bytes) out += b.toString(16).padStart(2, '0');
  return out;
}

export function hexToBytes(hex) {
  const clean = hex.replace(/[^0-9a-fA-F]/g, '');
  if (clean.length % 2 !== 0) throw new CodecError('hex string has odd length');
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  return out;
}

/** Growable big-endian writer. */
export class ByteWriter {
  #chunks = [];
  #length = 0;

  #push(bytes) {
    this.#chunks.push(bytes);
    this.#length += bytes.length;
    return this;
  }

  u8(value) {
    if (!Number.isInteger(value) || value < 0 || value > 0xff) {
      throw new CodecError(`u8 out of range: ${value}`);
    }
    return this.#push(new Uint8Array([value]));
  }

  u16(value) {
    if (!Number.isInteger(value) || value < 0 || value > 0xffff) {
      throw new CodecError(`u16 out of range: ${value}`);
    }
    const buf = new Uint8Array(2);
    new DataView(buf.buffer).setUint16(0, value, false);
    return this.#push(buf);
  }

  u32(value) {
    if (!Number.isInteger(value) || value < 0 || value > 0xffffffff) {
      throw new CodecError(`u32 out of range: ${value}`);
    }
    const buf = new Uint8Array(4);
    new DataView(buf.buffer).setUint32(0, value, false);
    return this.#push(buf);
  }

  u64(value) {
    const big = typeof value === 'bigint' ? value : BigInt(value);
    if (big < 0n || big > 0xffffffffffffffffn) {
      throw new CodecError(`u64 out of range: ${value}`);
    }
    const buf = new Uint8Array(8);
    new DataView(buf.buffer).setBigUint64(0, big, false);
    return this.#push(buf);
  }

  bytes(array) {
    if (!(array instanceof Uint8Array)) throw new CodecError('bytes() needs a Uint8Array');
    return this.#push(array);
  }

  /** Length-prefixed (u8) UTF-8 string; max 255 bytes. */
  str(value) {
    const encoded = utf8Encode(value ?? '');
    if (encoded.length > 255) throw new CodecError('string too long for u8 prefix');
    this.u8(encoded.length);
    return this.#push(encoded);
  }

  /** Length-prefixed (u16) UTF-8 string; max 65535 bytes. */
  str16(value) {
    const encoded = utf8Encode(value ?? '');
    if (encoded.length > 0xffff) throw new CodecError('string too long for u16 prefix');
    this.u16(encoded.length);
    return this.#push(encoded);
  }

  get length() {
    return this.#length;
  }

  build() {
    return concatBytes(...this.#chunks);
  }
}

/** Bounds-checked big-endian reader. */
export class ByteReader {
  #view;
  #bytes;
  offset = 0;

  constructor(bytes) {
    if (!(bytes instanceof Uint8Array)) throw new CodecError('ByteReader needs a Uint8Array');
    this.#bytes = bytes;
    this.#view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }

  #need(count) {
    if (this.offset + count > this.#bytes.length) {
      throw new CodecError(`truncated payload: need ${count} byte(s) at offset ${this.offset}`);
    }
  }

  u8() {
    this.#need(1);
    return this.#view.getUint8(this.offset++);
  }

  u16() {
    this.#need(2);
    const value = this.#view.getUint16(this.offset, false);
    this.offset += 2;
    return value;
  }

  u32() {
    this.#need(4);
    const value = this.#view.getUint32(this.offset, false);
    this.offset += 4;
    return value;
  }

  u64() {
    this.#need(8);
    const value = this.#view.getBigUint64(this.offset, false);
    this.offset += 8;
    return value;
  }

  bytes(count) {
    this.#need(count);
    const slice = this.#bytes.subarray(this.offset, this.offset + count);
    this.offset += count;
    return slice;
  }

  str() {
    return utf8Decode(this.bytes(this.u8()));
  }

  str16() {
    return utf8Decode(this.bytes(this.u16()));
  }

  get remaining() {
    return this.#bytes.length - this.offset;
  }

  get eof() {
    return this.remaining === 0;
  }
}

const B64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
const B64_LOOKUP = (() => {
  const table = new Int16Array(128).fill(-1);
  for (let i = 0; i < B64_ALPHABET.length; i++) table[B64_ALPHABET.charCodeAt(i)] = i;
  return table;
})();

/** URL-safe base64 without padding — safe inside a URL fragment or a chat message. */
export function b64urlEncode(bytes) {
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i];
    const b1 = bytes[i + 1];
    const b2 = bytes[i + 2];
    out += B64_ALPHABET[b0 >> 2];
    out += B64_ALPHABET[((b0 & 0x03) << 4) | ((b1 ?? 0) >> 4)];
    if (b1 === undefined) break;
    out += B64_ALPHABET[((b1 & 0x0f) << 2) | ((b2 ?? 0) >> 6)];
    if (b2 === undefined) break;
    out += B64_ALPHABET[b2 & 0x3f];
  }
  return out;
}

export function b64urlDecode(text) {
  const clean = String(text).replace(/[^A-Za-z0-9_-]/g, '');
  const out = new Uint8Array(Math.floor((clean.length * 6) / 8));
  let buffer = 0;
  let bits = 0;
  let index = 0;
  for (const char of clean) {
    const code = char.charCodeAt(0);
    const value = code < 128 ? B64_LOOKUP[code] : -1;
    if (value < 0) throw new CodecError(`invalid base64url character: ${char}`);
    buffer = (buffer << 6) | value;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[index++] = (buffer >> bits) & 0xff;
    }
  }
  return out.subarray(0, index);
}

/**
 * `CompressionStream('deflate-raw')` is available in Chrome 103+, Safari 16.4+,
 * Firefox 113+ and Node 18+. Callers must handle its absence (older Safari).
 */
export const supportsCompression = () =>
  typeof CompressionStream === 'function' && typeof DecompressionStream === 'function';

export async function deflateRaw(bytes) {
  const stream = new CompressionStream('deflate-raw');
  const writer = stream.writable.getWriter();
  writer.write(bytes);
  writer.close();
  return new Uint8Array(await new Response(stream.readable).arrayBuffer());
}

export async function inflateRaw(bytes) {
  const stream = new DecompressionStream('deflate-raw');
  const writer = stream.writable.getWriter();
  writer.write(bytes);
  writer.close();
  return new Uint8Array(await new Response(stream.readable).arrayBuffer());
}

/** Best-effort compression: returns the original bytes when deflate doesn't help. */
export async function maybeDeflate(bytes) {
  if (!supportsCompression()) return { bytes, compressed: false };
  try {
    const deflated = await deflateRaw(bytes);
    if (deflated.length < bytes.length) return { bytes: deflated, compressed: true };
  } catch {
    /* fall through to uncompressed */
  }
  return { bytes, compressed: false };
}

export async function inflateIfNeeded(bytes, compressed) {
  if (!compressed) return bytes;
  if (!supportsCompression()) {
    throw new CodecError('this code is compressed but this browser cannot decompress it');
  }
  return inflateRaw(bytes);
}
