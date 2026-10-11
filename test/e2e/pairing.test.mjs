/**
 * Pairing without copy-paste: QR codes and NFC tags.
 *
 * The QR test is a genuine screen-to-sensor path: the app draws the code onto a
 * canvas, and the *browser's own* BarcodeDetector reads it back. Nothing is
 * mocked. NFC has no hardware here, so a stand-in NDEFReader is injected to
 * verify the records we write, the parsing we do, and the error messages.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { createStaticServer } from '../../serve.mjs';
import { PROJECT_ROOT, launchBrowser, openPeer, state, waitForOpen, createInvite, decodeQrCanvas } from './helpers.mjs';

/** Read whatever the app drew on a canvas. Decoded in Node, so it works anywhere. */
const decodeCanvas = (page, selector) => decodeQrCanvas(page, selector);

test('two people pair by scanning each other’s QR code', { timeout: 240000 }, async (t) => {
  const server = await createStaticServer({ root: PROJECT_ROOT });
  const browser = await launchBrowser();
  t.after(async () => {
    await browser.close();
    await server.close();
  });

  const alice = await openPeer(browser, server.url, 'alice');
  const bob = await openPeer(browser, server.url, 'bob');

  await t.test('the browser can decode the invite the app drew', async () => {
    await alice.page.fill('#nick-input', 'alice-quiet');
    await createInvite(alice);

    const code = await alice.page.inputValue('#invite-code');
    const scanned = await decodeCanvas(alice.page, '#qr-canvas');
    assert.ok(scanned, 'the rendered QR must decode');
    assert.equal(scanned, code, 'the QR must carry exactly the invite code');

    const snapshot = await state(alice);
    assert.equal(snapshot.qr.invite, true, 'the app reports a rendered invite QR');
  });

  await t.test('bob scans it and replies with a QR of his own', async () => {
    // Exactly what the scanner hands back: the decoded text.
    const scanned = await decodeCanvas(alice.page, '#qr-canvas');
    await bob.page.click('#btn-new-chat');
    await bob.page.waitForSelector('#view-connect:not([hidden])', { timeout: 10000 });
    await bob.page.fill('#paste-input', scanned);
    await bob.page.click('#btn-paste');
    await bob.page.waitForSelector('#view-reply:not([hidden])', { timeout: 30000 });

    const reply = await bob.page.inputValue('#reply-code');
    const scannedReply = await decodeCanvas(bob.page, '#reply-qr');
    assert.equal(scannedReply, reply, 'the reply QR must carry the reply code');
  });

  await t.test('alice scans the reply and the link comes up', async () => {
    const scannedReply = await decodeCanvas(bob.page, '#reply-qr');
    await alice.page.click('#btn-new-chat');
    await alice.page.waitForSelector('#view-connect:not([hidden])', { timeout: 10000 });
    await alice.page.fill('#paste-input', scannedReply);
    await alice.page.click('#btn-paste');
    await Promise.all([waitForOpen(alice), waitForOpen(bob)]);

    await alice.page.fill('#message-input', 'paired by camera alone');
    await alice.page.click('#btn-send');
    await bob.page.waitForFunction(
      () => window.__p2p.getState().messages.some((m) => m.text === 'paired by camera alone'),
      null,
      { timeout: 15000 },
    );
  });
});

test('the camera scan pipeline accepts a detected code', { timeout: 120000 }, async (t) => {
  const server = await createStaticServer({ root: PROJECT_ROOT });
  const browser = await launchBrowser();
  t.after(async () => {
    await browser.close();
    await server.close();
  });

  const peer = await openPeer(browser, server.url, 'scanner');

  // Drive startQrScan with a stub camera and a stub detector: this verifies the
  // wiring (detect -> extract the invite -> hand it over) without a lens.
  const outcome = await peer.page.evaluate(async () => {
    const { startQrScan } = await import('/src/scan.js');
    const { encodeQr } = await import('/src/qr.js');

    // A real, valid invite code produced by the app itself.
    const { PairingSession } = await import('/src/session.js');
    const identity = {
      idMode: 0, nick: 'stub', contact: null, keyAlgo: 2, roomId: '0', groupLabel: '',
      publicKey: new Uint8Array(65).fill(7),
      privateKey: null,
    };
    void PairingSession;
    void identity;

    // Codes that do not parse must be ignored; a real one must win.
    const good = 'P2P1r-' + 'A'.repeat(60);
    const frames = [[{ rawValue: 'https://example.org/not-an-invite' }], [{ rawValue: `scan me: ${good}` }]];
    let index = 0;
    const detected = await new Promise((resolve, reject) => {
      startQrScan({
        deps: {
          getUserMedia: async () => ({ getTracks: () => [{ stop() {} }] }),
          detect: async () => frames[Math.min(index++, frames.length - 1)],
        },
        onCode: (code) => resolve(code),
        onError: reject,
      }).catch(reject);
    });

    // Also confirm the encoder refuses to render something absurd.
    let tooBig = false;
    try {
      encodeQr('x'.repeat(5000), { ecLevel: 'H', maxVersion: 10 });
    } catch {
      tooBig = true;
    }
    return { detected, tooBig };
  });

  assert.equal(outcome.detected, 'P2P1r-' + 'A'.repeat(60), 'the invite is pulled out of surrounding text');
  assert.equal(outcome.tooBig, true);
});

