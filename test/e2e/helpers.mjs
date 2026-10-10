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

export const launchBrowser = () => chromium.launch({ executablePath: findChrome(), headless: true });

/** Each peer gets its own browser context so IndexedDB (and its identity key) is isolated. */
export async function openPeer(browser, baseUrl, label) {
  const context = await browser.newContext();
  const page = await context.newPage();
  page.on('pageerror', (error) => console.error(`[${label}] page error: ${error.message}`));
  page.on('console', (message) => {
    if (message.type() === 'error') console.error(`[${label}] console error: ${message.text()}`);
  });
  await page.goto(baseUrl, { waitUntil: 'load' });
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
