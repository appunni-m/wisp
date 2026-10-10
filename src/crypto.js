/**
 * Cryptographic primitives for serverless pairing.
 *
 * Identity keys are ECDSA P-256. P-256 is chosen over Ed25519 on purpose: the
 * very same scalar can be re-imported as an ECDH key, which later gives us
 * pairwise key agreement for group encryption without a second key type.
 * Ed25519 signatures are still *verified* so newer peers stay interoperable.
 */

import { concatBytes, utf8Encode, bytesToHex, hexToBytes } from './codec.js';

export const KEY_ALGO = { ED25519: 1, P256: 2 };
export const SIGNATURE_BYTES = 64;

export const DEFAULT_KEY_ALGO = KEY_ALGO.P256;

/**
 * WebCrypto wants two different algorithm shapes for ECDSA: key generation and
 * import take `namedCurve`, while sign/verify take `hash`. Passing the wrong one
 * throws ERR_MISSING_OPTION.
 */
export function keyParams(keyAlgo) {
  if (keyAlgo === KEY_ALGO.ED25519) return { name: 'Ed25519' };
  if (keyAlgo === KEY_ALGO.P256) return { name: 'ECDSA', namedCurve: 'P-256' };
  throw new Error(`unsupported key algorithm: ${keyAlgo}`);
}

export function signatureParams(keyAlgo) {
  if (keyAlgo === KEY_ALGO.ED25519) return { name: 'Ed25519' };
  if (keyAlgo === KEY_ALGO.P256) return { name: 'ECDSA', hash: 'SHA-256' };
  throw new Error(`unsupported key algorithm: ${keyAlgo}`);
}

/** WebCrypto's raw public key encoding: compressed-free uncompressed point. */
export function publicKeyBytes(keyAlgo) {
  return keyAlgo === KEY_ALGO.ED25519 ? 32 : 65;
}

/**
 * Generate a fresh identity key pair. The returned private key is
 * non-extractable: it can sign, but its bytes cannot be read back out, even by
 * script running on this page.
 */
export async function generateIdentityKeyPair(keyAlgo = DEFAULT_KEY_ALGO) {
  const params = keyParams(keyAlgo);
  const pair = await crypto.subtle.generateKey(params, true, ['sign', 'verify']);
  const publicKey = new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey));
  const pkcs8 = await crypto.subtle.exportKey('pkcs8', pair.privateKey);
  const privateKey = await crypto.subtle.importKey('pkcs8', pkcs8, params, false, ['sign']);
  // The same scalar, re-imported for key agreement. Kept non-extractable too, and
  // this is the only moment the raw PKCS#8 exists — it is dropped by the caller.
  const ecdhPrivateKey =
    keyAlgo === KEY_ALGO.P256
      ? await crypto.subtle.importKey('pkcs8', pkcs8, { name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits'])
      : null;
  return { keyAlgo, publicKey, privateKey, ecdhPrivateKey, pkcs8: new Uint8Array(pkcs8) };
}

export async function importPrivateKey(pkcs8, keyAlgo = DEFAULT_KEY_ALGO) {
  return crypto.subtle.importKey('pkcs8', pkcs8, keyParams(keyAlgo), false, ['sign']);
}

export async function importPublicKey(raw, keyAlgo = DEFAULT_KEY_ALGO) {
  return crypto.subtle.importKey('raw', raw, keyParams(keyAlgo), true, ['verify']);
}

export async function signBytes(privateKey, keyAlgo, bytes) {
  const signature = new Uint8Array(await crypto.subtle.sign(signatureParams(keyAlgo), privateKey, bytes));
  if (signature.length !== SIGNATURE_BYTES) {
    throw new Error(`unexpected signature length ${signature.length}`);
  }
  return signature;
}

export async function verifyBytes(publicRaw, keyAlgo, bytes, signature) {
  try {
    const key = await importPublicKey(publicRaw, keyAlgo);
    return await crypto.subtle.verify(signatureParams(keyAlgo), key, signature, bytes);
  } catch {
    return false;
  }
}

/**
 * Pairwise shared secret via ECDH over the long-term identity keys.
 *
 * The identity key was generated as ECDSA, so it is re-imported here as ECDH:
 * both algorithms use the identical P-256 scalar, and the public point is
 * unchanged. `info` domain-separates different uses of the same secret.
 */
export async function importEcdhPrivate(pkcs8) {
  return crypto.subtle.importKey('pkcs8', pkcs8, { name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits']);
}

export async function importEcdhPublic(raw) {
  return crypto.subtle.importKey('raw', raw, { name: 'ECDH', namedCurve: 'P-256' }, true, []);
}

export async function deriveSharedKey(privateKey, peerPublicRaw, info = 'p2pchat/v1/session') {
  const peerKey = await importEcdhPublic(peerPublicRaw);
  const bits = await crypto.subtle.deriveBits({ name: 'ECDH', public: peerKey }, privateKey, 256);
  const material = await crypto.subtle.importKey('raw', bits, 'HKDF', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(32), info: utf8Encode(info) },
    material,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

/** Stable short fingerprint of a public key, for human comparison. */
export async function keyFingerprint(publicRaw) {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', publicRaw));
  return bytesToHex(digest.subarray(0, 8)).replace(/(.{4})(?=.)/g, '$1 ');
}

export const SAS_EMOJI = [
  '🐶', '🐱', '🦊', '🐻', '🐼', '🐨', '🦁', '🐮',
  '🐷', '🐸', '🐵', '🐔', '🐧', '🦆', '🦉', '🦇',
  '🐺', '🐗', '🐴', '🦄', '🐝', '🦋', '🐌', '🐞',
  '🐢', '🐍', '🦎', '🐙', '🦑', '🦐', '🦀', '🐡',
  '🐠', '🐬', '🐳', '🦈', '🐊', '🦓', '🦍', '🐘',
  '🦏', '🐪', '🦒', '🐃', '🐎', '🐖', '🐏', '🐑',
  '🦙', '🐕', '🐈', '🐇', '🦔', '🌵', '🎄', '🌲',
  '🍀', '🍁', '🌻', '🌙', '⭐', '🔥', '⚡', '🌈',
];

/**
 * Short authentication string over both DTLS fingerprints and both identity
 * keys. Both peers compute the identical value; comparing it out of band
 * (in person, or over a call) is what rules out a relay sitting in the middle.
 */
export async function shortAuthString(parts) {
  const sorted = [...parts].sort();
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', utf8Encode(sorted.join('|'))));
  const digits = ((digest[0] << 16) | (digest[1] << 8) | digest[2]) % 1000000;
  const emoji = [0, 1, 2, 3].map((i) => SAS_EMOJI[digest[4 + i] % SAS_EMOJI.length]);
  return { digits: String(digits).padStart(6, '0'), emoji, text: emoji.join(' ') };
}

export { concatBytes, hexToBytes, bytesToHex };
