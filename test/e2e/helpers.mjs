/** Shared helpers for the end-to-end suites. */

import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

export const PROJECT_ROOT = fileURLToPath(new URL('../../', import.meta.url));

const CHROME_PATHS = [
  process.env.CHROME_PATH,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
].filter(Boolean);

export function findChrome() {
  for (const candidate of CHROME_PATHS) {
    if (existsSync(candidate)) return candidate;
  }
  throw new Error(`no Chrome found; set CHROME_PATH. Looked in:\n  ${CHROME_PATHS.join('\n  ')}`);
}

/**
 * Read a QR code the app drew, in Node rather than in the browser.
 *
 * The obvious decoder is the browser's own BarcodeDetector, but Chrome only
 * implements it on macOS, Android and ChromeOS — a Linux runner reports it as
 * missing, which would make these tests pass or fail depending on the machine.
 * jsQR is pure JavaScript, so the answer is the same everywhere, and it is the
 * same decoder the unit tests hold the encoder to.
 */
export async function decodeQrCanvas(page, selector) {
  const shot = await page.evaluate((sel) => {
    const canvas = document.querySelector(sel);
    if (!canvas || !canvas.width || !canvas.height) return null;
    const context = canvas.getContext('2d');
    const { data, width, height } = context.getImageData(0, 0, canvas.width, canvas.height);
    return { data: Array.from(data), width, height };
  }, selector);

  if (!shot) return null;
  const { default: jsQR } = await import('jsqr');
  const result = jsQR(new Uint8ClampedArray(shot.data), shot.width, shot.height);
  return result?.data ?? null;
}

/**
 * Launch Chrome with the flags a constrained machine needs.
 *
 * Continuous integration runners give a container 64 MB of `/dev/shm`, and
 * Chrome will happily fill it and have its renderers killed — which shows up as
 * a test that hangs rather than one that fails with a reason. The backgrounding
 * flags matter here too, because these tests deliberately keep several pages
 * open at once and a throttled one stops answering.
 */
const LAUNCH_ARGS = [
  '--disable-dev-shm-usage',
  '--no-sandbox',
  '--disable-gpu',
  '--mute-audio',
  '--disable-background-timer-throttling',
  '--disable-backgrounding-occluded-windows',
  '--disable-renderer-backgrounding',
  // Chrome hides host candidates behind mDNS names, which two isolated browser
  // profiles cannot resolve. With this, peers on one machine reach each other
  // over the loopback address and the tests need no STUN server and no network.
  '--disable-features=WebRtcHideLocalIpsWithMdns',
  // A call's remote video has to start without a tap.
  '--autoplay-policy=no-user-gesture-required',
];

export const launchBrowser = (options = {}) => {
  // `args` is merged rather than spread over, or a caller passing its own would
  // silently drop the flags above.
  const { args = [], ...rest } = options;
  return chromium.launch({
    executablePath: findChrome(),
    headless: true,
    ...rest,
    args: [...LAUNCH_ARGS, ...args],
  });
};

/**
 * Give the page a microphone and camera that need no hardware.
 *
 * Chrome's own fake devices are not usable here: capture is unavailable in a
 * headless browser with no access to the media subsystem, and it fails on some
 * machines while working on others, which is no basis for a test. A canvas and
 * an oscillator produce real tracks that really encode and really travel, so the
 * whole call path is exercised — renegotiation, ICE, tracks, stats, controls —
 * without depending on what the machine has plugged into it.
 */
export async function useSyntheticMedia(page) {
  await page.addInitScript(() => {
    const synthetic = (constraints = {}) => {
      const tracks = [];
      if (constraints.video) {
        const canvas = document.createElement('canvas');
        canvas.width = 320;
        canvas.height = 240;
        const context = canvas.getContext('2d');
        let hue = 0;
        setInterval(() => {
          hue = (hue + 7) % 360;
          context.fillStyle = `hsl(${hue} 80% 45%)`;
          context.fillRect(0, 0, canvas.width, canvas.height);
          context.fillStyle = '#fff';
          context.font = '28px sans-serif';
          context.fillText(new Date().toISOString().slice(17, 23), 12, 40);
        }, 66);
        tracks.push(...canvas.captureStream(15).getVideoTracks());
      }
      if (constraints.audio) {
        const context = new AudioContext();
        const oscillator = context.createOscillator();
        const destination = context.createMediaStreamDestination();
        oscillator.frequency.value = 440;
        oscillator.connect(destination);
        oscillator.start();
        tracks.push(...destination.stream.getAudioTracks());
      }
      return new MediaStream(tracks);
    };

    Object.defineProperty(navigator.mediaDevices, 'getUserMedia', {
      configurable: true,
      writable: true,
      value: async (constraints) => synthetic(constraints ?? {}),
    });
  });
}

