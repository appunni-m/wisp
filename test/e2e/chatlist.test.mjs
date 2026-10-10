/**
 * The chat list, local history, delivery ticks and disappearing messages —
 * the behaviours that turn pairing into something that feels like a chat app.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { createStaticServer } from '../../serve.mjs';
import { PROJECT_ROOT, launchBrowser, openPeer, pair, state, waitForOpen, createInvite } from './helpers.mjs';

const wait = (ms) => new Promise((done) => setTimeout(done, ms));

test('conversations persist and behave like a chat list', { timeout: 240000 }, async (t) => {
  const server = await createStaticServer({ root: PROJECT_ROOT });
  const browser = await launchBrowser();
  t.after(async () => {
    await browser.close();
    await server.close();
  });

  const alice = await openPeer(browser, server.url, 'alice');
  const bob = await openPeer(browser, server.url, 'bob');

  await t.test('a first run offers pairing, not an empty list', async () => {
    await alice.page.fill('#nick-input', 'alice-quiet');
    // Nothing stored yet, so there is no list to show.
    assert.equal(await alice.page.evaluate(() => window.__p2p.chatList().length), 0);

    await alice.page.click('#btn-new-chat');
    assert.equal((await state(alice)).view, 'connect', 'and pairing is one tap away');
  });

  await t.test('pairing lands in the conversation', async () => {
    await alice.page.click('#btn-new-chat');
  await alice.page.click('#btn-create');
    await pair(alice, bob, { nick: 'bob-amber' });
    await waitForOpen(alice);

    const snapshot = await state(alice);
    assert.equal(snapshot.view, 'chat', 'pairing should open the conversation');
    assert.equal(snapshot.peerNick, 'bob-amber');
    assert.match(snapshot.chatId, /^peer:/);
  });

  await t.test('a sent message shows one tick, then two when delivered', async () => {
    await alice.page.fill('#message-input', 'first message');
    await alice.page.click('#btn-send');

    // Wait for the bubble to exist, then read the model and the tick together:
    // on a fast link the acknowledgement can land between two separate reads and
    // the pair would disagree with itself.
    await alice.page.waitForSelector('#messages .msg.me .ticks', { timeout: 10000 });
    const snapshot = await alice.page.evaluate(() => {
      const tick = document.querySelector('#messages .msg.me .ticks');
      return {
        count: window.__p2p.getState().messages.length,
        state: window.__p2p.getState().messages[0]?.state,
        title: tick?.title ?? null,
        ticks: tick?.textContent ?? null,
      };
    });
    assert.equal(snapshot.count, 1);
    assert.ok(['sent', 'delivered'].includes(snapshot.state), `unexpected state ${snapshot.state}`);
    assert.equal(snapshot.title, snapshot.state === 'delivered' ? 'Delivered' : 'Sent');
    assert.equal(snapshot.ticks, snapshot.state === 'delivered' ? '✓✓' : '✓');

    await alice.page.waitForFunction(
      "window.__p2p.getState().messages.some((m) => m.state === 'delivered')",
      null,
      { timeout: 15000 },
    );
    const messages = JSON.parse(await alice.page.evaluate('JSON.stringify(window.__p2p.getState().messages)'));
    assert.equal(messages[0].state, 'delivered', 'the peer acknowledged it');

    const ticks = await alice.page.textContent('#messages .msg.me .ticks');
    assert.equal(ticks, '✓✓');
    assert.equal(await alice.page.getAttribute('#messages .msg.me .ticks', 'title'), 'Delivered');
  });

  await t.test('the chat list shows the conversation, not the raw code', async () => {
    await alice.page.click('#btn-back');
    await alice.page.waitForSelector('#view-home:not([hidden])', { timeout: 10000 });

    const rows = await alice.page.evaluate(() =>
      [...document.querySelectorAll('#chat-list .chat-row')].map((row) => ({
        name: row.querySelector('.chat-row-name').textContent,
        preview: row.querySelector('.chat-row-preview').textContent,
      })),
    );
    assert.equal(rows.length, 1);
    assert.equal(rows[0].name, 'bob-amber');
    assert.equal(rows[0].preview, 'You: first message');
  });

  await t.test('a message that arrives while you are on the list is counted unread', async () => {
    await bob.page.fill('#message-input', 'are you there?');
    await bob.page.click('#btn-send');

    await alice.page.waitForFunction(
      "window.__p2p.getState().unread === 1",
      null,
      { timeout: 15000 },
    );
    const pill = await alice.page.textContent('#chat-list .unread-pill');
    assert.equal(pill, '1');
    assert.equal((await state(alice)).view, 'home', 'it must not yank you into the chat');

    // Opening it clears the badge.
    await alice.page.click('#chat-list .chat-row');
    await alice.page.waitForFunction('window.__p2p.getState().unread === 0', null, { timeout: 10000 });
    assert.equal(await alice.page.locator('#chat-list .unread-pill').count(), 0);
  });

  await t.test('history survives a reload', async () => {
    await alice.page.reload({ waitUntil: 'load' });
    await alice.page.evaluate(() => window.__p2p.ready);

    const view = await alice.page.evaluate(() => window.__p2p.getState().view);
    assert.equal(view, 'home', 'with a stored conversation the app opens on the list');

    const rows = await alice.page.evaluate(() =>
      [...document.querySelectorAll('#chat-list .chat-row')].map((row) => ({
        name: row.querySelector('.chat-row-name').textContent,
        preview: row.querySelector('.chat-row-preview').textContent,
      })),
    );
    assert.equal(rows.length, 1);
    assert.equal(rows[0].name, 'bob-amber');

    await alice.page.click('#chat-list .chat-row');
    await alice.page.waitForSelector('#view-chat:not([hidden])', { timeout: 10000 });
    const texts = await alice.page.evaluate(() =>
      window.__p2p.getState().messages.map((m) => [m.who, m.text]),
    );
    assert.deepEqual(texts, [
      ['me', 'first message'],
      ['them', 'are you there?'],
    ]);
  });

  await t.test('a reloaded chat is honest that it is no longer connected', async () => {
    const snapshot = await state(alice);
    assert.equal(snapshot.open, false);
    assert.equal(await alice.page.isDisabled('#message-input'), true);
    const bar = await alice.page.textContent('#offline-bar');
    assert.match(bar, /waiting for bob-amber/i);
    const status = await alice.page.textContent('#chat-header-status');
    assert.match(status, /offline|last seen/);
  });
});

test('disappearing messages delete themselves on both devices', { timeout: 240000 }, async (t) => {
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

  await t.test('the menu offers the usual durations', async () => {
    await alice.page.click('#btn-chat-menu');
    await alice.page.waitForSelector('#sheet-backdrop:not([hidden])', { timeout: 10000 });
    const options = await alice.page.evaluate(() =>
      [...document.querySelectorAll('#ttl-options .ttl-option')].map((b) => b.textContent),
    );
    assert.deepEqual(options, ['Off', '1 hour', '24 hours', '7 days', '90 days']);
    assert.equal(
      await alice.page.getAttribute('.ttl-option[data-seconds="0"]', 'aria-pressed'),
      'true',
      'off by default',
    );
  });

  await t.test('turning it on announces the change to both sides', async () => {
    await alice.page.click('.ttl-option[data-seconds="86400"]');
    await alice.page.waitForFunction('window.__p2p.getState().disappearing === 86400', null, { timeout: 10000 });

    // The peer adopts the setting and says so.
    await bob.page.waitForFunction('window.__p2p.getState().disappearing === 86400', null, { timeout: 15000 });
    const notice = await bob.page.textContent('#messages .msg.system');
    assert.match(notice, /disappear after 24 hours/i);

    const header = await alice.page.textContent('#chat-header-status');
    assert.match(header, /disappears after 24 hours/);
    await alice.page.click('#btn-menu-close');
  });

  await t.test('a message with a timer carries an expiry, and then goes', async () => {
    // One second, so the rule can be observed rather than assumed.
    await alice.page.evaluate(() => window.__p2p.setDisappearing(1));
    await alice.page.waitForFunction('window.__p2p.getState().disappearing === 1', null, { timeout: 10000 });

    await alice.page.fill('#message-input', 'this will not last');
    await alice.page.click('#btn-send');

    const stamped = await alice.page.evaluate(
      "JSON.stringify(window.__p2p.getState().messages.find((m) => m.text === 'this will not last'))",
    );
    const message = JSON.parse(stamped);
    assert.ok(message.expiresAt, 'the message must carry its deadline');
    assert.ok(message.expiresAt - message.ts === 1000, 'the deadline is one second after sending');

    // The peer received it and stamped its own copy the same way.
    await bob.page.waitForFunction(
      "window.__p2p.getState().messages.some((m) => m.text === 'this will not last')",
      null,
      { timeout: 15000 },
    );
    const peerCopy = JSON.parse(
      await bob.page.evaluate(
        "JSON.stringify(window.__p2p.getState().messages.find((m) => m.text === 'this will not last'))",
      ),
    );
    assert.ok(peerCopy.expiresAt, 'the peer applies the same timer on arrival');

    await wait(1400);
    await alice.page.evaluate(() => window.__p2p.sweepExpired());
    await bob.page.evaluate(() => window.__p2p.sweepExpired());

    for (const peer of [alice, bob]) {
      const stillThere = await peer.page.evaluate(
        "window.__p2p.getState().messages.some((m) => m.text === 'this will not last')",
      );
      assert.equal(stillThere, false, `${peer.label} should have dropped the expired message`);
    }
  });

  await t.test('system notices outlive the messages around them', async () => {
    // The notice explaining the timer must not vanish with it, or the setting
    // silently becomes invisible.
    const notices = await alice.page.evaluate(() =>
      window.__p2p.getState().messages.filter((m) => m.who === 'system').map((m) => m.text),
    );
    assert.ok(notices.some((text) => /disappear/i.test(text)), 'the setting notice is still there');
  });

  await t.test('turning it off stops new messages expiring', async () => {
    await alice.page.evaluate(() => window.__p2p.setDisappearing(0));
    await alice.page.waitForFunction('window.__p2p.getState().disappearing === 0', null, { timeout: 10000 });
    await alice.page.fill('#message-input', 'this one stays');
    await alice.page.click('#btn-send');

    const message = JSON.parse(
      await alice.page.evaluate(
        "JSON.stringify(window.__p2p.getState().messages.find((m) => m.text === 'this one stays'))",
      ),
    );
    assert.equal(message.expiresAt, undefined);
  });
});
