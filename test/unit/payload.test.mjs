import test from 'node:test';
import assert from 'node:assert/strict';

import {
  KIND,
  ID_MODE,
  encodeInviteBody,
  decodeInviteBody,
  sealInvite,
  openInvite,
  extractCode,
  isCode,
  buildInviteLink,
  codeFromHash,
  inviteAgeSeconds,
  bytesToFingerprint,
  fingerprintToBytes,
  PAYLOAD_VERSION,
} from '../../src/payload.js';
import { b64urlEncode, b64urlDecode, concatBytes, maybeDeflate, inflateIfNeeded } from '../../src/codec.js';
import { generateIdentityKeyPair, signBytes, verifyBytes, KEY_ALGO, shortAuthString } from '../../src/crypto.js';

const SHA_FP = '6B:8B:5C:1D:2E:3F:40:51:62:73:84:95:A6:B7:C8:D9:EA:FB:0C:1D:2E:3F:40:51:62:73:84:95:A6:B7:C8:D9';

const identity = await generateIdentityKeyPair();
const stranger = await generateIdentityKeyPair();

function fixture(overrides = {}) {
  return {
    kind: KIND.OFFER,
    idMode: ID_MODE.PSEUDONYM,
    createdAtSec: 1700000000,
    roomId: '0',
    sessionId: '4611731400430051336',
    ufrag: 'ETcE',
    pwd: '1d8hK4hR2sJ0nJ0hKZF2n4Bq',
    fingerprint: SHA_FP,
    setup: 'actpass',
    candidates: [
      { type: 'host', component: 1, address: '192.168.0.196', port: 46243, transport: 'udp' },
      { type: 'srflx', component: 1, address: '203.0.113.7', port: 54321, transport: 'udp' },
      { type: 'host', component: 1, address: 'a1b2c3d4-1111-2222-3333-444455556666.local', port: 46244, transport: 'udp' },
      { type: 'host', component: 1, address: '2001:db8::1', port: 46245, transport: 'udp' },
      { type: 'host', component: 1, address: '192.168.0.196', port: 9, transport: 'tcp' },
    ],
    nick: 'quiet-otter',
    contact: null,
    keyAlgo: identity.keyAlgo,
    publicKey: identity.publicKey,
    groupLabel: '',
    ...overrides,
  };
}

test('fingerprint encoding round-trips', () => {
  const bytes = fingerprintToBytes(SHA_FP);
  assert.equal(bytes.length, 32);
  assert.equal(bytesToFingerprint(bytes), SHA_FP);
  assert.throws(() => fingerprintToBytes('AA:BB'));
});

test('invite body round-trips every field', async () => {
  const invite = fixture();
  const { invite: decoded } = decodeInviteBody(encodeInviteBody(invite));

  assert.equal(decoded.version, PAYLOAD_VERSION);
  assert.equal(decoded.kind, KIND.OFFER);
  assert.equal(decoded.idMode, ID_MODE.PSEUDONYM);
  assert.equal(decoded.createdAtSec, invite.createdAtSec);
  assert.equal(decoded.roomId, '0');
  assert.equal(decoded.sessionId, invite.sessionId);
  assert.equal(decoded.ufrag, invite.ufrag);
  assert.equal(decoded.pwd, invite.pwd);
  assert.equal(decoded.fingerprint, invite.fingerprint);
  assert.equal(decoded.setup, 'actpass');
  assert.deepEqual(decoded.candidates, [
    { type: 'host', component: 1, address: '192.168.0.196', port: 46243, transport: 'udp' },
    { type: 'srflx', component: 1, address: '203.0.113.7', port: 54321, transport: 'udp' },
    { type: 'host', component: 1, address: 'a1b2c3d4-1111-2222-3333-444455556666.local', port: 46244, transport: 'udp' },
    { type: 'host', component: 1, address: '2001:db8::1', port: 46245, transport: 'udp' },
  ]);
  assert.equal(decoded.nick, 'quiet-otter');
  assert.equal(decoded.contact, null);
  assert.equal(decoded.keyAlgo, KEY_ALGO.P256);
  assert.deepEqual(decoded.publicKey, identity.publicKey);
});

