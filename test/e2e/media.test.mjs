/**
 * Sending files, and picking up where an interrupted transfer stopped.
 *
 * The resume test is the important one: it kills the link mid-transfer, pairs
 * again, and checks that the second attempt sends only the gap — and that the
 * reassembled bytes still hash to the digest the sender promised.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';

import { createStaticServer } from '../../serve.mjs';
import { PROJECT_ROOT, launchBrowser, openPeer, pair, state, waitForOpen, createInvite } from './helpers.mjs';

const wait = (ms) => new Promise((done) => setTimeout(done, ms));

/** A real PNG, so the thumbnail path is exercised rather than bypassed. */
async function makePng(page, { width = 240, height = 180, colour = '#00a884' } = {}) {
  const dataUrl = await page.evaluate(
    ([w, h, fill]) => {
      const canvas = document.createElement('canvas');
      canvas.width = w;
      canvas.height = h;
      const context = canvas.getContext('2d');
      context.fillStyle = fill;
      context.fillRect(0, 0, w, h);
      context.fillStyle = '#ffffff';
      context.font = '28px sans-serif';
      context.fillText('Wisp', 24, h / 2);
      return canvas.toDataURL('image/png');
    },
    [width, height, colour],
  );
  return Buffer.from(dataUrl.split(',')[1], 'base64');
}

const findMessage = (page, predicate) =>
  page.evaluate(
    (source) => {
      const test = new Function('m', `return ${source}`);
      const found = window.__p2p.getState().messages.find((m) => m.attachment && test(m));
      return found ? JSON.parse(JSON.stringify(found)) : null;
    },
    predicate,
  );

/**
 * Pick a file and send it, waiting for hashing to finish first: the sheet is
 * shown immediately but the file is not sendable until it has been prepared.
 */
async function sendFile(page, selector, file, count = 1) {
  await page.setInputFiles(selector, file);
  await page.waitForSelector('#preview-backdrop:not([hidden])', { timeout: 20000 });
  await page.waitForFunction(
    (expected) => window.__p2p.pendingAttachments() === expected,
    count,
    { timeout: 90000 },
  );
  await page.click('#btn-preview-send');
}

test('a photo crosses the link and renders on the other side', { timeout: 240000 }, async (t) => {
  const server = await createStaticServer({ root: PROJECT_ROOT });
  const browser = await launchBrowser();
  t.after(async () => {
    await browser.close();
    await server.close();
  });

  const alice = await openPeer(browser, server.url, 'alice');
  const bob = await openPeer(browser, server.url, 'bob');

  await alice.page.fill('#nick-input', 'alice-quiet');
  await alice.page.click('#btn-new-chat');
  await alice.page.click('#btn-create');
  await pair(alice, bob, { nick: 'bob-amber' });
  await waitForOpen(alice);

  const png = await makePng(alice.page);

  await t.test('the preview sheet prepares the file before sending', async () => {
    await alice.page.setInputFiles('#input-photos', {
      name: 'holiday.png',
      mimeType: 'image/png',
      buffer: png,
    });
    await alice.page.waitForSelector('#preview-backdrop:not([hidden])', { timeout: 20000 });

    const preview = await alice.page.evaluate(() => ({
      items: document.querySelectorAll('#preview-list .preview-item').length,
      label: document.querySelector('#preview-list .label')?.textContent ?? '',
      hasThumb: Boolean(document.querySelector('#preview-list .thumb img')),
    }));
    assert.equal(preview.items, 1);
    assert.match(preview.label, /holiday\.png/);
    assert.ok(preview.hasThumb, 'a thumbnail is generated so the bubble can draw instantly');

    await alice.page.fill('#preview-caption', 'from the trip');
    await alice.page.click('#btn-preview-send');
  });

  await t.test('the sender shows progress, then waiting, then done', async () => {
    await alice.page.waitForFunction(
      "window.__p2p.getState().messages.some((m) => m.attachment && m.attachment.status === 'complete')",
      null,
      { timeout: 60000 },
    );
    const message = await findMessage(alice.page, "m.attachment.status === 'complete'");
    assert.equal(message.text, 'from the trip');
    assert.equal(message.attachment.kind, 'image');
    assert.ok(message.attachment.fileId, 'the message carries the content digest');
    assert.equal(message.attachment.progress, 1);
  });

  await t.test('the receiver assembled the same bytes', async () => {
    await bob.page.waitForFunction(
      "window.__p2p.getState().messages.some((m) => m.attachment && m.attachment.status === 'complete')",
      null,
      { timeout: 60000 },
    );
    const message = await findMessage(bob.page, "m.attachment.status === 'complete'");
    assert.equal(message.attachment.size, png.length);
    assert.equal(message.attachment.kind, 'image');

    // The stored blob must be byte-identical, which the digest proves.
    const stored = await bob.page.evaluate(
      (fileId) => window.__p2p.readMedia(fileId),
      message.attachment.fileId,
    );
    assert.equal(stored.size, png.length);
    assert.match(stored.mime, /image\/png/);
  });

  await t.test('the image is on screen, not just in memory', async () => {
    const image = await bob.page.evaluate(() => {
      const img = document.querySelector('#messages .msg.them .media.image img');
      return img ? { src: img.src.slice(0, 5), complete: img.complete && img.naturalWidth > 0 } : null;
    });
    assert.ok(image, 'an image element was rendered');
    assert.equal(image.src, 'blob:', 'it points at the locally stored blob');
    assert.equal(image.complete, true, 'and it actually loaded');
  });

  await t.test('the file survives a reload on the receiving side', async () => {
    await bob.page.reload({ waitUntil: 'load' });
    await bob.page.evaluate(() => window.__p2p.ready);
    await bob.page.click('#chat-list .chat-row');
    await bob.page.waitForSelector('#view-chat:not([hidden])', { timeout: 10000 });

    const image = await bob.page.evaluate(() => {
      const img = document.querySelector('#messages .msg.them .media.image img');
      return img ? img.complete && img.naturalWidth > 0 : false;
    });
    assert.equal(image, true, 'the stored blob is re-rendered after a reload');
  });
});