/**
 * Peers in these tests share a machine, so host candidates are enough. With
 * mDNS obfuscation off and no ICE servers configured, the suite never touches
 * the network — a runner that cannot reach a STUN server is not a failing test.
 */
export const testUrl = (url) => `${url}${url.includes('?') ? '&' : '?'}ice=none`;

/** Each peer gets its own browser context so IndexedDB (and its identity key) is isolated. */
export async function openPeer(browser, baseUrl, label) {
  const context = await browser.newContext();
  const page = await context.newPage();
  page.on('pageerror', (error) => console.error(`[${label}] page error: ${error.message}`));
  page.on('console', (message) => {
    if (message.type() === 'error') console.error(`[${label}] console error: ${message.text()}`);
  });
  await page.goto(testUrl(baseUrl), { waitUntil: 'load' });
  await page.evaluate(() => window.__p2p.ready);
  // The identity drawer starts collapsed; open it the way a person would.
  await page.click('#btn-settings');
  await page.waitForSelector('#identity-panel:not([hidden])', { timeout: 10000 });
  return { context, page, label };
}

export const state = (peer) => peer.page.evaluate(() => window.__p2p.getState());

export async function waitForOpen(peer, timeout = 45000) {
  try {
    await peer.page.waitForFunction(() => window.__p2p.getState().open === true, null, { timeout });
  } catch {
    throw new Error(`[${peer.label}] link never opened: ${JSON.stringify(await state(peer))}`);
  }
}

/**
 * Start an invitation the way a person does: the identity form lives on the
 * settings page, so creating an invite means going back to the chat list first.
 */
export async function createInvite(peer) {
  await peer.page.click('#btn-new-chat');
  await peer.page.waitForSelector('#view-connect:not([hidden])', { timeout: 10000 });
  await peer.page.click('#btn-create');
  await peer.page.waitForSelector('#invite-result:not([hidden])', { timeout: 30000 });
}

/** Drive the whole manual handshake: one side creates, the other replies. */
export async function pair(inviter, joiner, { nick } = {}) {
  await inviter.page.waitForSelector('#invite-result:not([hidden])', { timeout: 30000 });
  const invite = await inviter.page.inputValue('#invite-code');

  if (nick) await joiner.page.fill('#nick-input', nick);
  // Both sides have to be looking at a pairing screen, as people would be.
  await joiner.page.click('#btn-new-chat');
  await joiner.page.waitForSelector('#view-connect:not([hidden])', { timeout: 10000 });
  await joiner.page.fill('#paste-input', invite);
  await joiner.page.click('#btn-paste');
  await joiner.page.waitForSelector('#view-reply:not([hidden])', { timeout: 30000 });
  const reply = await joiner.page.inputValue('#reply-code');

  await inviter.page.fill('#paste-input', reply);
  await inviter.page.click('#btn-paste');
  await Promise.all([waitForOpen(inviter), waitForOpen(joiner)]);
  return { invite, reply };
}

/** Record every string a page puts on a data channel, for wire-level assertions. */
export async function tapWire(page) {
  await page.evaluate(() => {
    window.__wire = [];
    const original = RTCDataChannel.prototype.send;
    RTCDataChannel.prototype.send = function tap(data) {
      try {
        window.__wire.push(typeof data === 'string' ? data : '<binary>');
      } catch {
        /* ignore */
      }
      return original.call(this, data);
    };
  });
}

export const wireFrames = (peer) => peer.page.evaluate(() => window.__wire ?? []);
