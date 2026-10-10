/**
 * The invite payload: everything one peer must tell the other to establish a
 * direct connection, packed as tightly as possible and signed so it cannot be
 * edited in transit.
 *
 * Text form:  P2P1<z|r>-<base64url>     z = deflate-raw compressed, r = raw
 * Link form:  https://host/path/#i=<text form>
 *
 * The URL *fragment* is deliberate: fragments are never sent to the web server,
 * so the payload (which contains your IP candidates) stays out of server logs
 * and out of chat-app link previews.
 */

import {
  ByteWriter,
  ByteReader,
  concatBytes,
  b64urlEncode,
  b64urlDecode,
  maybeDeflate,
  inflateIfNeeded,
  hexToBytes,
  bytesToHex,
  CodecError,
} from './codec.js';
import { KEY_ALGO, SIGNATURE_BYTES, DEFAULT_KEY_ALGO, signBytes, verifyBytes } from './crypto.js';
import {
  ADDRESS_KIND,
  CANDIDATE_TYPE,
  CANDIDATE_TYPE_BY_ID,
  SETUP,
  SETUP_BY_ID,
  classifyAddress,
  ipv4ToBytes,
  bytesToIpv4,
  ipv6ToBytes,
  bytesToIpv6,
} from './sdp.js';

export const PAYLOAD_VERSION = 1;
export const CODE_PREFIX = 'P2P1';

export const KIND = { OFFER: 1, ANSWER: 2 };
export const KIND_NAME = { [KIND.OFFER]: 'offer', [KIND.ANSWER]: 'answer' };

export const ID_MODE = { PSEUDONYM: 0, CONTACT: 1, BURNER: 2 };
export const ID_MODE_NAME = ['pseudonym', 'contact', 'burner'];

const FLAG_HAS_CONTACT = 0b0001;

const FP_ALGO_SHA256 = 1;

export function fingerprintToBytes(fingerprint) {
  const bytes = hexToBytes(fingerprint);
  if (bytes.length !== 32) throw new CodecError('only sha-256 DTLS fingerprints are supported');
  return bytes;
}

export function bytesToFingerprint(bytes) {
  return bytesToHex(bytes).toUpperCase().replace(/(..)(?=.)/g, '$1:');
}

function writeCandidate(writer, candidate) {
  writer.u8(CANDIDATE_TYPE[candidate.type] ?? 0);
  writer.u8(candidate.component ?? 1);
  const kind = classifyAddress(candidate.address);
  writer.u8(kind);
  if (kind === ADDRESS_KIND.ipv4) writer.bytes(ipv4ToBytes(candidate.address));
  else if (kind === ADDRESS_KIND.ipv6) writer.bytes(ipv6ToBytes(candidate.address));
  else writer.str(candidate.address);
  writer.u16(candidate.port);
}

function readCandidate(reader) {
  const type = CANDIDATE_TYPE_BY_ID[reader.u8()];
  const component = reader.u8();
  const kind = reader.u8();
  let address;
  if (kind === ADDRESS_KIND.ipv4) address = bytesToIpv4(reader.bytes(4));
  else if (kind === ADDRESS_KIND.ipv6) address = bytesToIpv6(reader.bytes(16));
  else if (kind === ADDRESS_KIND.hostname) address = reader.str();
  else throw new CodecError(`unknown candidate address kind: ${kind}`);
  const port = reader.u16();
  if (!type) throw new CodecError('unknown candidate type');
  return { type, component, address, port, transport: 'udp' };
}

/** Serialize the signed region (everything except the signature). */
export function encodeInviteBody(invite) {
  const candidates = (invite.candidates ?? []).filter((c) => (c.transport ?? 'udp') === 'udp');
  const hasContact = invite.idMode === ID_MODE.CONTACT && invite.contact;

  const writer = new ByteWriter();
  writer.u8(PAYLOAD_VERSION);
  writer.u8(invite.kind);
  writer.u8(invite.idMode ?? ID_MODE.PSEUDONYM);
  writer.u8(hasContact ? FLAG_HAS_CONTACT : 0);
  writer.u32(invite.createdAtSec ?? Math.floor(Date.now() / 1000));
  writer.u64(BigInt(invite.roomId ?? 0));
  writer.u64(BigInt(invite.sessionId));
  writer.str(invite.ufrag);
  writer.str(invite.pwd);
  writer.u8(FP_ALGO_SHA256);
  writer.bytes(fingerprintToBytes(invite.fingerprint));
  writer.u8(SETUP[invite.setup ?? 'actpass'] ?? SETUP.actpass);
  writer.u8(candidates.length);
  for (const candidate of candidates) writeCandidate(writer, candidate);
  writer.str(invite.nick ?? '');
  if (hasContact) writer.str16(JSON.stringify(invite.contact));
  writer.u8(invite.keyAlgo ?? DEFAULT_KEY_ALGO);
  writer.bytes(invite.publicKey);
  writer.str(invite.groupLabel ?? '');
  return writer.build();
}