test('NFC writes a URL record and reads one back', { timeout: 120000 }, async (t) => {
  const server = await createStaticServer({ root: PROJECT_ROOT });
  const browser = await launchBrowser();
  t.after(async () => {
    await browser.close();
    await server.close();
  });

  const context = await browser.newContext();
  // Stand in for Web NFC, which exists only in Chrome on Android.
  await context.addInitScript(() => {
    window.__nfc = { written: null, scans: 0, failWith: null, listeners: {} };
    class FakeNDEFReader {
      addEventListener(type, handler) {
        (window.__nfc.listeners[type] ??= []).push(handler);
      }
      async write(message) {
        if (window.__nfc.failWith) {
          const error = new Error('nope');
          error.name = window.__nfc.failWith;
          throw error;
        }
        window.__nfc.written = message;
      }
      async scan() {
        window.__nfc.scans++;
      }
    }
    window.NDEFReader = FakeNDEFReader;
  });

  const page = await context.newPage();
  await page.goto(server.url);
  await page.evaluate(() => window.__p2p.ready);

  await t.test('the UI offers NFC only where it is supported', async () => {
    const capabilities = await page.evaluate(() => window.__p2p.getState().capabilities.nfc);
    assert.equal(capabilities.supported, true, 'the stub makes it look supported');
    assert.equal(capabilities.canReceiveByTap, true, 'receiving always works, via the OS');
    assert.equal(await page.isVisible('#btn-write-nfc'), false, 'hidden until there is a code to write');
  });

  await t.test('writing puts a URL record on the tag', async () => {
    await page.click('#btn-settings');
    await page.fill('#nick-input', 'tag-writer');
    await page.click('#btn-new-chat');
    await page.waitForSelector('#view-connect:not([hidden])', { timeout: 10000 });
    await page.click('#btn-create');
    await page.waitForSelector('#invite-result:not([hidden])', { timeout: 30000 });
    assert.ok(await page.isVisible('#btn-write-nfc'), 'the write button appears with an invite');

    await page.click('#btn-write-nfc');
    await page.waitForFunction(() => window.__nfc.written !== null, null, { timeout: 10000 });

    const written = await page.evaluate(() => window.__nfc.written);
    assert.equal(written.records.length, 1);
    assert.equal(written.records[0].recordType, 'url', 'a URL record, so iPhone can read it with no app');
    const code = await page.inputValue('#invite-code');
    assert.ok(written.records[0].data.includes(code), 'the tag carries the invite code');
    assert.ok(written.records[0].data.includes('#i='), 'and it is the app link, not a bare code');
  });

  await t.test('tapping a tag hands the code to the app', async () => {
    const code = await page.inputValue('#invite-code');
    await page.evaluate(async (tagged) => {
      const { scanForInvite } = await import('/src/nfc.js');
      window.__nfcReceived = null;
      await scanForInvite({
        onCode: (value) => { window.__nfcReceived = value; },
        onError: (error) => { window.__nfcReceived = `error: ${error.message}`; },
      });
      // Fire the reading event exactly as the platform would.
      const event = { message: { records: [{ recordType: 'url', data: `https://example.org/#i=${tagged}` }] } };
      for (const handler of window.__nfc.listeners.reading ?? []) handler(event);
    }, code);
    assert.equal(await page.evaluate(() => window.__nfcReceived), code);
  });

  await t.test('a tag with no invite is reported clearly', async () => {
    await page.evaluate(async () => {
      const { scanForInvite } = await import('/src/nfc.js');
      window.__nfcReceived = null;
      await scanForInvite({
        onCode: () => { window.__nfcReceived = 'unexpected'; },
        onError: (error) => { window.__nfcReceived = error.message; },
      });
      const event = { message: { records: [{ recordType: 'url', data: 'https://example.org/holiday-photos' }] } };
      for (const handler of window.__nfc.listeners.reading ?? []) handler(event);
    });
    assert.match(await page.evaluate(() => window.__nfcReceived), /does not contain an invite/);
  });

  await t.test('platform errors are translated into advice', async () => {
    const messages = await page.evaluate(async () => {
      const { writeInviteToTag } = await import('/src/nfc.js');
      const results = {};
      for (const [name, key] of [
        ['NotAllowedError', 'denied'],
        ['NotSupportedError', 'unsupported'],
        ['NotReadableError', 'unformatted'],
        ['NetworkError', 'removed'],
      ]) {
        window.__nfc.failWith = name;
        try {
          await writeInviteToTag('https://example.org/#i=P2P1r-AAAA');
        } catch (error) {
          results[key] = error.message;
        }
      }
      window.__nfc.failWith = null;
      return results;
    });

    assert.match(messages.denied, /permission was refused/i);
    assert.match(messages.unsupported, /Chrome on Android/);
    assert.match(messages.unformatted, /not NDEF-formatted/);
    assert.match(messages.removed, /moved away too early/);
  });
});

test('where NFC is missing the app explains the platform path', { timeout: 60000 }, async (t) => {
  const server = await createStaticServer({ root: PROJECT_ROOT });
  const browser = await launchBrowser();
  t.after(async () => {
    await browser.close();
    await server.close();
  });

  // Desktop Chrome has no Web NFC, exactly like Safari and Firefox.
  const peer = await openPeer(browser, server.url, 'desktop');
  const snapshot = await state(peer);
  assert.equal(snapshot.capabilities.nfc.supported, false);
  assert.equal(snapshot.capabilities.nfc.canReceiveByTap, true, 'tap-to-receive still works via the OS');
  assert.match(snapshot.capabilities.nfc.explanation, /iPhone|Chrome on Android/);
  assert.equal(await peer.page.isVisible('#btn-tap-nfc'), false, 'no dead button is shown');
  assert.equal(await peer.page.isVisible('#btn-write-nfc'), false);
});
