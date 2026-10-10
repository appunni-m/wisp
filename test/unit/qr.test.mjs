/**
 * The QR encoder is verified two independent ways:
 *
 *   1. Every block-structure entry is checked against the symbol's codeword
 *      capacity, which is computed from module geometry rather than from the
 *      table. A typo in the table cannot survive this.
 *   2. Every generated symbol is decoded with jsQR — a completely separate
 *      implementation. This is what catches block-splitting, interleaving,
 *      alignment, placement and masking errors that a capacity check cannot see.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import jsQR from 'jsqr';

import {
  encodeQr,
  dataModuleCount,
  totalCodewords,
  dataCodewordCount,
  payloadCapacityBytes,
  blockStructure,
  alignmentPositions,
  drawQrToCanvas,
  qrToText,
  qrToAnsi,
  EC_LEVELS,
} from '../../src/qr.js';

/** Paint a symbol into the RGBA buffer jsQR expects. */
function render(qr, { scale = 4, quietZone = 4 } = {}) {
  const size = (qr.size + quietZone * 2) * scale;
  const data = new Uint8ClampedArray(size * size * 4).fill(255);
  for (let y = 0; y < qr.size; y++) {
    for (let x = 0; x < qr.size; x++) {
      if (!qr.matrix[y][x]) continue;
      for (let dy = 0; dy < scale; dy++) {
        for (let dx = 0; dx < scale; dx++) {
          const px = (x + quietZone) * scale + dx;
          const py = (y + quietZone) * scale + dy;
          const offset = (py * size + px) * 4;
          data[offset] = 0;
          data[offset + 1] = 0;
          data[offset + 2] = 0;
        }
      }
    }
  }
  return { data, size };
}

function decode(qr, options) {
  const { data, size } = render(qr, options);
  const result = jsQR(data, size, size);
  return result ? result.data : null;
}

test('codeword capacity matches the published values', () => {
  assert.equal(totalCodewords(1), 26);
  assert.equal(totalCodewords(2), 44);
  assert.equal(totalCodewords(7), 196);
  assert.equal(totalCodewords(40), 3706);
  assert.equal(dataModuleCount(1), 208);
});

test('every block-structure entry matches the symbol capacity', () => {
  for (const level of EC_LEVELS) {
    for (let version = 1; version <= 40; version++) {
      const { ecPerBlock, blocks, totalBlocks } = blockStructure(version, level);
      const dataCodewords = blocks.reduce((sum, n) => sum + n, 0);
      const used = dataCodewords + ecPerBlock * totalBlocks;
      assert.equal(
        used,
        totalCodewords(version),
        `version ${version}-${level}: table says ${used} codewords, geometry says ${totalCodewords(version)}`,
      );
      assert.equal(dataCodewords, dataCodewordCount(version, level));
    }
  }
});

test('data capacities match the published values for spot-checked versions', () => {
  assert.equal(dataCodewordCount(1, 'L'), 19);
  assert.equal(dataCodewordCount(1, 'M'), 16);
  assert.equal(dataCodewordCount(1, 'Q'), 13);
  assert.equal(dataCodewordCount(1, 'H'), 9);
  assert.equal(dataCodewordCount(4, 'M'), 64);
  assert.equal(dataCodewordCount(10, 'L'), 274);
});

test('alignment positions are well formed', () => {
  assert.deepEqual(alignmentPositions(1), []);
  assert.deepEqual(alignmentPositions(2), [6, 18]);
  assert.deepEqual(alignmentPositions(7), [6, 22, 38]);
  for (let version = 2; version <= 40; version++) {
    const positions = alignmentPositions(version);
    const size = version * 4 + 17;
    assert.equal(positions[0], 6, `version ${version} starts at 6`);
    assert.equal(positions.at(-1), size - 7, `version ${version} ends at size-7`);
    assert.equal(positions.length, Math.floor(version / 7) + 2, `version ${version} count`);
    for (let i = 1; i < positions.length; i++) {
      assert.ok(positions[i] > positions[i - 1], `version ${version} is increasing`);
    }
  }
});

