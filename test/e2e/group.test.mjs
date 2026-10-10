/**
 * End-to-end group test: three peers, one room, two manual code exchanges.
 *
 * Proves the two claims that make serverless groups work:
 *   1. Members signal each other THROUGH the room, so nobody needs a code per pair.
 *   2. The member who relays carries only ciphertext — it cannot read what it forwards.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { createStaticServer } from '../../serve.mjs';
import {
  PROJECT_ROOT,
  launchBrowser,
  openPeer,
  pair,
  state,
  tapWire,
  wireFrames, createInvite } from './helpers.mjs';

test('a room forms a mesh and relays messages it cannot read', { timeout: 300000 }, async (t) => {
  const server = await createStaticServer({ root: PROJECT_ROOT });
  const browser = await launchBrowser();
  t.after(async () => {
    await browser.close();
    await server.close();
  });

  const host = await openPeer(browser, server.url, 'host');
  const one = await openPeer(browser, server.url, 'member-one');
  const two = await openPeer(browser, server.url, 'member-two');

  // Watch what the hub actually puts on the wire.
  await tapWire(host.page);
  await tapWire(one.page);

  await t.test('the hub creates a named room', async () => {
    await host.page.fill('#nick-input', 'host-olive');
    // The room options live on the pairing screen, so go there first.
    await host.page.click('#btn-new-chat');
    await host.page.waitForSelector('#view-connect:not([hidden])', { timeout: 10000 });
    await host.page.check('#group-mode');
    await host.page.fill('#group-label', 'test room');
    await createInvite(host);

    const snapshot = await state(host);
    assert.notEqual(snapshot.roomId, '0', 'a room invite must carry a room id');
    assert.equal(snapshot.group?.isHost, true, 'the inviter hosts the room');
    assert.equal(snapshot.group?.label, 'test room');
  });

  await t.test('two members join with one code exchange each', async () => {
    await pair(host, one, { nick: 'member-one' });
    assert.equal((await state(one)).group?.isHost, false, 'a joiner is not the host');
    assert.equal((await state(host)).group?.count, 2, 'the hub sees both members');

    // The hub mints a second code for the same room.
    await host.page.click('#btn-invite-another');
    await host.page.waitForSelector('#view-connect:not([hidden])', { timeout: 15000 });
    await pair(host, two, { nick: 'member-two' });

    const hostState = await state(host);
    const oneState = await state(one);
    const twoState = await state(two);
    assert.equal(hostState.group.count, 3, 'hub knows three members');
    assert.equal(oneState.group.count, 3, 'member one learns about member two');
    assert.equal(twoState.group.count, 3, 'member two learns about both');
  });

  await t.test('members discover each other and build direct mesh links', async () => {
    // Everyone should end up with a direct link to every other member: two each.
    for (const peer of [host, one, two]) {
      await peer.page.waitForFunction(
        () => (window.__p2p.getState().group?.links.length ?? 0) >= 2,
        null,
        { timeout: 60000 },
      );
    }

    const hostState = await state(host);
    assert.deepEqual(hostState.group.members.map((m) => m.nick).sort(), ['host-olive', 'member-one', 'member-two']);
    assert.ok(
      hostState.group.members.filter((m) => !m.isSelf).every((m) => m.online && m.direct),
      'the hub is directly linked to both members',
    );

    // Member one and member two never exchanged a code by hand: they found each
    // other through the room and dialed directly.
    const oneSelf = await one.page.evaluate(() => window.__p2p.group().myKey);
    const twoSelf = await two.page.evaluate(() => window.__p2p.group().myKey);
    const oneLinks = new Set((await state(one)).group.links);
    const twoLinks = new Set((await state(two)).group.links);
    assert.ok(oneLinks.has(twoSelf), 'member one holds a direct link to member two');
    assert.ok(twoLinks.has(oneSelf), 'member two holds a direct link to member one');
  });

  await t.test('a message reaches everyone, but the relay only sees ciphertext', async () => {
    const oneSelf = await one.page.evaluate(() => window.__p2p.group().myKey);
    await one.page.fill('#message-input', 'the secret plan is cake');
    await one.page.click('#btn-send');

    for (const peer of [host, two]) {
      await peer.page.waitForFunction(
        () => window.__p2p.getState().messages.some((m) => m.text === 'the secret plan is cake'),
        null,
        { timeout: 20000 },
      );
    }

    const hostMessages = (await state(host)).messages;
    const delivered = hostMessages.find((m) => m.text === 'the secret plan is cake');
    assert.equal(delivered.from, 'member-one', 'the hub shows who said it');

    const twoMessages = (await state(two)).messages;
    assert.ok(
      twoMessages.some((m) => m.text === 'the secret plan is cake' && m.from === 'member-one'),
      'the other member received it directly',
    );

    // What the hub actually forwarded for member one's message.
    const frames = await wireFrames(host);
    const relays = frames
      .map((frame) => {
        try {
          return JSON.parse(frame);
        } catch {
          return null;
        }
      })
      .filter((frame) => frame?.t === 'g.chat' && frame.from === oneSelf);

    assert.ok(relays.length >= 1, 'the hub relayed at least one chat frame');
    for (const frame of relays) {
      assert.ok(frame.sealed, 'a chat frame carries sealed payloads');
      assert.ok(
        !JSON.stringify(frame).includes('the secret plan is cake'),
        'the relayed frame must not contain the plaintext',
      );
      // The hub is itself a member, so it has its own envelope key.
      const hostKey = await host.page.evaluate(() => window.__p2p.group().myKey);
      assert.ok(frame.sealed[hostKey], 'the hub gets its own sealed copy');
    }
  });

  await t.test('the hub can speak to the room too', async () => {
    await host.page.fill('#message-input', 'host here, cake confirmed');
    await host.page.click('#btn-send');
    for (const peer of [one, two]) {
      await peer.page.waitForFunction(
        () => window.__p2p.getState().messages.some((m) => m.text === 'host here, cake confirmed'),
        null,
        { timeout: 20000 },
      );
    }
  });

  await t.test('the room still works when a mesh link dies', async () => {
    // Close member two's peer-to-peer link, keeping only its link to the hub.
    await two.page.evaluate(() => {
      const group = window.__p2p.group();
      const hubSession = window.__p2p.session();
      for (const [key, session] of [...group.links]) {
        if (session === hubSession) continue;
        session.close();
        group.links.delete(key);
        const member = group.members.get(key);
        if (member) member.direct = false;
      }
    });

    const twoLinks = (await state(two)).group.links;
    assert.equal(twoLinks.length, 1, 'member two keeps only the hub link');

    // Member one sends: the hub must relay it onward, still sealed for member two.
    await one.page.fill('#message-input', 'relayed by the hub');
    await one.page.click('#btn-send');
    await two.page.waitForFunction(
      () => window.__p2p.getState().messages.some((m) => m.text === 'relayed by the hub'),
      null,
      { timeout: 20000 },
    );

    const received = (await state(two)).messages.find((m) => m.text === 'relayed by the hub');
    assert.equal(received.from, 'member-one', 'it arrived intact through the relay');
  });
});
