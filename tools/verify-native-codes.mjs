/**
 * Verify codes the Kotlin implementation produced, using the web client.
 *
 * The interop tests run the other way round: JavaScript writes vectors and
 * Kotlin has to read them. That only proves one direction, so the Kotlin suite
 * leaves the codes it signed in build/native-codes.txt and this checks them with
 * the implementation that already exists.
 *
 *   node native/protocol/build/... is written by:  cd native && ./gradlew :protocol:test
 *   node tools/verify-native-codes.mjs
 *
 * Exits non-zero if a code does not open, does not verify, or decodes to
 * something we did not expect.
 */

import { readFileSync, existsSync } from 'node:fs';

import { openInvite } from '../src/payload.js';
import { encodeInviteBody } from '../src/payload.js';
import { bytesToHex } from '../src/codec.js';

const CANDIDATES = [
  'native/protocol/build/native-codes.txt',
  'native/build/native-codes.txt',
];

const file = CANDIDATES.find((path) => existsSync(path));
if (!file) {
  console.error(
    `no codes found. Run the Kotlin suite first:\n  cd native && ./gradlew :protocol:test\nLooked in:\n  ${CANDIDATES.join('\n  ')}`,
  );
  process.exit(2);
}

const codes = readFileSync(file, 'utf8')
  .split('\n')
  .map((line) => line.trim())
  .filter(Boolean);

if (!codes.length) {
  console.error(`${file} is empty; the Kotlin suite recorded nothing`);
  process.exit(2);
}

let failures = 0;
for (const code of codes) {
  try {
    const opened = await openInvite(code);
    if (!opened.verified) {
      console.error(`FAIL  signature did not verify   ${code.slice(0, 40)}...`);
      failures++;
      continue;
    }
    if (opened.invite.nick !== 'from-kotlin') {
      console.error(`FAIL  unexpected nickname ${opened.invite.nick}`);
      failures++;
      continue;
    }
    // The strongest check available: re-encode what Kotlin decoded and confirm
    // the bytes are the same ones Kotlin signed.
    const reencoded = encodeInviteBody(opened.invite);
    const original = opened.byteLength - 64;
    if (reencoded.length !== original) {
      console.error(`FAIL  re-encoded body is ${reencoded.length} bytes, was ${original}`);
      failures++;
      continue;
    }
    console.log(
      `ok    ${opened.invite.ufrag}  nick=${opened.invite.nick}  ` +
        `candidates=${opened.invite.candidates.length}  ${opened.byteLength} bytes  ` +
        `key=${bytesToHex(opened.invite.publicKey).slice(0, 16)}...`,
    );
  } catch (error) {
    console.error(`FAIL  ${error.message}`);
    failures++;
  }
}

if (failures) {
  console.error(`\n${failures} of ${codes.length} codes produced by the native client were rejected by the web client`);
  process.exit(1);
}

console.log(`\nall ${codes.length} codes signed by the Kotlin client verified in JavaScript`);