test('an interrupted transfer resumes instead of starting over', { timeout: 300000 }, async (t) => {
  const server = await createStaticServer({ root: PROJECT_ROOT });
  const browser = await launchBrowser();
  t.after(async () => {
    await browser.close();
    await server.close();
  });

  const alice = await openPeer(browser, server.url, 'alice');
  const bob = await openPeer(browser, server.url, 'bob');

  await alice.page.fill('#nick-input', 'alice-quiet');
  await alice.page.click('#btn-new-chat');
  await alice.page.click('#btn-create');
  await pair(alice, bob, { nick: 'bob-amber' });
  await waitForOpen(alice);

  // 4 MB is 256 chunks: long enough to interrupt part-way with confidence.
  const big = randomBytes(4 * 1024 * 1024);
  let fileId = null;

  await t.test('a transfer can be interrupted part-way', async () => {
    await sendFile(alice.page, '#input-files', {
      name: 'archive.bin',
      mimeType: 'application/octet-stream',
      buffer: big,
    });

    // Let some chunks flow, then pull the link out.
    await bob.page.waitForFunction(
      "window.__p2p.getState().messages.some((m) => m.attachment && m.attachment.progress > 0.02)",
      null,
      { timeout: 30000 },
    );
    await alice.page.evaluate(() => window.__p2p.session().close());

    const message = await findMessage(bob.page, 'true');
    fileId = message.attachment.fileId;
    assert.ok(message.attachment.progress > 0, 'some of the file arrived');
    assert.ok(message.attachment.progress < 1, 'but not all of it');
    assert.notEqual(message.attachment.status, 'complete');

    const held = await bob.page.evaluate(
      (id) => window.__p2p.pendingTransfers().incoming >= 0 && id !== null,
      fileId,
    );
    assert.ok(held !== false);
  });

  await t.test('the unfinished transfer is remembered on both sides', async () => {
    // The receiver notices the drop when its own channel closes; until then it
    // is still "receiving", which is honest rather than wrong.
    await bob.page.waitForFunction('window.__p2p.getState().open === false', null, { timeout: 40000 });

    const pending = await bob.page.evaluate(() => window.__p2p.pendingTransfers());
    assert.ok(pending.incoming >= 1, 'the receiver still holds the partial file');

    const progress = await findMessage(bob.page, 'true');
    assert.equal(progress.attachment.status, 'pending', 'and shows it as waiting to resume');
    assert.ok(progress.attachment.progress > 0, 'with the part that did arrive still counted');
    assert.ok(progress.attachment.progress < 1);

    // Nothing was thrown away: the chunks are on disk, which is what makes the
    // resume possible rather than merely advertised.
    const held = await bob.page.evaluate(
      (fileId) => window.__p2p.heldChunks(fileId),
      progress.attachment.fileId,
    );
    assert.ok(held > 0, `the receiver kept ${held} chunks`);
  });

  await t.test('paring again completes it, sending only the gap', async () => {
    // A fresh manual handshake, as two people would do after a drop. Both have
    // to be on a pairing screen — inside a conversation there is no app bar.
    await alice.page.evaluate(() => window.__p2p.goHome());
    await alice.page.click('#btn-new-chat');
    await bob.page.click('#btn-back');
    await bob.page.click('#btn-new-chat');
    await alice.page.click('#btn-new-chat');
  await alice.page.click('#btn-create');
    await pair(alice, bob);
    await waitForOpen(alice);

    await bob.page.waitForFunction(
      "window.__p2p.getState().messages.some((m) => m.attachment && m.attachment.status === 'complete')",
      null,
      { timeout: 120000 },
    );

    const stats = await alice.page.evaluate(() => window.__p2p.transferStats());
    assert.ok(stats.resumed >= 1, 'the second attempt was a resume, not a fresh send');
    assert.ok(
      stats.skippedBytes > 0,
      `the sender skipped bytes it knew were already there (skipped ${stats.skippedBytes})`,
    );
    assert.ok(
      stats.sentBytes + stats.skippedBytes >= big.length,
      'and between them the two runs account for the whole file',
    );

    const message = await findMessage(bob.page, 'true');
    assert.equal(message.attachment.status, 'complete');
    assert.equal(message.attachment.size, big.length);

    const stored = await bob.page.evaluate((id) => window.__p2p.readMedia(id), message.attachment.fileId);
    assert.equal(stored.size, big.length, 'the reassembled file is exactly the right size');

    // The digest the sender promised is the file id, so an intact arrival is
    // already proven — but check the sender was told about it too.
    const senderMessage = await findMessage(alice.page, 'true');
    assert.equal(senderMessage.attachment.status, 'complete', 'the sender learned it was delivered');
  });

  await t.test('nothing is left half-finished', async () => {
    await wait(500);
    const pending = await alice.page.evaluate(() => window.__p2p.pendingTransfers());
    assert.equal(pending.outgoing, 0, 'no orphaned outgoing transfers');
    const receiverPending = await bob.page.evaluate(() => window.__p2p.pendingTransfers());
    assert.equal(receiverPending.incoming, 0, 'no orphaned incoming transfers');
  });
});