test('finder patterns sit in the three corners', () => {
  const qr = encodeQr('finder check');
  const { size, matrix } = qr;
  const corners = [
    [0, 0],
    [size - 7, 0],
    [0, size - 7],
  ];
  for (const [ox, oy] of corners) {
    // A finder pattern is a dark 7x7 ring: dark border, light ring, dark 3x3 core.
    assert.ok(matrix[oy][ox], 'outer corner is dark');
    assert.ok(matrix[oy + 1][ox + 1] === false, 'one module in is light');
    assert.ok(matrix[oy + 2][ox + 2], 'core is dark');
    assert.ok(matrix[oy + 3][ox + 3], 'core centre is dark');
  }
  // The fourth corner must not hold a finder pattern.
  assert.equal(matrix[size - 1][size - 1], false);
});

test('symbol geometry follows the version', () => {
  for (const version of [1, 2, 7, 10, 20, 40]) {
    const qr = encodeQr('x'.repeat(payloadCapacityBytes(version, 'L')), {
      ecLevel: 'L',
      minVersion: version,
      maxVersion: version,
    });
    assert.equal(qr.version, version);
    assert.equal(qr.size, version * 4 + 17);
    assert.equal(qr.matrix.length, qr.size);
    assert.equal(qr.matrix[0].length, qr.size);
  }
});

test('an independent decoder reads back every version and level', () => {
  // All 160 combinations, each filled to capacity so that multi-block
  // interleaving (including the shorter second group) is fully exercised.
  let checked = 0;
  for (const level of EC_LEVELS) {
    for (let version = 1; version <= 40; version++) {
      const capacity = payloadCapacityBytes(version, level);
      // jsQR cannot read version 23-L (see the reference-comparison test below);
      // that one combination is verified module-by-module instead.
      if (version === 23 && level === 'L') continue;
      const text =
        `v${version}${level}:`.padEnd(Math.min(capacity, 12), '.') +
        'A'.repeat(Math.max(0, capacity - 12));
      const qr = encodeQr(text, { ecLevel: level, minVersion: version, maxVersion: version });
      assert.equal(qr.version, version, `expected version ${version}-${level}`);
      assert.equal(decode(qr, { scale: version >= 20 ? 3 : 4 }), text, `jsQR failed on version ${version}-${level}`);
      checked++;
    }
  }
  assert.equal(checked, 159, '159 of 160 combinations decoded; 23-L excluded');
});

test('an independent decoder reads back the largest symbols', () => {
  for (const version of [20, 27, 33, 40]) {
    const capacity = payloadCapacityBytes(version, 'L');
    const text = 'BIG-' + 'z'.repeat(capacity - 4);
    const qr = encodeQr(text, { ecLevel: 'L', minVersion: version, maxVersion: version });
    assert.equal(decode(qr, { scale: 3 }), text, `jsQR failed on version ${version}`);
  }
});

test('version selection picks the smallest symbol that fits', () => {
  const short = encodeQr('hi');
  assert.equal(short.version, 1, 'two characters fit version 1');

  // 19 data codewords minus 2 header bytes = 17 bytes of payload at 1-L.
  assert.equal(encodeQr('a'.repeat(17), { ecLevel: 'L' }).version, 1);
  assert.equal(encodeQr('a'.repeat(18), { ecLevel: 'L' }).version, 2);
});

test('a realistic invite code survives the round trip', () => {
  // Same shape as a real invite: prefix, base64url payload, ~410 characters.
  const code = `P2P1z-${'Ab3_-9XyZ'.repeat(50)}`.slice(0, 410);
  const qr = encodeQr(code, { ecLevel: 'M' });
  assert.ok(qr.version >= 13 && qr.version <= 16, `dense but sane, got version ${qr.version}`);
  assert.equal(decode(qr, { scale: 3 }), code);
  console.log(`      invite QR: version ${qr.version} (${qr.size}x${qr.size} modules), ECC ${qr.ecLevel}`);
});

