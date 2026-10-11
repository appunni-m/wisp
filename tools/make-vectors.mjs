/**
 * Generate the interoperability vectors the Kotlin port is held to.
 *
 *   node tools/make-vectors.mjs            write them
 *   node tools/make-vectors.mjs --check    fail if the committed ones are stale
 *
 * The native client has to speak exactly the same wire format as the web one, so
 * the format is not described in prose anywhere: it is frozen here as bytes
 * produced by the implementation that already exists, and the native tests read
 * these files back. If the two ever drift, the native tests fail.
 *
 *   node tools/make-vectors.mjs
 *
 * Writes native/protocol/src/test/resources/vectors.json
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { webcrypto } from 'node:crypto';

import { encodeInviteBody, decodeInviteBody, sealInvite, openInvite, KIND, ID_MODE } from '../src/payload.js';
import { bytesToHex } from '../src/codec.js';
import { KEY_ALGO } from '../src/crypto.js';

const { subtle } = webcrypto;

/** A fixed key so the vectors are reproducible; only the signature is random. */
const SEED_LABEL = 'wisp-interop-vector-key-v1';

async function fixedKeyPair() {
  // Derive a stable key by signing a fixed message with a key generated from a
  // deterministic seed is not possible with WebCrypto, so instead the private
  // key is generated once and embedded below. This function only exists to
  // regenerate it.
  const pair = await subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const pkcs8 = new Uint8Array(await subtle.exportKey('pkcs8', pair.privateKey));
  const raw = new Uint8Array(await subtle.exportKey('raw', pair.publicKey));
  return { pkcs8: bytesToHex(pkcs8), publicKey: bytesToHex(raw) };
}