export function decodeInviteBody(bytes) {
  const reader = new ByteReader(bytes);
  const version = reader.u8();
  if (version !== PAYLOAD_VERSION) {
    throw new CodecError(`unsupported payload version ${version}; update the app`);
  }
  const kind = reader.u8();
  if (kind !== KIND.OFFER && kind !== KIND.ANSWER) throw new CodecError(`unknown invite kind ${kind}`);
  const idMode = reader.u8();
  const flags = reader.u8();
  const createdAtSec = reader.u32();
  const roomId = reader.u64().toString();
  const sessionId = reader.u64().toString();
  const ufrag = reader.str();
  const pwd = reader.str();
  const fpAlgo = reader.u8();
  if (fpAlgo !== FP_ALGO_SHA256) throw new CodecError(`unsupported fingerprint algorithm ${fpAlgo}`);
  const fingerprint = bytesToFingerprint(reader.bytes(32));
  const setup = SETUP_BY_ID[reader.u8()] ?? 'actpass';
  const candidateCount = reader.u8();
  const candidates = [];
  for (let i = 0; i < candidateCount; i++) candidates.push(readCandidate(reader));
  const nick = reader.str();
  const contact = flags & FLAG_HAS_CONTACT ? JSON.parse(reader.str16()) : null;
  const keyAlgo = reader.u8();
  const expectedKeyBytes = keyAlgo === KEY_ALGO.ED25519 ? 32 : 65;
  const publicKey = reader.bytes(expectedKeyBytes);
  const groupLabel = reader.str();

  return {
    invite: {
      version,
      kind,
      idMode,
      createdAtSec,
      roomId,
      sessionId,
      ufrag,
      pwd,
      fingerprint,
      setup,
      candidates,
      nick,
      contact,
      keyAlgo,
      publicKey,
      groupLabel,
    },
    bodyLength: reader.offset,
  };
}

/** Sign an invite and render it as a copy-pasteable code. */
export async function sealInvite(invite, privateKey, keyAlgo = DEFAULT_KEY_ALGO) {
  const body = encodeInviteBody(invite);
  const signature = await signBytes(privateKey, keyAlgo, body);
  const packed = concatBytes(body, signature);
  const { bytes, compressed } = await maybeDeflate(packed);
  return `${CODE_PREFIX}${compressed ? 'z' : 'r'}-${b64urlEncode(bytes)}`;
}

const CODE_PATTERN = new RegExp(`${CODE_PREFIX}[zr]-[A-Za-z0-9_-]+`);

/** Pull a code out of arbitrary pasted text: a bare code, a full link, or a chat message. */
export function extractCode(text) {
  if (!text) return null;
  const match = CODE_PATTERN.exec(String(text));
  return match ? match[0] : null;
}

export function isCode(text) {
  return extractCode(text) !== null;
}

/**
 * Decode a code and check its signature. `verified` is false when the payload
 * was edited, truncated, or signed by a key that does not match the one embedded
 * in it — callers must not display a nickname unless `verified` is true.
 */
export async function openInvite(code) {
  const cleaned = extractCode(code);
  if (!cleaned) throw new CodecError('no invite code found in the pasted text');
  const match = /^P2P1([zr])-([A-Za-z0-9_-]+)$/.exec(cleaned);
  if (!match) throw new CodecError('malformed invite code');
  const [, mode, payload] = match;
  const raw = b64urlDecode(payload);
  const packed = await inflateIfNeeded(raw, mode === 'z');
  const { invite, bodyLength } = decodeInviteBody(packed);
  if (packed.length !== bodyLength + SIGNATURE_BYTES) {
    throw new CodecError('invite payload has trailing or missing bytes');
  }
  const body = packed.subarray(0, bodyLength);
  const signature = packed.subarray(bodyLength, bodyLength + SIGNATURE_BYTES);
  const verified = await verifyBytes(invite.publicKey, invite.keyAlgo, body, signature);
  return { invite, verified, code: cleaned, byteLength: packed.length };
}

/** Build the shareable link for a code. */
export function buildInviteLink(baseUrl, code) {
  const url = new URL(baseUrl);
  url.hash = `i=${code}`;
  return url.toString();
}

/** Read an invite code out of a location hash such as `#i=P2P1z-...`. */
export function codeFromHash(hash) {
  if (!hash) return null;
  const trimmed = String(hash).replace(/^#/, '');
  const params = new URLSearchParams(trimmed);
  const value = params.get('i') ?? trimmed;
  return extractCode(value);
}

export function inviteAgeSeconds(invite) {
  return Math.max(0, Math.floor(Date.now() / 1000) - invite.createdAtSec);
}