test('unicode and binary-ish payloads round-trip', () => {
  for (const text of ['héllo wörld', '🎉 party', 'tab\there', 'line\nbreak', '{"json":true}']) {
    assert.equal(decode(encodeQr(text)), text, `failed on ${JSON.stringify(text)}`);
  }
});

test('payloads that do not fit are refused clearly', () => {
  assert.throws(
    () => encodeQr('x'.repeat(30), { ecLevel: 'H', maxVersion: 1 }),
    /does not fit/,
  );
  assert.throws(() => encodeQr('x', { ecLevel: 'Z' }), /unknown error correction level/);
});

test('encoder output is deterministic', () => {
  const a = encodeQr('deterministic', { ecLevel: 'Q' });
  const b = encodeQr('deterministic', { ecLevel: 'Q' });
  assert.equal(a.mask, b.mask);
  assert.deepEqual(a.matrix, b.matrix);
});

test('canvas rendering produces an image with the requested geometry', () => {
  const qr = encodeQr('canvas');
  const calls = [];
  const context = {
    fillStyle: '',
    fillRect: (...args) => calls.push([context.fillStyle, ...args]),
    scale: 1,
  };
  const canvas = { width: 0, height: 0, getContext: () => context };
  const { pixels, moduleScale } = drawQrToCanvas(qr, canvas, { scale: 6, quietZone: 4 });

  assert.equal(moduleScale, 6);
  assert.equal(pixels, (qr.size + 8) * 6);
  assert.equal(canvas.width, pixels);
  assert.equal(canvas.height, pixels);

  const background = calls[0];
  assert.equal(background[0], '#ffffff');
  assert.deepEqual(background.slice(1), [0, 0, pixels, pixels]);

  const darkModules = qr.matrix.flat().filter(Boolean).length;
  assert.equal(calls.length - 1, darkModules, 'one fillRect per dark module');
  for (const [, x, y, w, h] of calls.slice(1)) {
    assert.equal(w, 6);
    assert.equal(h, 6);
    assert.ok(x >= 4 * 6 && y >= 4 * 6, 'respects the quiet zone');
  }
});

test('text rendering has the right shape', () => {
  const qr = encodeQr('text');
  const lines = qrToText(qr, { quietZone: 2 }).split('\n');
  assert.equal(lines.length, qr.size + 4);
  for (const line of lines) assert.equal([...line].length / 2, qr.size + 4);
});

/* ---------------------------------------------------------------------------
 * Ground truth: an independent, widely used implementation.
 *
 * jsQR (used above) decodes a rendered image end-to-end, but it has a genuine
 * bug on version 23-L: it returns null for that symbol even when the symbol was
 * produced by the reference library, byte for byte. That combination is
 * therefore excluded from the image round-trip test below and covered here
 * instead, where correctness is checked module by module.
 * ------------------------------------------------------------------------- */