test('sealed invite opens with a valid signature', async () => {
  const code = await sealInvite(fixture(), identity.privateKey, identity.keyAlgo);
  const opened = await openInvite(code);
  assert.equal(opened.verified, true);
  assert.equal(opened.invite.nick, 'quiet-otter');
  assert.equal(opened.invite.kind, KIND.OFFER);
  assert.ok(code.startsWith('P2P1'));
});

test('answer invites carry the answer kind and active setup', async () => {
  const code = await sealInvite(
    fixture({ kind: KIND.ANSWER, setup: 'active', sessionId: '99' }),
    identity.privateKey,
    identity.keyAlgo,
  );
  const { invite, verified } = await openInvite(code);
  assert.equal(verified, true);
  assert.equal(invite.kind, KIND.ANSWER);
  assert.equal(invite.setup, 'active');
  assert.equal(invite.sessionId, '99');
});

test('contact mode transmits the shared contact card', async () => {
  const contact = { name: 'Ada Lovelace', phone: '+44 20 7946 0958', email: 'ada@example.org' };
  const code = await sealInvite(
    fixture({ idMode: ID_MODE.CONTACT, nick: 'ada', contact }),
    identity.privateKey,
    identity.keyAlgo,
  );
  const { invite, verified } = await openInvite(code);
  assert.equal(verified, true);
  assert.equal(invite.idMode, ID_MODE.CONTACT);
  assert.deepEqual(invite.contact, contact);
});

test('burner mode carries a one-off key that verifies but differs from the main identity', async () => {
  const burner = await generateIdentityKeyPair();
  const code = await sealInvite(
    fixture({ idMode: ID_MODE.BURNER, keyAlgo: burner.keyAlgo, publicKey: burner.publicKey }),
    burner.privateKey,
    burner.keyAlgo,
  );
  const { invite, verified } = await openInvite(code);
  assert.equal(verified, true);
  assert.equal(invite.idMode, ID_MODE.BURNER);
  assert.notDeepEqual(invite.publicKey, identity.publicKey);
});

test('a forged nickname cannot be smuggled into someone else\'s key', async () => {
  // Attacker keeps the victim's public key in the payload but signs with their own.
  const forged = fixture({ nick: 'trust-me-im-alice', publicKey: identity.publicKey });
  const code = await sealInvite(forged, stranger.privateKey, stranger.keyAlgo);
  const opened = await openInvite(code);
  assert.equal(opened.verified, false, 'payload claiming a foreign key must not verify');
});

test('flipping any payload byte breaks verification', async () => {
  const body = encodeInviteBody(fixture());
  const signature = await signBytes(identity.privateKey, identity.keyAlgo, body);
  const packed = concatBytes(body, signature);

  for (const index of [0, 5, 20, body.length - 1, body.length + 3, packed.length - 1]) {
    const tampered = Uint8Array.from(packed);
    tampered[index] ^= 0x01;
    const { bytes, compressed } = await maybeDeflate(tampered);
    const code = `P2P1${compressed ? 'z' : 'r'}-${b64urlEncode(bytes)}`;
    let verified = null;
    try {
      ({ verified } = await openInvite(code));
    } catch {
      verified = false; // a corrupted structural field is a legitimate rejection too
    }
    assert.equal(verified, false, `byte ${index} must not verify`);
  }
});

test('truncated and padded payloads are rejected', async () => {
  const body = encodeInviteBody(fixture());
  const signature = await signBytes(identity.privateKey, identity.keyAlgo, body);

  const short = concatBytes(body, signature.subarray(0, 32));
  const shortCode = `P2P1r-${b64urlEncode(short)}`;
  await assert.rejects(() => openInvite(shortCode));

  const long = concatBytes(body, signature, new Uint8Array([0]));
  const longCode = `P2P1r-${b64urlEncode(long)}`;
  await assert.rejects(() => openInvite(longCode), /trailing or missing bytes/);
});

