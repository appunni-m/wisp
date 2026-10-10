/**
 * QR Code encoder — byte mode, versions 1-40, error correction levels L/M/Q/H.
 *
 * Written from the ISO/IEC 18004 spec so the app stays dependency-free: a
 * scanner is useless if the thing that draws the code needs a CDN.
 *
 * The tables below (block structure, alignment positions) are validated in two
 * independent ways by the test suite:
 *   1. Every entry is checked against the symbol's computed codeword capacity,
 *      which is derived from the module count rather than from the tables.
 *   2. Every generated symbol is decoded again with an independent decoder
 *      (jsQR) across all versions and error-correction levels.
 * The second check is what catches block-splitting and placement mistakes that
 * a capacity check cannot see.
 */

const EC_LEVEL_BITS = { L: 1, M: 0, Q: 3, H: 2 };
const EC_LEVEL_ORDER = ['L', 'M', 'Q', 'H'];

const MODE_BYTE = 0b0100;

/* ------------------------------------------------------------ GF(256) math */

const EXP = new Uint8Array(512);
const LOG = new Uint8Array(256);
(() => {
  let x = 1;
  for (let i = 0; i < 255; i++) {
    EXP[i] = x;
    LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d;
  }
  for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
})();

const gfMul = (a, b) => (a === 0 || b === 0 ? 0 : EXP[LOG[a] + LOG[b]]);

/** Reed-Solomon generator polynomial of the given degree, leading coefficient first. */
function rsGenerator(degree) {
  let poly = [1];
  for (let i = 0; i < degree; i++) {
    const next = new Array(poly.length + 1).fill(0);
    for (let j = 0; j < poly.length; j++) {
      next[j] ^= poly[j];
      next[j + 1] ^= gfMul(poly[j], EXP[i]);
    }
    poly = next;
  }
  return poly;
}

function rsRemainder(data, degree) {
  const generator = rsGenerator(degree);
  const remainder = new Uint8Array(degree);
  for (const byte of data) {
    const factor = byte ^ remainder[0];
    remainder.copyWithin(0, 1);
    remainder[degree - 1] = 0;
    for (let i = 0; i < degree; i++) remainder[i] ^= gfMul(generator[i + 1], factor);
  }
  return remainder;
}

/* --------------------------------------------------- block structure table */

