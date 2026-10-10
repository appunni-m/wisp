import test from 'node:test';
import assert from 'node:assert/strict';

import {
  ByteWriter,
  ByteReader,
  b64urlEncode,
  b64urlDecode,
  bytesEqual,
  concatBytes,
  utf8Encode,
  bytesToHex,
  hexToBytes,
  deflateRaw,
  inflateRaw,
  maybeDeflate,
  inflateIfNeeded,
  CodecError,
} from '../../src/codec.js';

import {
  classifyAddress,
  ipv4ToBytes,
  bytesToIpv4,
  ipv6ToBytes,
  bytesToIpv6,
  parseCandidateLine,
  formatCandidateLine,
  computePriority,
  extractSdpFields,
  buildSdpFromSkeleton,
  stripCandidates,
  dedupeCandidates,
  ADDRESS_KIND,
  isPrivateAddress,
} from '../../src/sdp.js';

test('base64url round-trips every length residue class', () => {
  for (let length = 0; length <= 12; length++) {
    const bytes = new Uint8Array(length);
    for (let i = 0; i < length; i++) bytes[i] = (i * 37 + length) & 0xff;
    const encoded = b64urlEncode(bytes);
    assert.doesNotMatch(encoded, /[+/=]/, 'must be URL safe');
    assert.deepEqual(b64urlDecode(encoded), bytes, `length ${length}`);
  }
  // A larger, non-trivial buffer.
  const big = new Uint8Array(1000).map((_, i) => (i * 7) & 0xff);
  assert.deepEqual(b64urlDecode(b64urlEncode(big)), big);
});

test('base64url ignores paste artefacts but never corrupts real symbols', () => {
  // Whitespace, newlines and stray punctuation are stripped so that a code
  // survives being pasted out of a chat message or a wrapped link.
  assert.deepEqual(b64urlDecode('AQ\nID'), b64urlDecode('AQID'));
  assert.deepEqual(b64urlDecode(' AQID '), b64urlDecode('AQID'));
  // Every character of the alphabet is preserved exactly.
  const bytes = new Uint8Array(64).map((_, i) => i * 4);
  assert.deepEqual(b64urlDecode(b64urlEncode(bytes)), bytes);
});

test('byte writer and reader are symmetric', () => {
  const built = new ByteWriter()
    .u8(200)
    .u16(65535)
    .u32(4294967295)
    .u64(18446744073709551615n)
    .str('héllo')
    .str16('x'.repeat(300))
    .bytes(new Uint8Array([1, 2, 3]))
    .build();

  const reader = new ByteReader(built);
  assert.equal(reader.u8(), 200);
  assert.equal(reader.u16(), 65535);
  assert.equal(reader.u32(), 4294967295);
  assert.equal(reader.u64(), 18446744073709551615n);
  assert.equal(reader.str(), 'héllo');
  assert.equal(reader.str16(), 'x'.repeat(300));
  assert.deepEqual(reader.bytes(3), new Uint8Array([1, 2, 3]));
  assert.ok(reader.eof);
});

test('byte writer rejects out-of-range values', () => {
  assert.throws(() => new ByteWriter().u8(256), CodecError);
  assert.throws(() => new ByteWriter().u16(-1), CodecError);
  assert.throws(() => new ByteWriter().u32(2 ** 32), CodecError);
});

test('byte reader refuses to read past the end', () => {
  const reader = new ByteReader(new Uint8Array([1, 2]));
  reader.u8();
  reader.u8();
  assert.throws(() => reader.u8(), CodecError);
});

test('hex helpers round-trip', () => {
  const bytes = new Uint8Array([0, 1, 254, 255]);
  assert.equal(bytesToHex(bytes), '0001feff');
  assert.deepEqual(hexToBytes('00:01:FE:FF'), bytes);
  assert.deepEqual(hexToBytes('0001feff'), bytes);
  assert.throws(() => hexToBytes('abc'), CodecError);
});

test('constant-time comparison works', () => {
  assert.ok(bytesEqual(new Uint8Array([1, 2, 3]), new Uint8Array([1, 2, 3])));
  assert.ok(!bytesEqual(new Uint8Array([1, 2, 3]), new Uint8Array([1, 2, 4])));
  assert.ok(!bytesEqual(new Uint8Array([1, 2]), new Uint8Array([1, 2, 3])));
});

test('concat and utf8 helpers', () => {
  assert.deepEqual(concatBytes(new Uint8Array([1]), new Uint8Array([2, 3])), new Uint8Array([1, 2, 3]));
  assert.deepEqual(new Uint8Array(utf8Encode('ab')), new Uint8Array([97, 98]));
});

