/**
 * Swarming: fetching one file from several peers at once.
 *
 * Three peers in a room. The host shares a file with one member, that member
 * finishes and announces it holds the file — then the host shares the same file
 * with the second member, who takes part of it from the first member instead of
 * all of it from the host. The second member's transfer completing is the proof
 * that a non-primary peer served it.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';

import { createStaticServer } from '../../serve.mjs';
import { PROJECT_ROOT, launchBrowser, openPeer, pair, state, waitForOpen, createInvite } from './helpers.mjs';

const wait = (ms) => new Promise((done) => setTimeout(done, ms));

const attachmentOf = (page) =>
  page.evaluate(() => {
    const message = window.__p2p.getState().messages.find((m) => m.attachment);
    return message ? JSON.parse(JSON.stringify(message.attachment)) : null;
  });

async function shareFile(page, file) {
  await page.setInputFiles('#input-files', file);
  await page.waitForSelector('#preview-backdrop:not([hidden])', { timeout: 20000 });
  await page.waitForFunction(() => window.__p2p.pendingAttachments() === 1, null, { timeout: 90000 });
  await page.click('#btn-preview-send');
}

async function waitForComplete(page, timeout = 120000) {
  await page.waitForFunction(
    "window.__p2p.getState().messages.some((m) => m.attachment && m.attachment.status === 'complete')",
    null,
    { timeout },
  );
}

test('a room fetches one file from more than one peer', { timeout: 400000 }, async (t) => {
  const server = await createStaticServer({ root: PROJECT_ROOT });
  const browser = await launchBrowser();
  t.after(async () => {
    await browser.close();
    await server.close();
  });

  const host = await openPeer(browser, server.url, 'host');
  const one = await openPeer(browser, server.url, 'member-one');
  const two = await openPeer(browser, server.url, 'member-two');

  await t.test('three peers form a room', async () => {
    await host.page.fill('#nick-input', 'host-olive');
    await host.page.click('#btn-new-chat');
    await host.page.check('#group-mode');
    await host.page.fill('#group-label', 'swarm room');
    await createInvite(host);

    await pair(host, one, { nick: 'member-one' });
    await host.page.click('#btn-invite-another');
    await host.page.waitForSelector('#view-connect:not([hidden])', { timeout: 15000 });
    await pair(host, two, { nick: 'member-two' });

    for (const peer of [host, one, two]) {
      await peer.page.waitForFunction(
        () => (window.__p2p.getState().group?.links.length ?? 0) >= 2,
        null,
        { timeout: 60000 },
      );
    }
    assert.equal((await state(host)).group.count, 3);
  });

  // Big enough to be split several ways, small enough to stay quick.
  const payload = randomBytes(3 * 1024 * 1024);

  await t.test('the first member receives the file directly', async () => {
    await shareFile(host.page, { name: 'shared.bin', mimeType: 'application/octet-stream', buffer: payload });
    await waitForComplete(one.page);

    const attachment = await attachmentOf(one.page);
    assert.equal(attachment.size, payload.length);
    assert.ok(attachment.pieceHashes?.length > 1, 'the offer carries a piece manifest');
    assert.ok(attachment.pieceSize > 0);

    const stored = await one.page.evaluate((id) => window.__p2p.readMedia(id), attachment.fileId);
    assert.equal(stored.size, payload.length, 'and the bytes are intact');
  });

  await t.test('a file is served partly by a peer that is not its author', async () => {
    // Sharing again is the deterministic version of the situation this feature
    // exists for: one member already holds the file, so the next transfer does
    // not have to come entirely from the original sender.
    await shareFile(host.page, { name: 'shared.bin', mimeType: 'application/octet-stream', buffer: payload });
    await waitForComplete(two.page);

    const attachment = await attachmentOf(two.page);
    assert.equal(attachment.size, payload.length);
    const stored = await two.page.evaluate((id) => window.__p2p.readMedia(id), attachment.fileId);
    assert.equal(stored.size, payload.length, 'the file assembled correctly from two sources');

    // The proof: member one served chunks of a file it did not author.
    const served = await one.page.evaluate(() => window.__p2p.transferStats().served);
    assert.ok(served > 0, `member one served ${served} chunks to another peer`);

    // And the author was told to skip what the peer was covering.
    const hostStats = await host.page.evaluate(() => window.__p2p.transferStats());
    assert.ok(
      hostStats.skippedBytes > 0,
      `the host was told to skip ${hostStats.skippedBytes} bytes another peer was serving`,
    );
  });

  await t.test('everyone ends up with the identical file', async () => {
    const [a, b] = await Promise.all([attachmentOf(one.page), attachmentOf(two.page)]);
    assert.equal(a.fileId, b.fileId, 'the same content has the same identity');
    assert.equal(a.fileId.length, 64, 'the id is a sha-256 digest');

    for (const peer of [one, two]) {
      const intact = await peer.page.evaluate(async (id) => {
        const record = await window.__p2p.readMedia(id);
        return record?.size ?? null;
      }, a.fileId);
      assert.equal(intact, payload.length);
    }
  });

  await t.test('nothing is left half-finished', async () => {
    await wait(500);
    for (const peer of [host, one, two]) {
      const pending = await peer.page.evaluate(() => window.__p2p.pendingTransfers());
      assert.equal(pending.outgoing, 0, `${peer.label} has no orphaned sends`);
      assert.equal(pending.incoming, 0, `${peer.label} has no orphaned receives`);
    }
  });
});
