/**
 * Run the real app in real Chrome, pair two peers, form a three-person room,
 * and capture screenshots. Also useful as a manual playground:
 *
 *   node tools/demo.mjs            # screenshots into docs/
 *   node tools/demo.mjs --keep     # leave the browser open for poking at
 */

import { mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { createStaticServer } from '../serve.mjs';
import { PROJECT_ROOT, launchBrowser, openPeer, pair, state } from '../test/e2e/helpers.mjs';

const OUT = fileURLToPath(new URL('../docs/', import.meta.url));
const PHONE = { width: 420, height: 900 };

async function phone(peer) {
  await peer.page.setViewportSize(PHONE);
  return peer;
}

/**
 * Collapse the identity drawer so screenshots show the conversation.
 * Idempotent, and a no-op inside a conversation where the bar that toggles it
 * is hidden (navigating there closes it anyway).
 */
async function closeDrawer(peer) {
  const { open, canToggle } = await peer.page.evaluate(() => ({
    open: !document.getElementById('identity-panel').hidden,
    canToggle: !document.getElementById('appbar').hidden,
  }));
  if (open && canToggle) await peer.page.click('#btn-settings');
  await peer.page.waitForFunction(() => document.getElementById('identity-panel').hidden, null, { timeout: 5000 });
  return peer;
}

const wait = (ms) => new Promise((done) => setTimeout(done, ms));

async function say(peer, text) {
  await peer.page.fill('#message-input', text);
  await peer.page.click('#btn-send');
  await wait(120);
}

async function main() {
  await mkdir(OUT, { recursive: true });
  const server = await createStaticServer({ root: PROJECT_ROOT });
  const browser = await launchBrowser();
  const keep = process.argv.includes('--keep');

  try {
    /* ---------------------------------------------------- one-to-one --- */
    const alice = await phone(await openPeer(browser, server.url, 'alice'));
    const bob = await phone(await openPeer(browser, server.url, 'bob'));

    await alice.page.fill('#nick-input', 'alice-quiet');
    await alice.page.click('#btn-new-chat');
    await alice.page.click('#btn-create');
    await alice.page.waitForSelector('#invite-result:not([hidden])', { timeout: 30000 });
    const invite = await alice.page.inputValue('#invite-code');
    console.log(`invite code: ${invite.length} characters`);
    const qr = await alice.page.evaluate(() => {
      const canvas = document.querySelector('#qr-canvas');
      return { backing: canvas.width, css: Math.round(canvas.getBoundingClientRect().width) };
    });
    console.log(`invite QR: ${qr.backing}px backing store, shown at ${qr.css}px`);
    await alice.page.evaluate(() => document.querySelector('#invite-result').scrollIntoView({ block: 'start' }));
    await wait(300);
    await alice.page.screenshot({ path: `${OUT}invite-qr.png` });

    await bob.page.fill('#nick-input', 'bob-amber');
    await bob.page.check('input[name="id-mode"][value="contact"]');
    await bob.page.fill('#contact-name', 'Bob Amber');
    await bob.page.fill('#contact-phone', '+44 7700 900123');
    await bob.page.fill('#contact-email', 'bob@example.org');
    await bob.page.click('#btn-new-chat');
    await bob.page.fill('#paste-input', invite);
    await bob.page.click('#btn-paste');
    await bob.page.waitForSelector('#view-reply:not([hidden])', { timeout: 30000 });
    const reply = await bob.page.inputValue('#reply-code');
    await wait(300);
    await bob.page.screenshot({ path: `${OUT}reply-qr.png` });

    await alice.page.click('#btn-new-chat');
    await alice.page.fill('#paste-input', reply);
    await alice.page.click('#btn-paste');

    const started = Date.now();
    await Promise.all([
      alice.page.waitForFunction(() => window.__p2p.getState().open, null, { timeout: 45000 }),
      bob.page.waitForFunction(() => window.__p2p.getState().open, null, { timeout: 45000 }),
    ]);
    console.log(`connected in ${Date.now() - started} ms`);

    await say(alice, 'hey — this is going straight between our two devices');
    await say(bob, 'no server in the middle?');
    await say(alice, 'none. the code we swapped was the whole handshake');
    await wait(400);
    await alice.page.screenshot({ path: `${OUT}chat-1to1.png` });

    const sas = (await state(alice)).sas;
    console.log(`short auth string: ${sas.emoji.join(' ')} ${sas.digits}`);

    /* ------------------------------------------------------- sharing a photo --- */
    // A picture drawn in the page, so the demo needs no assets.
    const dataUrl = await alice.page.evaluate(() => {
      const canvas = document.createElement('canvas');
      canvas.width = 640;
      canvas.height = 420;
      const context = canvas.getContext('2d');
      const sky = context.createLinearGradient(0, 0, 0, 420);
      sky.addColorStop(0, '#0b3d3a');
      sky.addColorStop(1, '#00a884');
      context.fillStyle = sky;
      context.fillRect(0, 0, 640, 420);
      context.fillStyle = 'rgba(255,255,255,0.92)';
      context.font = 'bold 44px sans-serif';
      context.fillText('sent peer to peer', 48, 200);
      context.font = '26px sans-serif';
      context.fillText('no server, no upload', 48, 250);
      return canvas.toDataURL('image/png');
    });
    const photo = Buffer.from(dataUrl.split(',')[1], 'base64');

    await alice.page.setInputFiles('#input-photos', {
      name: 'sunset.png',
      mimeType: 'image/png',
      buffer: photo,
    });
    await alice.page.waitForFunction('window.__p2p.pendingAttachments() === 1', null, { timeout: 60000 });
    await alice.page.fill('#preview-caption', 'straight down the wire');
    await alice.page.screenshot({ path: `${OUT}attach-preview.png` });
    await alice.page.click('#btn-preview-send');
    console.log(`photo sent: ${(photo.length / 1024).toFixed(1)} KB`);

    await bob.page.waitForFunction(
      "window.__p2p.getState().messages.some((m) => m.attachment && m.attachment.status === 'complete')",
      null,
      { timeout: 60000 },
    );
    const stats = await alice.page.evaluate(() => window.__p2p.transferStats());
    console.log(`transfer: ${stats.sentBytes} bytes sent, ${stats.completed} completed`);
    await wait(400);
    await bob.page.screenshot({ path: `${OUT}chat-media.png` });

    // A reply, quoted, the way a chat app shows it.
    await bob.page.evaluate(() => {
      const message = document.querySelector('#messages .msg.me');
      message.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, clientX: 10, clientY: 10 }));
    });
    await wait(700);
    await bob.page.click('#msg-reply');
    await bob.page.fill('#message-input', 'replying to that one');
    await bob.page.click('#btn-send');
    await wait(600);
    await alice.page.waitForFunction(
      "window.__p2p.getState().messages.some((m) => m.replyTo)",
      null,
      { timeout: 15000 },
    );
    await alice.page.screenshot({ path: `${OUT}chat-reply.png` });

    // Contact info, reached by tapping the name in the header.
    await alice.page.click('#chat-title');
    await alice.page.waitForSelector('#view-info:not([hidden])', { timeout: 10000 });
    await wait(300);
    await alice.page.screenshot({ path: `${OUT}contact-info.png` });
    await alice.page.click('#btn-info-back');
    await wait(200);

    // Back to the list, then a message arrives: this is the unread state.
    await alice.page.click('#btn-back');
    await wait(300);
    await say(bob, 'this one lands while you are looking at the list');
    await alice.page.waitForFunction('window.__p2p.getState().unread > 0', null, { timeout: 15000 });
    await wait(400);
    await alice.page.screenshot({ path: `${OUT}chat-list.png` });

    // The settings page, where your own identity lives.
    await alice.page.click('#tab-settings');
    await alice.page.waitForSelector('#view-settings:not([hidden])', { timeout: 10000 });
    await wait(300);
    await alice.page.screenshot({ path: `${OUT}settings.png` });
    await alice.page.click('#tab-chats');

    /* --------------------------------------------------------- group --- */
    const host = await phone(await openPeer(browser, server.url, 'host'));
    const one = await phone(await openPeer(browser, server.url, 'member-one'));
    const two = await phone(await openPeer(browser, server.url, 'member-two'));

    await host.page.fill('#nick-input', 'host-olive');
    await host.page.click('#btn-new-chat');
    await host.page.check('#group-mode');
    await host.page.fill('#group-label', 'Saturday planning');
    await host.page.click('#btn-create');
    await host.page.waitForSelector('#invite-result:not([hidden])', { timeout: 30000 });

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
    console.log('mesh formed: every member holds a direct link to every other member');

    await say(host, 'three of us, and nobody is running a server');
    await say(one, 'I only ever swapped one code — with you');
    await say(two, 'same here. I can see member-one directly now');
    await wait(500);
    await host.page.screenshot({ path: `${OUT}chat-group.png` });
    await one.page.screenshot({ path: `${OUT}chat-group-member.png` });

    const hostState = await state(host);
    console.log(`room members: ${hostState.group.members.map((m) => m.nick).join(', ')}`);
    console.log(`screenshots written to ${OUT}`);

    if (keep) {
      console.log('\n--keep given: browser left open. Press Ctrl+C to exit and clean up.');
      await new Promise(() => {});
    }
  } finally {
    if (!process.argv.includes('--keep')) {
      await browser.close();
      await server.close();
    }
  }
}

main().catch(async (error) => {
  console.error(error);
  process.exit(1);
});