// Per version (1-40) and level: [ecCodewordsPerBlock, g1Blocks, g1Data, g2Blocks, g2Data]
const BLOCKS = {
  L: [
    [7,1,19,0,0],[10,1,34,0,0],[15,1,55,0,0],[20,1,80,0,0],[26,1,108,0,0],
    [18,2,68,0,0],[20,2,78,0,0],[24,2,97,0,0],[30,2,116,0,0],[18,2,68,2,69],
    [20,4,81,0,0],[24,2,92,2,93],[26,4,107,0,0],[30,3,115,1,116],[22,5,87,1,88],
    [24,5,98,1,99],[28,1,107,5,108],[30,5,120,1,121],[28,3,113,4,114],[28,3,107,5,108],
    [28,4,116,4,117],[28,2,111,7,112],[30,4,121,5,122],[30,6,117,4,118],[26,8,106,4,107],
    [28,10,114,2,115],[30,8,122,4,123],[30,3,117,10,118],[30,7,116,7,117],[30,5,115,10,116],
    [30,13,115,3,116],[30,17,115,0,0],[30,17,115,1,116],[30,13,115,6,116],[30,12,121,7,122],
    [30,6,121,14,122],[30,17,122,4,123],[30,4,122,18,123],[30,20,117,4,118],[30,19,118,6,119],
  ],
  M: [
    [10,1,16,0,0],[16,1,28,0,0],[26,1,44,0,0],[18,2,32,0,0],[24,2,43,0,0],
    [16,4,27,0,0],[18,4,31,0,0],[22,2,38,2,39],[22,3,36,2,37],[26,4,43,1,44],
    [30,1,50,4,51],[22,6,36,2,37],[22,8,37,1,38],[24,4,40,5,41],[24,5,41,5,42],
    [28,7,45,3,46],[28,10,46,1,47],[26,9,43,4,44],[26,3,44,11,45],[26,3,41,13,42],
    [26,17,42,0,0],[28,17,46,0,0],[28,4,47,14,48],[28,6,45,14,46],[28,8,47,13,48],
    [28,19,46,4,47],[28,22,45,3,46],[28,3,45,23,46],[28,21,45,7,46],[28,19,47,10,48],
    [28,2,46,29,47],[28,10,46,23,47],[28,14,46,21,47],[28,14,46,23,47],[28,12,47,26,48],
    [28,6,47,34,48],[28,29,46,14,47],[28,13,46,32,47],[28,40,47,7,48],[28,18,47,31,48],
  ],
  Q: [
    [13,1,13,0,0],[22,1,22,0,0],[18,2,17,0,0],[26,2,24,0,0],[18,2,15,2,16],
    [24,4,19,0,0],[18,2,14,4,15],[22,4,18,2,19],[20,4,16,4,17],[24,6,19,2,20],
    [28,4,22,4,23],[26,4,20,6,21],[24,8,20,4,21],[20,11,16,5,17],[30,5,24,7,25],
    [24,15,19,2,20],[28,1,22,15,23],[28,17,22,1,23],[26,17,21,4,22],[30,15,24,5,25],
    [28,17,22,6,23],[30,7,24,16,25],[30,11,24,14,25],[30,11,24,16,25],[30,7,24,22,25],
    [28,28,22,6,23],[30,8,23,26,24],[30,4,24,31,25],[30,1,23,37,24],[30,15,24,25,25],
    [30,42,24,1,25],[30,10,24,35,25],[30,29,24,19,25],[30,44,24,7,25],[30,39,24,14,25],
    [30,46,24,10,25],[30,49,24,10,25],[30,48,24,14,25],[30,43,24,22,25],[30,34,24,34,25],
  ],
  H: [
    [17,1,9,0,0],[28,1,16,0,0],[22,2,13,0,0],[16,4,9,0,0],[22,2,11,2,12],
    [28,4,15,0,0],[26,4,13,1,14],[26,4,14,2,15],[24,4,12,4,13],[28,6,15,2,16],
    [24,3,12,8,13],[28,7,14,4,15],[22,12,11,4,12],[24,11,12,5,13],[24,11,12,7,13],
    [30,3,15,13,16],[28,2,14,17,15],[28,2,14,19,15],[26,9,13,16,14],[28,15,15,10,16],
    [30,19,16,6,17],[24,34,13,0,0],[30,16,15,14,16],[30,30,16,2,17],[30,22,15,13,16],
    [30,33,16,4,17],[30,12,15,28,16],[30,11,15,31,16],[30,19,15,26,16],[30,23,15,25,16],
    [30,23,15,28,16],[30,19,15,35,16],[30,11,15,46,16],[30,59,16,1,17],[30,22,15,41,16],
    [30,2,15,64,16],[30,24,15,46,16],[30,42,15,32,16],[30,10,15,67,16],[30,20,15,61,16],
  ],
};

// Alignment pattern centres per version; version 1 has none.
const ALIGNMENT = [
  [],[6,18],[6,22],[6,26],[6,30],[6,34],[6,22,38],[6,24,42],[6,26,46],[6,28,50],
  [6,30,54],[6,32,58],[6,34,62],[6,26,46,66],[6,26,48,70],[6,26,50,74],[6,30,54,78],[6,30,56,82],
  [6,30,58,86],[6,34,62,90],[6,28,50,72,94],[6,26,50,74,98],[6,30,54,78,102],[6,28,54,80,106],
  [6,32,58,84,110],[6,30,58,86,114],[6,34,62,90,118],[6,26,50,74,98,122],[6,30,54,78,102,126],
  [6,26,52,78,104,130],[6,30,56,82,108,134],[6,34,60,86,112,138],[6,30,58,86,114,142],
  [6,34,62,90,118,146],[6,30,54,78,102,126,150],[6,24,50,76,102,128,154],[6,28,54,80,106,132,158],
  [6,32,58,84,110,136,162],[6,26,54,82,110,138,166],[6,30,58,86,114,142,170],
];

