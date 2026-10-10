/**
 * A local TURN relay, for testing the pairs that STUN cannot connect.
 *
 * Not part of the app: this exists because the Android emulator sits behind
 * QEMU's NAT, which is precisely the symmetric-NAT case that needs a relay. It
 * also makes the TURN fallback described in the README testable for real.
 *
 *   node tools/turn-server.mjs
 *
 * Endpoints:
 *   from this machine   turn:127.0.0.1:3478
 *   from the emulator   turn:10.0.2.2:3478      (10.0.2.2 is the host loopback)
 *   from the LAN        turn:<your-lan-ip>:3478
 *
 * Credentials here are throwaway test values.
 */

import Turn from 'node-turn';
import { networkInterfaces } from 'node:os';

export const TURN_USER = 'linkline';
export const TURN_PASS = 'linkline-secret';
export const TURN_PORT = 3478;

export function lanAddress() {
  for (const addresses of Object.values(networkInterfaces())) {
    for (const address of addresses ?? []) {
      if (address.family === 'IPv4' && !address.internal) return address.address;
    }
  }
  return '127.0.0.1';
}

export function startTurnServer({ relayIp = lanAddress(), port = TURN_PORT, debug = 'OFF' } = {}) {
  const server = new Turn({
    authMech: 'long-term',
    credentials: { [TURN_USER]: TURN_PASS },
    listeningPort: port,
    listeningIps: ['0.0.0.0'],
    // The address handed to clients as their relay. It has to be reachable by
    // both peers, which rules out 127.0.0.1: the emulator's loopback is its own.
    relayIps: [relayIp],
    debugLevel: debug,
  });
  server.start();
  return server;
}

export const turnConfigFor = (host, port = TURN_PORT) => [
  { urls: `turn:${host}:${port}?transport=udp`, username: TURN_USER, credential: TURN_PASS },
];

if (process.argv[1] && process.argv[1].endsWith('turn-server.mjs')) {
  const relay = lanAddress();
  startTurnServer({ relayIp: relay, debug: process.env.TURN_DEBUG ?? 'INFO' });
  console.log(`TURN relay listening on 0.0.0.0:${TURN_PORT}, handing out relay address ${relay}`);
  console.log(`  this machine: turn:127.0.0.1:${TURN_PORT}`);
  console.log(`  emulator:     turn:10.0.2.2:${TURN_PORT}`);
  console.log(`  credentials:  ${TURN_USER} / ${TURN_PASS}`);
}