test('deflate round-trips and shrinks repetitive data', async () => {
  const source = new Uint8Array(utf8Encode('candidate:1 1 udp 2122260223 abc.local 46243 typ host\r\n'.repeat(20)));
  const deflated = await deflateRaw(source);
  assert.ok(deflated.length < source.length, 'repetitive text should compress');
  assert.deepEqual(new Uint8Array(await inflateRaw(deflated)), source);
});

test('maybeDeflate falls back when compression does not help', async () => {
  const random = new Uint8Array(64).map((_, i) => (i * 131 + 17) & 0xff);
  const result = await maybeDeflate(random);
  const restored = await inflateIfNeeded(result.bytes, result.compressed);
  assert.deepEqual(restored, random);
});

test('address classification and conversion', () => {
  assert.equal(classifyAddress('192.168.1.5'), ADDRESS_KIND.ipv4);
  assert.equal(classifyAddress('fe80::1'), ADDRESS_KIND.ipv6);
  assert.equal(classifyAddress('a1b2c3d4-1111-2222-3333-444455556666.local'), ADDRESS_KIND.hostname);

  assert.equal(bytesToIpv4(ipv4ToBytes('203.0.113.9')), '203.0.113.9');
  assert.throws(() => ipv4ToBytes('999.1.1.1'));
});

test('ipv6 round-trips, including compressed forms', () => {
  for (const address of [
    '2001:0db8:0000:0000:0000:ff00:0042:8329',
    '2001:db8::ff00:42:8329',
    '::1',
    'fe80::1',
    '::',
    '2001:db8:0:0:1:0:0:1',
  ]) {
    const restored = bytesToIpv6(ipv6ToBytes(address));
    assert.deepEqual(ipv6ToBytes(restored), ipv6ToBytes(address), `${address} -> ${restored}`);
  }
  assert.equal(bytesToIpv6(ipv6ToBytes('2001:db8::1')), '2001:db8::1');
});

test('candidate lines parse and re-emit', () => {
  const line =
    'a=candidate:1467250027 1 udp 2122260223 192.168.0.196 46243 typ host generation 0 network-id 1 network-cost 10';
  const parsed = parseCandidateLine(line);
  assert.equal(parsed.type, 'host');
  assert.equal(parsed.component, 1);
  assert.equal(parsed.address, '192.168.0.196');
  assert.equal(parsed.port, 46243);
  assert.equal(parsed.addressKind, ADDRESS_KIND.ipv4);

  const reemitted = formatCandidateLine(parsed);
  const reparsed = parseCandidateLine(reemitted);
  assert.equal(reparsed.address, parsed.address);
  assert.equal(reparsed.port, parsed.port);
  assert.equal(reparsed.type, parsed.type);
  assert.equal(reparsed.priority, parsed.priority);
});

test('candidate parsing handles mDNS, srflx and ipv6', () => {
  const mdns = parseCandidateLine(
    'a=candidate:1 1 udp 2122260223 9f8e7d6c-1234-5678-9abc-def012345678.local 50000 typ host generation 0',
  );
  assert.equal(mdns.addressKind, ADDRESS_KIND.hostname);

  const srflx = parseCandidateLine(
    'a=candidate:2 1 udp 1686052607 203.0.113.7 54321 typ srflx raddr 192.168.0.196 rport 46243 generation 0',
  );
  assert.equal(srflx.type, 'srflx');
  assert.equal(srflx.address, '203.0.113.7');

  const v6 = parseCandidateLine('a=candidate:3 1 udp 2122194687 2001:db8::1 9 typ host');
  assert.equal(v6.addressKind, ADDRESS_KIND.ipv6);
});

test('candidate parsing rejects junk', () => {
  assert.equal(parseCandidateLine('a=mid:0'), null);
  assert.equal(parseCandidateLine('a=candidate:1 1 udp 1 1.2.3.4 5 typ bogus'), null);
});

test('priority follows the RFC 8445 formula and prefers host over srflx', () => {
  const host = computePriority('host', 1);
  const srflx = computePriority('srflx', 1);
  const relay = computePriority('relay', 1);
  assert.ok(host > srflx);
  assert.ok(srflx > relay);
  assert.equal(host - srflx, (126 - 100) << 24);
  assert.equal(computePriority('host', 1) - computePriority('host', 2), 1);
  assert.ok(host <= 0xffffffff);
});

test('isPrivateAddress flags LAN addresses and mDNS names', () => {
  assert.ok(isPrivateAddress('192.168.1.1'));
  assert.ok(isPrivateAddress('10.0.0.1'));
  assert.ok(isPrivateAddress('172.16.5.4'));
  assert.ok(isPrivateAddress('fe80::1'));
  assert.ok(isPrivateAddress('something.local'));
  assert.ok(!isPrivateAddress('203.0.113.7'));
  assert.ok(!isPrivateAddress('2001:db8::1'));
});