test('garbage input is rejected with a clear error', async () => {
  await assert.rejects(() => openInvite('hello world'), /no invite code found/);
  await assert.rejects(() => openInvite('P2P1z-!!!!'), /no invite code found|malformed/);
  await assert.rejects(() => openInvite('P2P1r-AAAA'), Error);
});

test('unsupported payload versions are refused', async () => {
  const bytes = encodeInviteBody(fixture());
  bytes[0] = 99;
  const signature = await signBytes(identity.privateKey, identity.keyAlgo, bytes);
  const code = `P2P1r-${b64urlEncode(concatBytes(bytes, signature))}`;
  await assert.rejects(() => openInvite(code), /unsupported payload version/);
});

test('extractCode finds a code inside links and noisy messages', async () => {
  const code = await sealInvite(fixture(), identity.privateKey, identity.keyAlgo);
  const link = buildInviteLink('https://example.org/chat/', code);

  assert.equal(extractCode(code), code);
  assert.equal(extractCode(`hey, connect with me: ${link}`), code);
  assert.equal(extractCode(`  ${code}  `), code);
  assert.equal(extractCode(link), code);
  assert.equal(extractCode('nothing here'), null);
  assert.equal(extractCode(''), null);
  assert.ok(isCode(code));
  assert.ok(!isCode('random text'));
});

test('codes survive a URL hash round trip', async () => {
  const code = await sealInvite(fixture(), identity.privateKey, identity.keyAlgo);
  const link = buildInviteLink('https://example.org/chat/index.html', code);
  const hash = new URL(link).hash;
  assert.equal(codeFromHash(hash), code);
  assert.equal(codeFromHash(link), code);
  assert.equal(codeFromHash(''), null);
  assert.equal(codeFromHash('#i=not-a-code'), null);
});

test('invite age is computed from the embedded timestamp', () => {
  const now = Math.floor(Date.now() / 1000);
  assert.ok(inviteAgeSeconds({ createdAtSec: now - 120 }) >= 120);
  assert.equal(inviteAgeSeconds({ createdAtSec: now + 500 }), 0);
});

test('a realistic invite code stays comfortably pasteable', async () => {
  const code = await sealInvite(fixture(), identity.privateKey, identity.keyAlgo);
  const { invite } = await openInvite(code);
  assert.equal(invite.candidates.length, 4);
  // Well under the ~2000 character range where chat apps and address bars start
  // truncating, and short enough to fit a QR code at a scannable density.
  assert.ok(code.length < 700, `invite code was ${code.length} characters`);
  console.log(`      invite code length: ${code.length} chars (4 candidates, nickname mode)`);
});

test('short auth strings are symmetric and differ per peer pair', async () => {
  const other = await generateIdentityKeyPair();
  const a = await shortAuthString(['dtls:A', 'dtls:B', `key:${identity.publicKey}`, `key:${other.publicKey}`]);
  const b = await shortAuthString([`key:${other.publicKey}`, 'dtls:B', `key:${identity.publicKey}`, 'dtls:A']);
  assert.deepEqual(a, b, 'both peers must derive the same value');
  assert.match(a.digits, /^\d{6}$/);
  assert.equal(a.emoji.length, 4);

  const c = await shortAuthString(['dtls:A', 'dtls:C', `key:${identity.publicKey}`, `key:${other.publicKey}`]);
  assert.notDeepEqual(a, c, 'a different fingerprint must change the value');
});

test('public keys verify their own signatures and reject others', async () => {
  const message = new TextEncoder().encode('hello');
  const signature = await signBytes(identity.privateKey, identity.keyAlgo, message);
  assert.equal(signature.length, 64, 'raw r||s, not DER');
  assert.ok(await verifyBytes(identity.publicKey, identity.keyAlgo, message, signature));
  assert.ok(!(await verifyBytes(stranger.publicKey, identity.keyAlgo, message, signature)));
  assert.ok(!(await verifyBytes(identity.publicKey, identity.keyAlgo, new TextEncoder().encode('bye'), signature)));
});
