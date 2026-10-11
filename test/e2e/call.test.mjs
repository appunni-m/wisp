/**
 * A real call between two browsers.
 *
 * Chrome is given a synthetic camera and microphone, so this exercises the whole
 * path: permission, capture, renegotiating a connection that is already carrying
 * chat messages, the media actually flowing, the controls, and hanging up.
 *
 * What it cannot prove is how the call behaves on a bad network — that needs a
 * real one. The decisions taken in that case are unit tested in
 * test/unit/call.test.mjs, where the numbers can be chosen deliberately.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { createStaticServer } from '../../serve.mjs';
import {
  PROJECT_ROOT,
  createInvite,
  launchBrowser,
  openPeer,
  pair,
  state,
  testUrl,
  useSyntheticMedia,
  waitForOpen,
} from './helpers.mjs';

const wait = (ms) => new Promise((done) => setTimeout(done, ms));
const call = (peer) => peer.page.evaluate(() => window.__p2p.callState());
const incoming = (peer) => peer.page.evaluate(() => window.__p2p.incomingCall());

async function waitForCallState(peer, wanted, timeout = 30000) {
  await peer.page.waitForFunction(
    (target) => window.__p2p.callState()?.state === target,
    wanted,
    { timeout },
  );
  return call(peer);
}

test('two peers place a voice call over the chat connection', { timeout: 240000 }, async (t) => {
  const server = await createStaticServer({ root: PROJECT_ROOT });
  const browser = await launchBrowser();
  t.after(async () => {
    await browser.close();
    await server.close();
  });

  const alice = await openPeer(browser, server.url, 'alice');
  const bob = await openPeer(browser, server.url, 'bob');
  // An init script only applies to the next navigation.
  await Promise.all([useSyntheticMedia(alice.page), useSyntheticMedia(bob.page)]);
  await Promise.all([
    alice.page.goto(testUrl(server.url)),
    bob.page.goto(testUrl(server.url)),
  ]);
  // Reloading resets the app to its first-run state, identity panel closed.
  for (const peer of [alice, bob]) {
    await peer.page.evaluate(() => window.__p2p.ready);
    await peer.page.click('#btn-settings');
    await peer.page.waitForSelector('#identity-panel:not([hidden])', { timeout: 10000 });
  }

  await t.test('they pair first, because a call rides the chat link', async () => {
    await createInvite(alice);
    await pair(alice, bob, { nick: 'bob-amber' });
    await Promise.all([waitForOpen(alice), waitForOpen(bob)]);
    await alice.page.waitForSelector('#view-chat:not([hidden])', { timeout: 15000 });
    assert.equal((await state(alice)).peerNick, 'bob-amber');
  });

  await t.test('the call button offers a call, and bob is asked to accept', async () => {
    await alice.page.click('#btn-call-audio');
    await alice.page.waitForSelector('#call-screen:not([hidden])', { timeout: 15000 });

    // The screen appears before the microphone is open, so wait for capture.
    await alice.page.waitForFunction(
      () => window.__p2p.callState()?.hasLocalStream === true,
      null,
      { timeout: 20000 },
    );
    const ringing = await call(alice);
    assert.equal(ringing.state, 'ringing');
    assert.equal(ringing.role, 'caller');
    assert.equal(ringing.video, false, 'the voice button must not open the camera');
    assert.equal(ringing.hasLocalStream, true, 'the microphone is open before dialling');
    assert.equal(await alice.page.textContent('#call-status'), 'Ringing…');

    await bob.page.waitForSelector('#call-incoming:not([hidden])', { timeout: 15000 });
    const offer = await incoming(bob);
    assert.ok(offer, 'bob has something to answer');
    assert.equal(offer.video, false);
    assert.equal(await bob.page.textContent('#incoming-kind'), 'Incoming voice call');
  });

  await t.test('accepting connects the call and media flows', async () => {
    await bob.page.click('#btn-call-accept');
    await waitForCallState(alice, 'connected');
    await waitForCallState(bob, 'connected');

    const [a, b] = await Promise.all([call(alice), call(bob)]);
    assert.ok(a.hasRemoteStream, 'alice must be receiving bob');
    assert.ok(b.hasRemoteStream, 'and bob must be receiving alice');
    assert.ok(a.remoteAudioTracks + b.remoteAudioTracks >= 2, 'both directions carry audio');
  });

  await t.test('audio actually arrives rather than merely being negotiated', async () => {
    // Negotiation succeeding and packets arriving are different claims; this is
    // the second one.
    await alice.page.waitForFunction(
      () => {
        const stats = window.__p2p.callStats();
        return Boolean(stats && stats.inboundAudioBytes > 0);
      },
      null,
      { timeout: 30000 },
    );
    const stats = await alice.page.evaluate(() => window.__p2p.refreshCallStats());
    assert.ok(stats && stats.inboundAudioBytes > 0, `received ${stats?.inboundAudioBytes ?? 0} bytes of audio`);
  });

  await t.test('muting is reflected on the button and sent to the other side', async () => {
    await alice.page.click('#btn-call-mute');
    await alice.page.waitForFunction(() => window.__p2p.callState().muted === true, null, { timeout: 10000 });
    assert.equal(await alice.page.getAttribute('#btn-call-mute', 'aria-pressed'), 'true');

    await bob.page.waitForFunction(() => window.__p2p.callState()?.muted === true, null, { timeout: 15000 });
    await alice.page.click('#btn-call-mute');
    await bob.page.waitForFunction(() => window.__p2p.callState()?.muted === false, null, { timeout: 15000 });
  });

  await t.test('the connection quality is reported and has a profile', async () => {
    const stats = await alice.page.evaluate(() => window.__p2p.callStats());
    assert.ok(stats, 'the call should still be up');
    assert.ok(['good', 'fair', 'poor', 'bad'].includes(stats.tier), `unexpected tier ${stats.tier}`);
    // A loopback call is a good connection, so it should say so.
    assert.equal(stats.tier, 'good');
    assert.equal(stats.videoEnabled, false, 'a voice call has no video to degrade');
  });

  await t.test('hanging up ends it on both sides and leaves a line in the chat', async () => {
    await alice.page.click('#btn-call-end');
    await alice.page.waitForSelector('#call-screen', { state: 'hidden', timeout: 15000 });
    assert.equal(await call(alice), null, 'alice has no call');

    await bob.page.waitForFunction(() => window.__p2p.callState() === null, null, { timeout: 20000 });
    assert.equal(await bob.page.isVisible('#call-screen'), false, 'bob\'s call screen closed too');

    await alice.page.waitForFunction(
      "window.__p2p.getState().messages.some((m) => m.who === 'system' && /call/i.test(m.text))",
      null,
      { timeout: 15000 },
    );
  });

  await t.test('the chat link survived the call', async () => {
    await alice.page.fill('#message-input', 'still here after the call');
    await alice.page.click('#btn-send');
    await bob.page.waitForFunction(
      () => window.__p2p.getState().messages.some((m) => m.text === 'still here after the call'),
      null,
      { timeout: 20000 },
    );
  });

  await t.test('declining a call tells the caller instead of ringing forever', async () => {
    await alice.page.click('#btn-call-audio');
    await bob.page.waitForSelector('#call-incoming:not([hidden])', { timeout: 15000 });
    await bob.page.click('#btn-call-decline');

    await alice.page.waitForFunction(() => window.__p2p.callState() === null, null, { timeout: 20000 });
    assert.equal(await bob.page.isVisible('#call-incoming'), false);
  });

  await t.test('a video call sends a picture as well as sound', async () => {
    await alice.page.click('#btn-call-video');
    await bob.page.waitForSelector('#call-incoming:not([hidden])', { timeout: 15000 });
    assert.equal(await bob.page.textContent('#incoming-kind'), 'Incoming video call');
    await bob.page.click('#btn-call-accept');

    await alice.page.waitForFunction(
      () => (window.__p2p.callState()?.remoteVideoTracks ?? 0) > 0,
      null,
      { timeout: 30000 },
    );
    await alice.page.waitForFunction(
      () => {
        const stats = window.__p2p.callStats();
        return Boolean(stats && stats.inboundVideoBytes > 0);
      },
      null,
      { timeout: 30000 },
    );

    const stats = await alice.page.evaluate(() => window.__p2p.refreshCallStats());
    assert.ok(stats && stats.inboundVideoBytes > 0, `received ${stats?.inboundVideoBytes ?? 0} bytes of video`);
    assert.equal(stats.videoEnabled, true);
    assert.equal(await alice.page.isVisible('#call-self'), true, 'the self view is shown');

    // Turning the camera off must stop sending, not merely hide a preview.
    await alice.page.click('#btn-call-video-toggle');
    await alice.page.waitForFunction(() => window.__p2p.callState().cameraOn === false, null, { timeout: 10000 });
    await bob.page.waitForFunction(() => window.__p2p.callState()?.cameraOn === false, null, { timeout: 15000 });

    await alice.page.click('#btn-call-end');
    await bob.page.waitForFunction(() => window.__p2p.callState() === null, null, { timeout: 20000 });
    await wait(200);
  });

  await t.test('nothing broke along the way', async () => {
    const a = await state(alice);
    assert.equal(a.view, 'chat');
    assert.equal(a.open, true, 'the chat link is still open after two calls');
  });
});