const SHA256_FP = '6B:8B:5C:1D:2E:3F:40:51:62:73:84:95:A6:B7:C8:D9:EA:FB:0C:1D:2E:3F:40:51:62:73:84:95:A6:B7:C8:D9';

const CHROME_OFFER = [
  'v=0',
  'o=- 4611731400430051336 2 IN IP4 127.0.0.1',
  's=-',
  't=0 0',
  'a=group:BUNDLE 0',
  'a=extmap-allow-mixed',
  'a=msid-semantic: WMS',
  'm=application 9 UDP/DTLS/SCTP webrtc-datachannel',
  'c=IN IP4 0.0.0.0',
  'a=candidate:1467250027 1 udp 2122260223 192.168.0.196 46243 typ host generation 0 network-id 1',
  'a=candidate:435653019 1 tcp 1518280447 192.168.0.196 9 typ host tcptype active generation 0 network-id 1',
  'a=ice-ufrag:ETcE',
  'a=ice-pwd:1d8hK4hR2sJ0nJ0hKZF2n4Bq',
  'a=ice-options:trickle',
  `a=fingerprint:sha-256 ${SHA256_FP}`,
  'a=setup:actpass',
  'a=mid:0',
  'a=sctp-port:5000',
  'a=max-message-size:262144',
  '',
].join('\r\n');

test('extractSdpFields pulls the per-session values out of a real offer', () => {
  const fields = extractSdpFields(CHROME_OFFER);
  assert.equal(fields.sessionId, '4611731400430051336');
  assert.equal(fields.ufrag, 'ETcE');
  assert.equal(fields.pwd, '1d8hK4hR2sJ0nJ0hKZF2n4Bq');
  assert.equal(fields.fingerprint.algo, 'sha-256');
  assert.equal(fields.fingerprint.value, SHA256_FP);
  assert.equal(fields.setup, 'actpass');
  assert.equal(fields.candidates.length, 2);
});

test('stripCandidates removes candidate and end-of-candidates lines', () => {
  const stripped = stripCandidates(`${CHROME_OFFER}a=end-of-candidates\r\n`);
  assert.ok(!stripped.includes('a=candidate:'));
  assert.ok(!stripped.includes('end-of-candidates'));
  assert.ok(stripped.includes('a=ice-ufrag:ETcE'));
});

test('buildSdpFromSkeleton substitutes fields and re-appends candidates', () => {
  const skeleton = stripCandidates(CHROME_OFFER);
  const rebuilt = buildSdpFromSkeleton(skeleton, {
    sessionId: '12345',
    ufrag: 'AAAA',
    pwd: 'bbbbbbbbbbbbbbbbbbbbbb',
    fingerprint: { algo: 'sha-256', value: SHA256_FP },
    setup: 'active',
    candidates: [
      { type: 'srflx', component: 1, address: '203.0.113.7', port: 54321 },
      { type: 'host', component: 1, address: '192.168.0.5', port: 5000 },
    ],
  });

  assert.ok(rebuilt.includes('o=- 12345 2 IN IP4 127.0.0.1'));
  assert.ok(rebuilt.includes('a=ice-ufrag:AAAA'));
  assert.ok(rebuilt.includes('a=ice-pwd:bbbbbbbbbbbbbbbbbbbbbb'));
  assert.ok(rebuilt.includes('a=setup:active'));
  assert.ok(rebuilt.includes(`a=fingerprint:sha-256 ${SHA256_FP}`));
  assert.ok(rebuilt.includes('typ srflx'));
  assert.ok(rebuilt.includes('typ host'));
  assert.equal(rebuilt.split('a=candidate:').length - 1, 2);

  // Structure that makes the SDP acceptable to setRemoteDescription survives.
  assert.ok(rebuilt.includes('m=application 9 UDP/DTLS/SCTP webrtc-datachannel'));
  assert.ok(rebuilt.includes('a=group:BUNDLE 0'));
  assert.ok(rebuilt.includes('a=sctp-port:5000'));
  assert.ok(rebuilt.endsWith('\r\n'));

  // Round trip: the rebuilt SDP parses back to the same values.
  const reparsed = extractSdpFields(rebuilt);
  assert.equal(reparsed.ufrag, 'AAAA');
  assert.equal(reparsed.setup, 'active');
  assert.equal(reparsed.candidates.length, 2);
});

test('dedupeCandidates removes exact duplicates only', () => {
  const candidates = [
    { type: 'host', component: 1, address: '192.168.0.5', port: 5000 },
    { type: 'host', component: 1, address: '192.168.0.5', port: 5000 },
    { type: 'host', component: 2, address: '192.168.0.5', port: 5000 },
    { type: 'srflx', component: 1, address: '203.0.113.7', port: 1234 },
  ];
  assert.equal(dedupeCandidates(candidates).length, 3);
});