function hexToBytes(hex) {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

async function importPrivate(pkcs8Hex) {
  return subtle.importKey('pkcs8', hexToBytes(pkcs8Hex), { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
}

/** The invites the vectors cover: one plain, one with contact details and a group. */
const INVITES = [
  {
    name: 'plain-offer',
    invite: {
      kind: KIND.OFFER,
      idMode: ID_MODE.PSEUDONYM,
      createdAtSec: 1750000000,
      roomId: 0,
      sessionId: 0x0123456789abcdefn,
      ufrag: 'aB3dEf9h',
      pwd: '0123456789abcdefghijklmn',
      fingerprint: 'AB:CD:EF:01:23:45:67:89:AB:CD:EF:01:23:45:67:89:AB:CD:EF:01:23:45:67:89:AB:CD:EF:01:23:45:67:89',
      setup: 'actpass',
      candidates: [
        { type: 'host', component: 1, address: '192.168.1.24', port: 54321, transport: 'udp' },
        { type: 'srflx', component: 1, address: '203.0.113.7', port: 41234, transport: 'udp' },
      ],
      nick: 'quiet-otter',
      contact: null,
      keyAlgo: KEY_ALGO.P256,
      groupLabel: '',
    },
  },
  {
    name: 'contact-answer',
    invite: {
      kind: KIND.ANSWER,
      idMode: ID_MODE.CONTACT,
      createdAtSec: 1750000123,
      roomId: 0x1122334455667788n,
      sessionId: 0xfedcba9876543210n,
      ufrag: 'Zz9Yy8Xx',
      pwd: 'zyxwvutsrqponmlkjihgfedc',
      fingerprint: '11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF:00',
      setup: 'active',
      candidates: [
        { type: 'host', component: 1, address: '10.0.0.5', port: 1234, transport: 'udp' },
        { type: 'relay', component: 1, address: '198.51.100.9', port: 60000, transport: 'udp' },
        { type: 'host', component: 1, address: 'fe80::1c2d:3e4f:5a6b:7c8d', port: 9999, transport: 'udp' },
      ],
      nick: 'bob-amber',
      contact: {
        name: 'Bob Amber',
        phone: '+44 7700 900123',
        email: 'bob@example.org',
        note: 'met at the conference — ünïcode ✓',
      },
      keyAlgo: KEY_ALGO.P256,
      groupLabel: 'Saturday planning',
    },
  },
];

/** An invite with a hostname candidate, to pin the third address kind. */
INVITES.push({
  name: 'hostname-candidate',
  invite: {
    ...INVITES[0].invite,
    kind: KIND.OFFER,
    nick: '',
    candidates: [{ type: 'host', component: 1, address: 'stun.example.net', port: 3478, transport: 'udp' }],
  },
});

async function main() {
  const existing = (() => {
    try {
      return JSON.parse(readFileSync(new URL('../native/protocol/src/test/resources/key.json', import.meta.url), 'utf8'));
    } catch {
      return null;
    }
  })();

  const key = existing ?? (await fixedKeyPair());
  if (!existing) {
    mkdirSync(new URL('../native/protocol/src/test/resources/', import.meta.url), { recursive: true });
    writeFileSync(
      new URL('../native/protocol/src/test/resources/key.json', import.meta.url),
      `${JSON.stringify(key, null, 2)}\n`,
    );
    console.log(`generated a fresh vector key (${SEED_LABEL})`);
  }

  const privateKey = await importPrivate(key.pkcs8);
  // The signed body carries the public key the signature is checked against, so
  // the vectors have to use the real one rather than a placeholder.
  const publicKey = hexToBytes(key.publicKey);
  for (const { invite } of INVITES) invite.publicKey = publicKey;
  const vectors = [];

  for (const { name, invite } of INVITES) {
    const body = encodeInviteBody(invite);
    const code = await sealInvite(invite, privateKey, KEY_ALGO.P256);
    vectors.push({
      name,
      bodyHex: bytesToHex(body),
      bodyLength: body.length,
      code,
      // What the fields must decode back to, so the Kotlin decoder is checked
      // against values rather than only against bytes.
      expected: {
        kind: invite.kind,
        idMode: invite.idMode,
        createdAtSec: invite.createdAtSec,
        roomId: invite.roomId.toString(),
        sessionId: invite.sessionId.toString(),
        ufrag: invite.ufrag,
        pwd: invite.pwd,
        fingerprint: invite.fingerprint,
        setup: invite.setup,
        nick: invite.nick,
        groupLabel: invite.groupLabel,
        keyAlgo: invite.keyAlgo,
        publicKeyHex: bytesToHex(invite.publicKey),
        contact: invite.contact,
        candidates: invite.candidates,
      },
    });
  }

  const out = {
    note: 'Generated by tools/make-vectors.mjs from the JavaScript implementation. Do not edit by hand.',
    keyAlgo: KEY_ALGO.P256,
    publicKeyHex: key.publicKey,
    pkcs8Hex: key.pkcs8,
    vectors,
  };

  const target = new URL('../native/protocol/src/test/resources/vectors.json', import.meta.url);
  mkdirSync(new URL('../native/protocol/src/test/resources/', import.meta.url), { recursive: true });

  // A signature is randomised, so the `code` field differs on every run even
  // when nothing has changed. Everything else is a pure function of the input,
  // and that is what staleness is judged on.
  const stable = (document) =>
    JSON.stringify({
      keyAlgo: document.keyAlgo,
      publicKeyHex: document.publicKeyHex,
      vectors: document.vectors.map(({ code, ...rest }) => rest),
    });

  if (process.argv.includes('--check')) {
    const committed = JSON.parse(readFileSync(target, 'utf8'));
    if (stable(committed) !== stable(out)) {
      console.error('the committed vectors no longer match what the web client produces.');
      console.error('Run: node tools/make-vectors.mjs');
      process.exit(1);
    }
    console.log(`vectors are up to date (${out.vectors.length} checked)`);
    return;
  }

  writeFileSync(target, `${JSON.stringify(out, null, 2)}\n`);
  console.log(`wrote ${vectors.length} vectors, body lengths: ${vectors.map((v) => v.bodyLength).join(', ')}`);
  console.log(`code lengths: ${vectors.map((v) => v.code.length).join(', ')}`);

  // Sanity: everything written must decode and verify with the implementation
  // that produced it, or the vectors are worthless as a reference.
  for (const vector of vectors) {
    const opened = await openInvite(vector.code);
    const round = decodeInviteBody(hexToBytes(vector.bodyHex));
    if (round.invite.ufrag !== vector.expected.ufrag) throw new Error(`${vector.name} did not round trip`);
    if (round.invite.nick !== vector.expected.nick) throw new Error(`${vector.name} lost its nickname`);
    if (opened.invite.nick !== vector.expected.nick) throw new Error(`${vector.name} did not survive sealing`);
    if (!opened.verified) throw new Error(`${vector.name} did not verify`);
  }
  console.log('all vectors round trip and verify');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