/**
 * Number of data modules available in a symbol: the whole grid minus finder
 * patterns, separators, timing patterns, alignment patterns, format information,
 * the dark module, and version information. Derived from geometry, not tables —
 * which is what makes it a useful cross-check on the tables above.
 */
export function dataModuleCount(version) {
  let result = (16 * version + 128) * version + 64;
  if (version >= 2) {
    const align = Math.floor(version / 7) + 2;
    result -= (25 * align - 10) * align - 55;
    if (version >= 7) result -= 36;
  }
  return result;
}

export const totalCodewords = (version) => Math.floor(dataModuleCount(version) / 8);

export function blockStructure(version, ecLevel) {
  const row = BLOCKS[ecLevel][version - 1];
  const [ecPerBlock, g1Blocks, g1Data, g2Blocks, g2Data] = row;
  const blocks = [];
  for (let i = 0; i < g1Blocks; i++) blocks.push(g1Data);
  for (let i = 0; i < g2Blocks; i++) blocks.push(g2Data);
  return { ecPerBlock, blocks, totalBlocks: g1Blocks + g2Blocks };
}

export function dataCodewordCount(version, ecLevel) {
  return blockStructure(version, ecLevel).blocks.reduce((sum, n) => sum + n, 0);
}

/**
 * How many payload bytes fit in a symbol. Not simply the codeword count: the
 * 4-bit mode indicator and the character-count field (8 bits up to version 9,
 * 16 bits above) have to come out of the same budget.
 */
export function payloadCapacityBytes(version, ecLevel) {
  const bits = dataCodewordCount(version, ecLevel) * 8;
  const countBits = version <= 9 ? 8 : 16;
  return Math.floor((bits - 4 - countBits) / 8);
}

export function alignmentPositions(version) {
  return ALIGNMENT[version - 1];
}

/* ------------------------------------------------------------- bit buffer */

class BitBuffer {
  bits = [];

  append(value, length) {
    for (let i = length - 1; i >= 0; i--) this.bits.push((value >>> i) & 1);
    return this;
  }

  get length() {
    return this.bits.length;
  }

  toBytes() {
    const bytes = new Uint8Array(Math.ceil(this.bits.length / 8));
    this.bits.forEach((bit, index) => {
      if (bit) bytes[index >> 3] |= 0x80 >> (index & 7);
    });
    return bytes;
  }
}

/* ---------------------------------------------------------- symbol build */

function buildCodewords(bytes, version, ecLevel) {
  const capacityBits = dataCodewordCount(version, ecLevel) * 8;
  const buffer = new BitBuffer();
  buffer.append(MODE_BYTE, 4);
  buffer.append(bytes.length, version <= 9 ? 8 : 16);
  for (const byte of bytes) buffer.append(byte, 8);

  if (buffer.length > capacityBits) {
    throw new Error(`payload does not fit version ${version}-${ecLevel}`);
  }

  buffer.append(0, Math.min(4, capacityBits - buffer.length));
  buffer.append(0, (8 - (buffer.length % 8)) % 8);
  for (let pad = 0xec; buffer.length < capacityBits; pad ^= 0xec ^ 0x11) buffer.append(pad, 8);

  const data = buffer.toBytes();
  const { ecPerBlock, blocks } = blockStructure(version, ecLevel);

  const dataBlocks = [];
  const ecBlocks = [];
  let offset = 0;
  for (const size of blocks) {
    const chunk = data.subarray(offset, offset + size);
    offset += size;
    dataBlocks.push(chunk);
    ecBlocks.push(rsRemainder(chunk, ecPerBlock));
  }

  const result = new Uint8Array(data.length + ecPerBlock * blocks.length);
  let index = 0;
  const longest = Math.max(...blocks);
  for (let i = 0; i < longest; i++) {
    for (const block of dataBlocks) if (i < block.length) result[index++] = block[i];
  }
  for (let i = 0; i < ecPerBlock; i++) {
    for (const block of ecBlocks) result[index++] = block[i];
  }
  return result;
}

const getBit = (value, index) => ((value >>> index) & 1) !== 0;

