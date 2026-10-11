/**
 * End-to-end: two real browser profiles, no signaling server, one manual
 * code exchange, then a live encrypted data channel.
 *
 * The whole flow is driven through the actual UI (buttons, form fields) so the
 * test covers the same path a person takes. State is read through the
 * `window.__p2p` seam only for assertions.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

import { createStaticServer } from '../../serve.mjs';
import { createInvite, testUrl } from './helpers.mjs';

const PROJECT_ROOT = fileURLToPath(new URL('../../', import.meta.url));

const CHROME_PATHS = [
  process.env.CHROME_PATH,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
].filter(Boolean);

function findChrome() {
  for (const candidate of CHROME_PATHS) {
    if (existsSync(candidate)) return candidate;
  }
  throw new Error(`no Chrome found; set CHROME_PATH. Looked in:\n  ${CHROME_PATHS.join('\n  ')}`);
}

/** Each peer gets its own browser context so IndexedDB (and its identity key) is isolated. */
async function openPeer(browser, baseUrl, label) {
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

const state = (peer) => peer.page.evaluate(() => window.__p2p.getState());

async function waitForOpen(peer, timeout = 45000) {
  try {
    await peer.page.waitForFunction(() => window.__p2p.getState().open === true, null, { timeout });
  } catch {
    const snapshot = await state(peer);
    throw new Error(`[${peer.label}] never opened: ${JSON.stringify(snapshot)}`);
  }
}

test('two peers pair by exchanging codes and chat over a direct data channel', { timeout: 180000 }, async (t) => {
  const server = await createStaticServer({ root: PROJECT_ROOT });
  const browser = await chromium.launch({ executablePath: findChrome(), headless: true });
  t.after(async () => {
    await browser.close();
    await server.close();
  });

  const alice = await openPeer(browser, server.url, 'alice');
  const bob = await openPeer(browser, server.url, 'bob');

  await t.test('step 1: alice creates a signed invite', async () => {
    await alice.page.fill('#nick-input', 'alice-quiet');
    await createInvite(alice);

    const code = await alice.page.inputValue('#invite-code');
    assert.match(code, /^P2P1[zr]-/, 'invite should be a compact code');
    assert.ok(code.length < 900, `invite code should stay pasteable, was ${code.length}`);

    const snapshot = await state(alice);
    assert.equal(snapshot.localInviteKind, 1, 'alice holds an offer');
    assert.equal(snapshot.view, 'connect');
  });

  const inviteCode = await alice.page.inputValue('#invite-code');

  await t.test('step 2: bob accepts it and produces a reply', async () => {
    await bob.page.fill('#nick-input', 'bob-amber');
    await bob.page.check('input[name="id-mode"][value="contact"]');
    await bob.page.fill('#contact-name', 'Bob Amber');
    await bob.page.fill('#contact-phone', '+44 7700 900123');
    await bob.page.fill('#contact-email', 'bob@example.org');

    // The identity form is the settings page; pairing starts from the chat list.
    await bob.page.click('#btn-new-chat');
    await bob.page.waitForSelector('#view-connect:not([hidden])', { timeout: 10000 });
    await bob.page.fill('#paste-input', inviteCode);
    await bob.page.click('#btn-paste');
    await bob.page.waitForSelector('#view-reply:not([hidden])', { timeout: 30000 });

    const reply = await bob.page.inputValue('#reply-code');
    assert.match(reply, /^P2P1[zr]-/);
    const snapshot = await state(bob);
    assert.equal(snapshot.localInviteKind, 2, 'bob holds an answer');
    assert.equal(snapshot.peerNick, 'alice-quiet', 'bob should see the signed nickname');
    assert.equal(snapshot.peerVerified, true, 'alice\'s invite must verify');
  });

  const replyCode = await bob.page.inputValue('#reply-code');

  await t.test('step 3: alice pastes the reply and the link comes up', async () => {
    await alice.page.click('#btn-new-chat');
    await alice.page.waitForSelector('#view-connect:not([hidden])', { timeout: 10000 });
    await alice.page.fill('#paste-input', replyCode);
    await alice.page.click('#btn-paste');

    await Promise.all([waitForOpen(alice), waitForOpen(bob)]);

    await alice.page.waitForSelector('#view-chat:not([hidden])', { timeout: 15000 });
    await bob.page.waitForSelector('#view-chat:not([hidden])', { timeout: 15000 });

    const aliceState = await state(alice);
    const bobState = await state(bob);
    assert.equal(aliceState.view, 'chat');
    assert.equal(bobState.view, 'chat');
    assert.equal(aliceState.peerNick, 'bob-amber');
    assert.equal(bobState.peerNick, 'alice-quiet');
    assert.equal(aliceState.peerVerified, true);
    assert.equal(bobState.peerVerified, true);
  });

  await t.test('step 4: identities and the short auth string agree', async () => {
    const aliceState = await state(alice);
    const bobState = await state(bob);

    assert.ok(aliceState.fingerprint && bobState.fingerprint);
    assert.notEqual(aliceState.fingerprint, bobState.fingerprint, 'each side has its own DTLS key');

    assert.ok(aliceState.sas && bobState.sas, 'both sides derive a short auth string');
    assert.equal(aliceState.sas.digits, bobState.sas.digits, 'SAS digits must match');
    assert.deepEqual(aliceState.sas.emoji, bobState.sas.emoji, 'SAS emoji must match');
    assert.match(aliceState.sas.digits, /^\d{6}$/);
  });

  await t.test('step 5: contact details travelled with the invite', async () => {
    const card = await alice.page.textContent('#peer-card');
    assert.match(card, /Bob Amber/);
    assert.match(card, /\+44 7700 900123/);
    assert.match(card, /bob@example\.org/);
    assert.match(card, /signed/);

    // The side that chose nickname-only mode shares no contact card.
    const bobCard = await bob.page.textContent('#peer-card');
    assert.ok(!bobCard.includes('@example.org'));
  });

  await t.test('step 6: messages flow both ways', async () => {
    await alice.page.fill('#message-input', 'hello from alice');
    await alice.page.click('#btn-send');

    await bob.page.waitForFunction(
      () => window.__p2p.getState().messages.some((m) => m.text === 'hello from alice'),
      null,
      { timeout: 15000 },
    );

    await bob.page.fill('#message-input', 'and hello back from bob');
    await bob.page.click('#btn-send');

    await alice.page.waitForFunction(
      () => window.__p2p.getState().messages.some((m) => m.text === 'and hello back from bob'),
      null,
      { timeout: 15000 },
    );

    const aliceState = await state(alice);
    const bobState = await state(bob);
    assert.deepEqual(
      aliceState.messages.map((m) => [m.who, m.text]),
      [['me', 'hello from alice'], ['them', 'and hello back from bob']],
    );
    assert.deepEqual(
      bobState.messages.map((m) => [m.who, m.text]),
      [['them', 'hello from alice'], ['me', 'and hello back from bob']],
    );

    // And it is really on screen, not just in memory.
    const rendered = await alice.page.textContent('#messages');
    assert.match(rendered, /hello from alice/);
    assert.match(rendered, /and hello back from bob/);
    assert.equal(await alice.page.locator('#messages .msg.me').count(), 1);
    assert.equal(await alice.page.locator('#messages .msg.them').count(), 1);
  });

  await t.test('step 7: the app works with no page-level errors', async () => {
    const errors = await alice.page.evaluate(() => window.__p2p.getState().error);
    assert.equal(errors, null, 'alice should have no recorded error');
  });
});

test('a corrupted code is refused instead of silently mispairing', { timeout: 60000 }, async (t) => {
  const server = await createStaticServer({ root: PROJECT_ROOT });
  const browser = await chromium.launch({ executablePath: findChrome(), headless: true });
  t.after(async () => {
    await browser.close();
    await server.close();
  });

  const alice = await openPeer(browser, server.url, 'alice');
  await alice.page.fill('#nick-input', 'alice-quiet');
  await createInvite(alice);
  const code = await alice.page.inputValue('#invite-code');

  const bob = await openPeer(browser, server.url, 'bob');
  await bob.page.click('#btn-new-chat');
  await bob.page.waitForSelector('#view-connect:not([hidden])', { timeout: 10000 });
  // Corrupt a character in the middle of the payload. (The final character is a
  // poor choice: base64 padding bits make some trailing edits decode identically.)
  const index = Math.floor(code.length * 0.4);
  const corrupted = `${code.slice(0, index)}${code[index] === 'A' ? 'B' : 'A'}${code.slice(index + 1)}`;
  assert.notEqual(corrupted, code);
  await bob.page.fill('#paste-input', corrupted);
  await bob.page.click('#btn-paste');

  await bob.page.waitForFunction(
    () => document.querySelector('#paste-hint').classList.contains('bad'),
    null,
    { timeout: 15000 },
  );
  const hint = await bob.page.textContent('#paste-hint');
  assert.ok(hint.length > 0, 'the user gets an explanation');
  const snapshot = await state(bob);
  assert.equal(snapshot.view, 'connect', 'bob never reaches the reply screen');
  assert.equal(snapshot.open, false);
});

test('a reply code pasted into a fresh tab is rejected with guidance', { timeout: 60000 }, async (t) => {
  const server = await createStaticServer({ root: PROJECT_ROOT });
  const browser = await chromium.launch({ executablePath: findChrome(), headless: true });
  t.after(async () => {
    await browser.close();
    await server.close();
  });

  const alice = await openPeer(browser, server.url, 'alice');
  await alice.page.fill('#nick-input', 'alice-quiet');
  await createInvite(alice);
  const invite = await alice.page.inputValue('#invite-code');

  const bob = await openPeer(browser, server.url, 'bob');
  await bob.page.click('#btn-new-chat');
  await bob.page.waitForSelector('#view-connect:not([hidden])', { timeout: 10000 });
  await bob.page.fill('#paste-input', invite);
  await bob.page.click('#btn-paste');
  await bob.page.waitForSelector('#view-reply:not([hidden])', { timeout: 30000 });
  const reply = await bob.page.inputValue('#reply-code');

  // Carol has no pending offer, so an answer is meaningless to her.
  const carol = await openPeer(browser, server.url, 'carol');
  await carol.page.click('#btn-new-chat');
  await carol.page.waitForSelector('#view-connect:not([hidden])', { timeout: 10000 });
  await carol.page.fill('#paste-input', reply);
  await carol.page.click('#btn-paste');
  await carol.page.waitForFunction(
    () => document.querySelector('#paste-hint').classList.contains('bad'),
    null,
    { timeout: 15000 },
  );
  const hint = await carol.page.textContent('#paste-hint');
  assert.match(hint, /no invite waiting/i);
});
