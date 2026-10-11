/**
 * Rust peer <-> real browser.
 *
 * Spawns the Rust binary, hands its offer to Chrome, feeds the answer back, and
 * reports what crossed. This is the experiment that decides whether the native
 * client can be pure Rust: size and buildability were already settled.
 */

import { spawn } from 'node:child_process';
import { chromium } from 'playwright-core';

const BINARY = new URL('./target/release/interop', import.meta.url).pathname;
const CHROME = process.env.CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

const rust = spawn(BINARY, [], { stdio: ['pipe', 'pipe', 'inherit'] });

const lines = [];
let resolveOffer;
const offerReady = new Promise((resolve) => {
  resolveOffer = resolve;
});

let buffer = '';
rust.stdout.on('data', (chunk) => {
  buffer += chunk.toString();
  let index;
  while ((index = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, index).trim();
    buffer = buffer.slice(index + 1);
    if (!line) continue;
    console.log(`  rust  | ${line.slice(0, 120)}`);
    lines.push(line);
    if (line.startsWith('OFFER\t')) resolveOffer(line.slice('OFFER\t'.length));
  }
});

const browser = await chromium.launch({
  executablePath: CHROME,
  headless: true,
  args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-features=WebRtcHideLocalIpsWithMdns'],
});
const page = await (await browser.newContext()).newPage();
page.on('console', (message) => console.log(`  chrome| ${message.text().slice(0, 120)}`));
await page.goto('about:blank');

const offerSdp = await Promise.race([
  offerReady,
  new Promise((_, reject) => setTimeout(() => reject(new Error('the Rust peer never produced an offer')), 30000)),
]);

const result = await page.evaluate(async (sdp) => {
  const pc = new RTCPeerConnection({ iceServers: [] });
  const log = [];
  const seen = [];
  pc.ondatachannel = (event) => {
    const channel = event.channel;
    channel.onopen = () => {
      console.log('browser: channel open');
      channel.send('hello from browser');
    };
    channel.onmessage = (message) => {
      seen.push(String(message.data));
      console.log(`browser: received ${message.data}`);
    };
  };
  pc.oniceconnectionstatechange = () => log.push(`ice:${pc.iceConnectionState}`);

  await pc.setRemoteDescription({ type: 'offer', sdp: sdp.split('|').join('\r\n') });
  const answer = await pc.createAnswer();
  await pc.setLocalDescription(answer);
  // Gathering has to finish before the answer is useful to a peer that is not
  // trickling, which the Rust side is not.
  await new Promise((resolve) => {
    if (pc.iceGatheringState === 'complete') return resolve();
    const check = () => {
      if (pc.iceGatheringState === 'complete') {
        pc.removeEventListener('icegatheringstatechange', check);
        resolve();
      }
    };
    pc.addEventListener('icegatheringstatechange', check);
    setTimeout(resolve, 4000);
  });

  window.__pc = pc;
  window.__seen = seen;
  return { sdp: pc.localDescription.sdp, log };
}, offerSdp);

rust.stdin.write(`ANSWER\t${result.sdp.split(/\r?\n/).join('|')}\n`);

const finished = new Promise((resolve) => rust.on('exit', resolve));
await Promise.race([finished, new Promise((resolve) => setTimeout(resolve, 45000))]);

const seen = await page.evaluate(() => window.__seen ?? []);
await browser.close();
if (!rust.killed) rust.kill();

const connected = lines.some((line) => line === 'CONNECTED true');
const rustGot = lines.find((line) => line.startsWith('RECEIVED '));
const browserGot = seen.find((text) => text === 'hello from rust');

console.log('\n--- result ---');
console.log(`  ICE + DTLS between Rust and Chrome : ${connected ? 'yes' : 'NO'}`);
console.log(`  Rust -> browser                    : ${browserGot ? `"${browserGot}"` : 'NO'}`);
console.log(`  browser -> Rust                    : ${rustGot ?? 'NO'}`);

process.exit(connected && browserGot && rustGot && rustGot !== 'RECEIVED nothing' ? 0 : 1);