test('output is bit-identical to an independent implementation', async () => {
  const imported = await import('qrcode');
  const Reference = imported.default ?? imported;

  const sameMatrix = (reference, mine) => {
    const size = reference.modules.size;
    if (size !== mine.size) return `size ${mine.size} vs ${size}`;
    for (let r = 0; r < size; r++) {
      for (let c = 0; c < size; c++) {
        if (!!reference.modules.get(r, c) !== mine.matrix[r][c]) return `module r${r} c${c}`;
      }
    }
    return null;
  };

  // Every version and level, filled to capacity, with a forced mask.
  //
  // The payload must contain a lowercase letter. This encoder always uses byte
  // mode; the reference implementation opportunistically switches to
  // alphanumeric mode for uppercase/digit-only payloads, which packs two
  // characters into 11 bits. Both are valid encodings of the same text, but they
  // produce different symbols, so the comparison has to pin the mode. (Invite
  // codes are base64url, which alphanumeric mode cannot represent anyway.)
  for (const level of EC_LEVELS) {
    for (let version = 1; version <= 40; version++) {
      const text = 'q'.repeat(payloadCapacityBytes(version, level));
      const mine = encodeQr(text, { ecLevel: level, minVersion: version, maxVersion: version, mask: 0 });
      const reference = Reference.create(text, { version, errorCorrectionLevel: level, maskPattern: 0 });
      const difference = sameMatrix(reference, mine);
      assert.equal(difference, null, `version ${version}-${level} differs at ${difference}`);
    }
  }

  // Every mask pattern, across a spread of versions.
  for (const level of EC_LEVELS) {
    for (const version of [1, 6, 14, 23, 40]) {
      const size = Math.max(1, Math.min(payloadCapacityBytes(version, level), 64));
      const text = 'mask check '.repeat(size).slice(0, size);
      for (let mask = 0; mask < 8; mask++) {
        const mine = encodeQr(text, { ecLevel: level, minVersion: version, maxVersion: version, mask });
        const reference = Reference.create(text, { version, errorCorrectionLevel: level, maskPattern: mask });
        const difference = sameMatrix(reference, mine);
        assert.equal(difference, null, `version ${version}-${level} mask ${mask} differs at ${difference}`);
      }
    }
  }
});

test('forced masks are honoured and auto-selection scores them', () => {
  for (let mask = 0; mask < 8; mask++) {
    const qr = encodeQr('masked', { mask });
    assert.equal(qr.mask, mask);
  }
  const auto = encodeQr('masked');
  assert.ok(auto.mask >= 0 && auto.mask < 8);
  assert.deepEqual(encodeQr('masked').matrix, auto.matrix, 'auto-selection is deterministic');
});

test('the jsQR round-trip gap is confined to one version/level', () => {
  // Guards the exclusion documented above: if a future jsQR release fixes this,
  // the assertion fails and the exclusion can be removed.
  const text = 'y'.repeat(60);
  const qr = encodeQr(text, { ecLevel: 'L', minVersion: 23, maxVersion: 23 });
  assert.equal(decode(qr), null, 'jsQR still cannot read version 23-L');
  assert.ok(decode(encodeQr(text, { ecLevel: 'M', minVersion: 23, maxVersion: 23 })), 'but 23-M is fine');
});

/** Parse qrToAnsi output back into a matrix, so the terminal path is verified too. */
function matrixFromAnsi(text) {
  const rows = [];
  for (const line of text.split('\n')) {
    const row = [];
    const pattern = /\x1b\[(40|47)m/g;
    let match;
    while ((match = pattern.exec(line)) !== null) row.push(match[1] === '40');
    if (row.length) rows.push(row);
  }
  return rows;
}

test('the terminal rendering decodes back to the same URL', async () => {
  for (const url of ['https://192.168.0.201:8443/', 'http://localhost:8080/', 'https://10.0.0.7:3000/']) {
    const qr = encodeQr(url, { ecLevel: 'M' });
    const rows = matrixFromAnsi(qrToAnsi(qr, { quietZone: 3 }));

    assert.equal(rows.length, qr.size + 6, 'quiet zone rows');
    for (const row of rows) assert.equal(row.length, qr.size + 6, 'quiet zone columns');

    // Rebuild an RGBA image and decode it independently.
    const scale = 4;
    const size = rows.length * scale;
    const data = new Uint8ClampedArray(size * size * 4).fill(255);
    rows.forEach((row, y) => row.forEach((dark, x) => {
      if (!dark) return;
      for (let dy = 0; dy < scale; dy++) {
        for (let dx = 0; dx < scale; dx++) {
          const offset = ((y * scale + dy) * size + (x * scale + dx)) * 4;
          data[offset] = data[offset + 1] = data[offset + 2] = 0;
        }
      }
    }));
    assert.equal(jsQR(data, size, size)?.data, url, `terminal QR failed for ${url}`);
  }
});
