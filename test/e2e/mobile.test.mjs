/**
 * Phone conditions.
 *
 * Two things are checked that a desktop run cannot tell you:
 *
 *   1. Layout on a real phone viewport, with touch input — no horizontal
 *      overflow, and the QR still large enough to be scannable.
 *   2. Behaviour on a browser that has neither BarcodeDetector nor Web NFC.
 *      That is iOS Safari, and the app must degrade to typing/pasting rather
 *      than offering buttons that cannot work.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { devices } from 'playwright-core';

import { createStaticServer } from '../../serve.mjs';
import { PROJECT_ROOT, launchBrowser, openPeer, state, waitForOpen, createInvite } from './helpers.mjs';

const PHONES = {
  pixel: devices['Pixel 7'],
  iphone: devices['iPhone 14'],
};

async function mobilePeer(browser, baseUrl, label, device, { stripApis = false } = {}) {
  const context = await browser.newContext({ ...device });
  if (stripApis) {
    // Exactly the iOS Safari situation: the platform has no barcode detector
    // and no Web NFC.
    await context.addInitScript(() => {
      delete window.BarcodeDetector;
      delete window.NDEFReader;
    });
  }
  const page = await context.newPage();
  page.on('pageerror', (error) => console.error(`[${label}] page error: ${error.message}`));
  await page.goto(baseUrl, { waitUntil: 'load' });
  await page.evaluate(() => window.__p2p.ready);
  // The identity drawer starts collapsed, as it does for a real user.
  await page.tap('#btn-settings');
  await page.waitForFunction(() => !document.getElementById('identity-panel').hidden, null, { timeout: 10000 });
  return { context, page, label };
}

test('the app is usable on a phone viewport', { timeout: 240000 }, async (t) => {
  const server = await createStaticServer({ root: PROJECT_ROOT });
  const browser = await launchBrowser();
  t.after(async () => {
    await browser.close();
    await server.close();
  });

  const alice = await mobilePeer(browser, server.url, 'pixel-alice', PHONES.pixel);
  const bob = await mobilePeer(browser, server.url, 'pixel-bob', PHONES.pixel);

  await t.test('nothing overflows the screen', async () => {
    const layout = await alice.page.evaluate(() => ({
      viewport: window.innerWidth,
      documentWidth: document.documentElement.scrollWidth,
      bodyWidth: document.body.scrollWidth,
    }));
    assert.ok(
      layout.documentWidth <= layout.viewport + 1,
      `page is ${layout.documentWidth}px wide in a ${layout.viewport}px viewport`,
    );
    assert.equal(layout.bodyWidth, layout.documentWidth);
  });

  await t.test('the invite QR is big enough to scan', async () => {
    await alice.page.fill('#nick-input', 'phone-alice');
    await createInvite(alice);

    const qr = await alice.page.evaluate(() => {
      const canvas = document.querySelector('#qr-canvas');
      const rect = canvas.getBoundingClientRect();
      return { cssWidth: rect.width, viewport: window.innerWidth, backing: canvas.width };
    });
    assert.ok(qr.cssWidth >= 220, `QR rendered only ${qr.cssWidth}px wide`);
    assert.ok(qr.cssWidth <= qr.viewport, 'QR must fit the viewport without scrolling');
    assert.ok(qr.backing >= qr.cssWidth, 'backing store must be at least the display size');
  });

  await t.test('a tap-driven pairing completes on phones', async () => {
    const code = await alice.page.inputValue('#invite-code');
    await bob.page.tap('#btn-new-chat');
    await bob.page.waitForSelector('#view-connect:not([hidden])', { timeout: 10000 });
    await bob.page.fill('#paste-input', code);
    await bob.page.tap('#btn-paste');
    await bob.page.waitForSelector('#view-reply:not([hidden])', { timeout: 30000 });

    const reply = await bob.page.inputValue('#reply-code');
    await alice.page.tap('#btn-new-chat');
    await alice.page.waitForSelector('#view-connect:not([hidden])', { timeout: 10000 });
    await alice.page.fill('#paste-input', reply);
    await alice.page.tap('#btn-paste');
    await Promise.all([waitForOpen(alice), waitForOpen(bob)]);

    await alice.page.fill('#message-input', 'sent from a phone viewport');
    await alice.page.tap('#btn-send');
    await bob.page.waitForFunction(
      () => window.__p2p.getState().messages.some((m) => m.text === 'sent from a phone viewport'),
      null,
      { timeout: 15000 },
    );
    assert.equal((await state(alice)).view, 'chat');
  });

  await t.test('the chat view still fits after pairing', async () => {
    const overflow = await alice.page.evaluate(
      () => document.documentElement.scrollWidth - window.innerWidth,
    );
    assert.ok(overflow <= 1, `chat view overflows by ${overflow}px`);
  });
});

test('a browser with no scanner and no NFC degrades cleanly', { timeout: 240000 }, async (t) => {
  const server = await createStaticServer({ root: PROJECT_ROOT });
  const browser = await launchBrowser();
  t.after(async () => {
    await browser.close();
    await server.close();
  });

  // iPhone-sized browser with the two APIs removed: this is iOS Safari.
  const alice = await mobilePeer(browser, server.url, 'ios-alice', PHONES.iphone, { stripApis: true });
  const bob = await mobilePeer(browser, server.url, 'ios-bob', PHONES.iphone, { stripApis: true });

  await t.test('capability detection reports the truth', async () => {
    const snapshot = await state(alice);
    assert.equal(snapshot.capabilities.scanner.hasDetector, false);
    assert.equal(snapshot.capabilities.scanner.supported, false);
    assert.equal(snapshot.capabilities.nfc.supported, false);
    assert.equal(snapshot.capabilities.nfc.canReceiveByTap, true, 'the OS still reads tags for us');

    const hint = await alice.page.textContent('#pairing-capabilities');
    assert.match(hint, /camera app/i, 'points at the system camera app, which does read QR codes');
    assert.match(hint, /iPhone|Android|tag/i);
  });

  await t.test('no buttons are offered that cannot work', async () => {
    assert.equal(await alice.page.isVisible('#btn-scan-qr'), false);
    assert.equal(await alice.page.isVisible('#btn-tap-nfc'), false);
    assert.equal(await alice.page.isVisible('#btn-write-nfc'), false);
    // The QR is still drawn: the OTHER person scans it with their camera app.
    await alice.page.fill('#nick-input', 'ios-alice');
    await createInvite(alice);
    const qr = await alice.page.evaluate(() => document.querySelector('#qr-canvas').width);
    assert.ok(qr > 0, 'the invite QR is still rendered on a phone that cannot scan it itself');
  });

  await t.test('typing the code still pairs', async () => {
    const code = await alice.page.inputValue('#invite-code');
    await bob.page.tap('#btn-new-chat');
    await bob.page.waitForSelector('#view-connect:not([hidden])', { timeout: 10000 });
    await bob.page.fill('#paste-input', code);
    await bob.page.tap('#btn-paste');
    await bob.page.waitForSelector('#view-reply:not([hidden])', { timeout: 30000 });

    const reply = await bob.page.inputValue('#reply-code');
    await alice.page.tap('#btn-new-chat');
    await alice.page.waitForSelector('#view-connect:not([hidden])', { timeout: 10000 });
    await alice.page.fill('#paste-input', reply);
    await alice.page.tap('#btn-paste');
    await Promise.all([waitForOpen(alice), waitForOpen(bob)]);
    assert.equal((await state(alice)).view, 'chat');
  });
});