function maskPredicate(mask, x, y) {
  switch (mask) {
    case 0: return (x + y) % 2 === 0;
    case 1: return y % 2 === 0;
    case 2: return x % 3 === 0;
    case 3: return (x + y) % 3 === 0;
    case 4: return (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0;
    case 5: return ((x * y) % 2) + ((x * y) % 3) === 0;
    case 6: return (((x * y) % 2) + ((x * y) % 3)) % 2 === 0;
    case 7: return (((x + y) % 2) + ((x * y) % 3)) % 2 === 0;
    default: throw new Error(`bad mask ${mask}`);
  }
}

class Symbol {
  constructor(version) {
    this.version = version;
    this.size = version * 4 + 17;
    this.modules = new Uint8Array(this.size * this.size);
    this.isFunction = new Uint8Array(this.size * this.size);
  }

  setFunction(x, y, dark) {
    this.modules[y * this.size + x] = dark ? 1 : 0;
    this.isFunction[y * this.size + x] = 1;
  }

  drawFunctionPatterns() {
    const { size } = this;
    for (let i = 0; i < size; i++) {
      this.setFunction(6, i, i % 2 === 0);
      this.setFunction(i, 6, i % 2 === 0);
    }
    for (const [cx, cy] of [[3, 3], [size - 4, 3], [3, size - 4]]) {
      for (let dy = -4; dy <= 4; dy++) {
        for (let dx = -4; dx <= 4; dx++) {
          const x = cx + dx;
          const y = cy + dy;
          if (x < 0 || x >= size || y < 0 || y >= size) continue;
          const distance = Math.max(Math.abs(dx), Math.abs(dy));
          this.setFunction(x, y, distance !== 2 && distance !== 4);
        }
      }
    }

    const positions = alignmentPositions(this.version);
    for (const cy of positions) {
      for (const cx of positions) {
        const cornerish =
          (cx === 6 && cy === 6) ||
          (cx === 6 && cy === size - 7) ||
          (cx === size - 7 && cy === 6);
        if (cornerish) continue;
        for (let dy = -2; dy <= 2; dy++) {
          for (let dx = -2; dx <= 2; dx++) {
            this.setFunction(cx + dx, cy + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
          }
        }
      }
    }

    this.drawFormatBits(0);
    this.drawVersionBits();
  }

  drawFormatBits(mask) {
    const { size } = this;
    const data = (EC_LEVEL_BITS[this.ecLevel] << 3) | mask;
    let remainder = data;
    for (let i = 0; i < 10; i++) remainder = (remainder << 1) ^ ((remainder >>> 9) * 0x537);
    const bits = ((data << 10) | remainder) ^ 0x5412;

    for (let i = 0; i <= 5; i++) this.setFunction(8, i, getBit(bits, i));
    this.setFunction(8, 7, getBit(bits, 6));
    this.setFunction(8, 8, getBit(bits, 7));
    this.setFunction(7, 8, getBit(bits, 8));
    for (let i = 9; i < 15; i++) this.setFunction(14 - i, 8, getBit(bits, i));

    for (let i = 0; i < 8; i++) this.setFunction(size - 1 - i, 8, getBit(bits, i));
    for (let i = 8; i < 15; i++) this.setFunction(8, size - 15 + i, getBit(bits, i));
    this.setFunction(8, size - 8, true);
  }

  drawVersionBits() {
    if (this.version < 7) return;
    let remainder = this.version;
    for (let i = 0; i < 12; i++) remainder = (remainder << 1) ^ ((remainder >>> 11) * 0x1f25);
    const bits = (this.version << 12) | remainder;
    for (let i = 0; i < 18; i++) {
      const bit = getBit(bits, i);
      const a = this.size - 11 + (i % 3);
      const b = Math.floor(i / 3);
      this.setFunction(a, b, bit);
      this.setFunction(b, a, bit);
    }
  }

  drawCodewords(codewords) {
    const { size } = this;
    let index = 0;
    for (let right = size - 1; right >= 1; right -= 2) {
      if (right === 6) right = 5;
      for (let vertical = 0; vertical < size; vertical++) {
        for (let j = 0; j < 2; j++) {
          const x = right - j;
          const upward = ((right + 1) & 2) === 0;
          const y = upward ? size - 1 - vertical : vertical;
          const position = y * size + x;
          if (!this.isFunction[position] && index < codewords.length * 8) {
            this.modules[position] = getBit(codewords[index >> 3], 7 - (index & 7)) ? 1 : 0;
            index++;
          }
        }
      }
    }
  }

  applyMask(mask) {
    for (let y = 0; y < this.size; y++) {
      for (let x = 0; x < this.size; x++) {
        const position = y * this.size + x;
        if (!this.isFunction[position] && maskPredicate(mask, x, y)) {
          this.modules[position] ^= 1;
        }
      }
    }
  }

  penalty() {
    const { size, modules } = this;
    let score = 0;

    // Rule 1: runs of five or more same-coloured modules.
    for (let y = 0; y < size; y++) {
      let runColour = -1;
      let runLength = 0;
      for (let x = 0; x < size; x++) {
        const colour = modules[y * size + x];
        if (colour === runColour) {
          runLength++;
          if (runLength === 5) score += 3;
          else if (runLength > 5) score++;
        } else {
          runColour = colour;
          runLength = 1;
        }
      }
    }
    for (let x = 0; x < size; x++) {
      let runColour = -1;
      let runLength = 0;
      for (let y = 0; y < size; y++) {
        const colour = modules[y * size + x];
        if (colour === runColour) {
          runLength++;
          if (runLength === 5) score += 3;
          else if (runLength > 5) score++;
        } else {
          runColour = colour;
          runLength = 1;
        }
      }
    }

    // Rule 2: 2x2 blocks of one colour.
    for (let y = 0; y < size - 1; y++) {
      for (let x = 0; x < size - 1; x++) {
        const colour = modules[y * size + x];
        if (
          colour === modules[y * size + x + 1] &&
          colour === modules[(y + 1) * size + x] &&
          colour === modules[(y + 1) * size + x + 1]
        ) {
          score += 3;
        }
      }
    }

    // Rule 3: finder-like 1:1:3:1:1 patterns with four light modules beside them.
    const patternA = [1, 0, 1, 1, 1, 0, 1, 0, 0, 0, 0];
    const patternB = [0, 0, 0, 0, 1, 0, 1, 1, 1, 0, 1];
    const matches = (get, start, pattern) => {
      for (let i = 0; i < pattern.length; i++) if (get(start + i) !== pattern[i]) return false;
      return true;
    };
    for (let y = 0; y < size; y++) {
      const row = (x) => modules[y * size + x];
      for (let x = 0; x <= size - 11; x++) {
        if (matches(row, x, patternA) || matches(row, x, patternB)) score += 40;
      }
    }
    for (let x = 0; x < size; x++) {
      const column = (y) => modules[y * size + x];
      for (let y = 0; y <= size - 11; y++) {
        if (matches(column, y, patternA) || matches(column, y, patternB)) score += 40;
      }
    }

    // Rule 4: deviation from an even balance of dark and light.
    let dark = 0;
    for (const module of modules) dark += module;
    const total = size * size;
    const percent = Math.round((dark * 100) / total);
    score += Math.floor(Math.abs(percent - 50) / 5) * 10;

    return score;
  }
}

/* ----------------------------------------------------------------- public */

const LEVELS_FOR_FALLBACK = EC_LEVEL_ORDER;

/**
 * Encode `text` (UTF-8, byte mode) as a QR symbol.
 * Returns { matrix, size, version, ecLevel, mask } where matrix[y][x] is a boolean.
 *
 * `mask` forces a specific mask pattern (0-7). Normally the best-scoring mask is
 * chosen automatically; forcing one makes output reproducible for tests.
 */
export function encodeQr(text, { ecLevel = 'M', minVersion = 1, maxVersion = 40, mask = null } = {}) {
  if (!(ecLevel in EC_LEVEL_BITS)) throw new Error(`unknown error correction level: ${ecLevel}`);
  const bytes = new TextEncoder().encode(text);

  let version = 0;
  for (let v = minVersion; v <= maxVersion; v++) {
    if (bytes.length <= payloadCapacityBytes(v, ecLevel)) {
      version = v;
      break;
    }
  }
  if (!version) {
    throw new Error(
      `payload of ${bytes.length} bytes does not fit a version ${maxVersion}-${ecLevel} symbol`,
    );
  }

  return encodeAtVersion(bytes, version, ecLevel, mask);
}

function encodeAtVersion(bytes, version, ecLevel, forcedMask = null) {
  const codewords = buildCodewords(bytes, version, ecLevel);

  if (forcedMask !== null) {
    const symbol = buildSymbol(codewords, version, ecLevel, forcedMask);
    return toResult(symbol, forcedMask, ecLevel);
  }

  let best = null;
  for (let mask = 0; mask < 8; mask++) {
    const symbol = buildSymbol(codewords, version, ecLevel, mask);
    const score = symbol.penalty();
    if (!best || score < best.score) best = { symbol, mask, score };
  }
  return toResult(best.symbol, best.mask, ecLevel);
}

function buildSymbol(codewords, version, ecLevel, mask) {
  const symbol = new Symbol(version);
  symbol.ecLevel = ecLevel;
  symbol.drawFunctionPatterns();
  symbol.drawCodewords(codewords);
  symbol.applyMask(mask);
  symbol.drawFormatBits(mask);
  return symbol;
}

function toResult(symbol, mask, ecLevel) {
  const matrix = [];
  for (let y = 0; y < symbol.size; y++) {
    const row = [];
    for (let x = 0; x < symbol.size; x++) row.push(symbol.modules[y * symbol.size + x] === 1);
    matrix.push(row);
  }
  return { matrix, size: symbol.size, version: symbol.version, ecLevel, mask };
}

/** Draw a symbol onto a canvas, scaled with a quiet zone. */
export function drawQrToCanvas(qr, canvas, { scale, quietZone = 4, dark = '#000000', light = '#ffffff' } = {}) {
  const moduleScale = scale ?? Math.max(2, Math.floor(480 / (qr.size + quietZone * 2)));
  const pixels = (qr.size + quietZone * 2) * moduleScale;
  canvas.width = pixels;
  canvas.height = pixels;
  const context = canvas.getContext('2d');
  context.fillStyle = light;
  context.fillRect(0, 0, pixels, pixels);
  context.fillStyle = dark;
  for (let y = 0; y < qr.size; y++) {
    for (let x = 0; x < qr.size; x++) {
      if (!qr.matrix[y][x]) continue;
      context.fillRect(
        (x + quietZone) * moduleScale,
        (y + quietZone) * moduleScale,
        moduleScale,
        moduleScale,
      );
    }
  }
  return { pixels, moduleScale };
}

/** Plain-text rendering, handy for tests and terminals. */
export function qrToText(qr, { quietZone = 2, dark = '██', light = '  ' } = {}) {
  const rows = [];
  const blank = light.repeat(qr.size + quietZone * 2);
  for (let i = 0; i < quietZone; i++) rows.push(blank);
  for (let y = 0; y < qr.size; y++) {
    let row = light.repeat(quietZone);
    for (let x = 0; x < qr.size; x++) row += qr.matrix[y][x] ? dark : light;
    rows.push(row + light.repeat(quietZone));
  }
  for (let i = 0; i < quietZone; i++) rows.push(blank);
  return rows.join('\n');
}

/**
 * Terminal rendering with explicit colours.
 *
 * Polarity matters: a QR code is meant to be dark-on-light, and a terminal with
 * a dark theme would invert it if the code were drawn with plain text. Setting
 * both background colours explicitly makes the code scannable whatever the
 * terminal theme is.
 */
export function qrToAnsi(qr, { quietZone = 3, dark = '\x1b[40m  ', light = '\x1b[47m  ' } = {}) {
  const reset = '\x1b[0m';
  const rows = [];
  const blank = light.repeat(qr.size + quietZone * 2) + reset;
  for (let i = 0; i < quietZone; i++) rows.push(blank);
  for (let y = 0; y < qr.size; y++) {
    let row = light.repeat(quietZone);
    for (let x = 0; x < qr.size; x++) row += qr.matrix[y][x] ? dark : light;
    rows.push(row + light.repeat(quietZone) + reset);
  }
  for (let i = 0; i < quietZone; i++) rows.push(blank);
  return rows.join('\n');
}

export { LEVELS_FOR_FALLBACK as EC_LEVELS, EC_LEVEL_BITS };