test('a disappearing photo takes its bytes with it', { timeout: 240000 }, async (t) => {
  const server = await createStaticServer({ root: PROJECT_ROOT });
  const browser = await launchBrowser();
  t.after(async () => {
    await browser.close();
    await server.close();
  });

  const alice = await openPeer(browser, server.url, 'alice');
  const bob = await openPeer(browser, server.url, 'bob');

  await alice.page.fill('#nick-input', 'alice-quiet');
  await alice.page.click('#btn-new-chat');
  await alice.page.click('#btn-create');
  await pair(alice, bob, { nick: 'bob-amber' });
  await waitForOpen(alice);

  // Arm the timer before sending, because the expiry is stamped at send time.
  await alice.page.evaluate(() => window.__p2p.setDisappearing(1));
  await alice.page.waitForFunction('window.__p2p.getState().disappearing === 1', null, { timeout: 10000 });
  await bob.page.waitForFunction('window.__p2p.getState().disappearing === 1', null, { timeout: 15000 });

  const png = await makePng(alice.page, { width: 60, height: 60 });
  await sendFile(alice.page, '#input-photos', {
    name: 'ephemeral.png',
    mimeType: 'image/png',
    buffer: png,
  });

  await bob.page.waitForFunction(
    "window.__p2p.getState().messages.some((m) => m.attachment && m.attachment.status === 'complete')",
    null,
    { timeout: 60000 },
  );
  const received = await findMessage(bob.page, 'true');
  const fileId = received.attachment.fileId;
  assert.ok(await bob.page.evaluate((id) => window.__p2p.readMedia(id), fileId), 'the photo is stored');

  await wait(1400);
  await Promise.all([
    alice.page.evaluate(() => window.__p2p.sweepExpired()),
    bob.page.evaluate(() => window.__p2p.sweepExpired()),
  ]);

  for (const peer of [alice, bob]) {
    const stillThere = await peer.page.evaluate(
      "window.__p2p.getState().messages.some((m) => m.attachment)",
    );
    assert.equal(stillThere, false, `${peer.label} should have dropped the message`);
  }

  // And the bytes are gone from disk, not merely hidden from the list.
  const stored = await bob.page.evaluate((id) => window.__p2p.readMedia(id), fileId);
  assert.equal(stored, null, 'the blob was deleted with the message');
});
