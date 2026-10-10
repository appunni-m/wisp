/**
 * Android integration test: the real APK, on a real Android runtime, pairing
 * with a desktop browser.
 *
 * This is the only test that exercises the things the browser cannot do:
 *   - the app booting from bundled assets on https://localhost (a secure context
 *     without any certificate handling),
 *   - an invite arriving as an Android intent rather than a paste,
 *   - the foreground service keeping the data channel alive while the app is
 *     hidden.
 *
 * Skipped when no emulator with the app installed is reachable, so the suite
 * stays green on a machine without the Android toolchain.
 *
 * Setup:
 *   source .android-env.sh
 *   emulator -avd linkline -no-window -no-audio -no-boot-anim -no-snapshot &
 *   adb install -r android/app/build/outputs/apk/debug/app-debug.apk
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createSocket } from 'node:dgram';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

import { createStaticServer } from '../../serve.mjs';
import { DEFAULT_ICE_SERVERS } from '../../src/sdp.js';
import { connectWebView } from '../../tools/android-cdp.mjs';
import { startTurnServer, turnConfigFor } from '../../tools/turn-server.mjs';

const ROOT = new URL('../../', import.meta.url);
const CHROME = process.env.CHROME_PATH
  ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

/**
 * `adb` lives in the project on a development machine and on the PATH on CI, so
 * look in both rather than assuming either.
 */
function findAdb() {
  const candidates = [
    process.env.ADB_PATH,
    fileURLToPath(new URL('.android-sdk/platform-tools/adb', ROOT)),
  ].filter(Boolean);
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  try {
    return execFileSync('which', ['adb'], { stdio: 'pipe' }).toString().trim() || null;
  } catch {
    return null;
  }
}

const ADB = findAdb();

const PACKAGE = 'chat.wisp.app';
const wait = (ms) => new Promise((done) => setTimeout(done, ms));

const adb = (...args) => execFileSync(ADB, args, { stdio: 'pipe' }).toString();

function runningAppPid() {
  if (!ADB) return null;
  try {
    return adb('shell', 'pidof', PACKAGE).trim() || null;
  } catch {
    return null;
  }
}

/** A free UDP port, so a leftover relay from an interrupted run cannot collide. */
function freeUdpPort() {
  return new Promise((resolve, reject) => {
    const socket = createSocket('udp4');
    socket.once('error', reject);
    socket.bind(0, '127.0.0.1', () => {
      const { port } = socket.address();
      socket.close(() => resolve(port));
    });
  });
}

test('the Android app pairs with a desktop peer and survives being backgrounded', { timeout: 240000 }, async (t) => {
  if (!ADB) {
    t.skip('no adb on this machine');
    return;
  }
  if (!runningAppPid()) {
    t.skip('no Android emulator with chat.wisp.app installed');
    return;
  }

  // Hermetic: wipe the app's stored identity and any live session first. Without
  // this, a reply code left over from a previous run reads as a fresh one and the
  // test appears to pass while the app is actually pairing with nothing.
  let pid;
  try {
    adb('shell', 'am', 'force-stop', PACKAGE);
    adb('shell', 'pm', 'clear', PACKAGE);
    adb('shell', 'am', 'start', '-n', `${PACKAGE}/.MainActivity`);
    await wait(7000);
    pid = adb('shell', 'pidof', PACKAGE).trim();
  } catch (error) {
    t.skip(`could not start the app on the emulator: ${error.message.split('\n')[0]}`);
    return;
  }
  assert.ok(pid, 'the app should be running after being started');

  // The emulator sits behind QEMU's NAT, which is exactly the symmetric-NAT case
  // that cannot be traversed without a relay. Running one here also exercises the
  // TURN path the README recommends for the ~10-20% of real mobile pairs.
  const turnPort = await freeUdpPort();
  const turn = startTurnServer({ debug: 'OFF', port: turnPort });
  // The phone does not need this server at all — it runs from bundled assets —
  // so it binds an ephemeral port and is used only by the desktop peer.
  const server = await createStaticServer({ port: 0 });
  const browser = await chromium.launch({ executablePath: CHROME, headless: true });

  t.after(async () => {
    turn.stop?.();
    await browser.close();
    await server.close();
    try {
      adb('forward', '--remove-all');
    } catch {
      // nothing to clean up
    }
  });

  // Forward the WebView's devtools socket so the test can drive the real app.
  adb('forward', 'tcp:9222', `localabstract:webview_devtools_remote_${pid}`);

  const view = await connectWebView();
  t.after(() => view.close());
  await view.evaluate('window.__p2p.ready');

  await t.test('the app runs from a secure local origin', async () => {
    const environment = JSON.parse(await view.evaluate(`JSON.stringify({
      url: location.href,
      secure: window.isSecureContext,
      subtle: typeof crypto.subtle,
      native: window.Capacitor?.isNativePlatform?.() === true,
      plugin: typeof window.Capacitor?.Plugins?.Wisp,
    })`));
    assert.equal(environment.secure, true, 'https://localhost must be a secure context');
    assert.equal(environment.subtle, 'object', 'crypto.subtle is what makes identity work');
    assert.equal(environment.native, true);
    assert.equal(environment.plugin, 'object', 'the Wisp native plugin must be registered');
  });

  await t.test('NFC is only offered where there is an NFC radio', async () => {
    // This emulator image has no NFC hardware, and a WebView still exposes
    // `NDEFReader` there — so the native hardware answer has to win.
    const capabilities = JSON.parse(await view.evaluate('JSON.stringify(window.__p2p.getState().capabilities)'));
    assert.equal(capabilities.nfc.native, true, 'the plugin is present');
    // Whether the WebView also exposes NDEFReader varies by image; what matters
    // is that the hardware answer wins either way.
    assert.equal(capabilities.nfc.supported, false, 'the hardware answer is authoritative');
    assert.equal(await view.evaluate('document.getElementById("btn-write-nfc").hidden'), true);
    assert.equal(await view.evaluate('document.getElementById("btn-tap-nfc").hidden'), true);
    assert.match(
      await view.evaluate('document.getElementById("pairing-capabilities").textContent'),
      /no NFC reader/,
    );
    assert.equal(capabilities.nfc.canRunInBackground, true, 'the foreground service is available');
  });

  const desktop = await (await browser.newContext()).newPage();
  desktop.on('pageerror', (error) => console.error('[desktop] page error:', error.message));
  await desktop.goto(server.url);
  await desktop.evaluate(() => window.__p2p.ready);

  const desktopIce = [...DEFAULT_ICE_SERVERS, ...turnConfigFor('127.0.0.1', turnPort)];
  const androidIce = [...DEFAULT_ICE_SERVERS, ...turnConfigFor('10.0.2.2', turnPort)];
  await desktop.evaluate((servers) => window.__p2p.setIceServers(servers), desktopIce);
  await view.evaluate(`window.__p2p.setIceServers(${JSON.stringify(androidIce)})`);

  let reply = '';
  let invite = '';

  await t.test('an invite link opens the app and produces a reply', async () => {
    await desktop.click('#btn-settings');
    await desktop.fill('#nick-input', 'desktop-peer');
    await desktop.click('#btn-new-chat');
    await desktop.click('#btn-create');
    await desktop.waitForSelector('#invite-result:not([hidden])', { timeout: 30000 });
    invite = await desktop.inputValue('#invite-code');
    assert.match(invite, /^P2P1[zr]-/);

    // Make sure a stale value cannot be mistaken for this run's reply.
    await view.evaluate("document.getElementById('reply-code').value = ''");

    // Delivered the way a real link would be: as a VIEW intent.
    adb('shell', `am start -a android.intent.action.VIEW -d 'wisp://pair#i=${invite}'`);

    for (let i = 0; i < 60 && !reply; i++) {
      reply = await view.evaluate('document.getElementById("reply-code").value || ""');
      if (!reply) await wait(500);
    }
    assert.match(reply, /^P2P1[zr]-/, 'the app should answer an invite that arrived by intent');

    const seen = JSON.parse(await view.evaluate('JSON.stringify(window.__p2p.getState())'));
    assert.equal(seen.peerNick, 'desktop-peer', 'the signed nickname verifies on the phone');
    assert.equal(seen.peerVerified, true, 'the invite signature checks out');
  });

  await t.test('the two devices complete the handshake', async () => {
    await desktop.fill('#paste-input', reply);
    await desktop.click('#btn-paste');

    const deadline = Date.now() + 90000;
    let connected = false;
    while (Date.now() < deadline && !connected) {
      const [onDesktop, onAndroid] = await Promise.all([
        desktop.evaluate(() => window.__p2p.getState().open),
        view.evaluate('window.__p2p.getState().open'),
      ]);
      connected = onDesktop && onAndroid;
      if (!connected) await wait(500);
    }
    assert.ok(connected, 'both ends must report an open data channel');

    // Matching short auth strings mean both sides see the same DTLS fingerprints
    // and identity keys: no relay is sitting in the middle.
    const [desktopSas, androidSas] = await Promise.all([
      desktop.evaluate(() => window.__p2p.getState().sas.digits),
      view.evaluate('window.__p2p.getState().sas.digits'),
    ]);
    assert.equal(desktopSas, androidSas, 'short auth strings must agree');
    assert.match(desktopSas, /^\d{6}$/);
  });

  await t.test('messages cross the phone/desktop boundary both ways', async () => {
    await desktop.fill('#message-input', 'hello from the desktop');
    await desktop.click('#btn-send');
    await waitForMessage(view, 'hello from the desktop');

    await view.evaluate("document.getElementById('message-input').value = 'hello from android'");
    await view.evaluate("document.getElementById('composer').requestSubmit()");
    await waitForMessage(desktop, 'hello from android');
  });

  await t.test('the foreground service keeps the link alive while hidden', async () => {
    adb('shell', 'input', 'keyevent', 'KEYCODE_HOME');
    await wait(3000);

    await desktop.fill('#message-input', 'sent while the app was hidden');
    await desktop.click('#btn-send');
    await wait(6000);

    adb('shell', 'am', 'start', '-n', `${PACKAGE}/.MainActivity`);
    await wait(3000);

    assert.equal(await view.evaluate('window.__p2p.getState().open'), true, 'link survived backgrounding');
    const received = await view.evaluate(
      "window.__p2p.getState().messages.some((m) => m.text === 'sent while the app was hidden')",
    );
    assert.ok(received, 'a message sent while the app was hidden must still arrive');

    const services = adb('shell', 'dumpsys', 'activity', 'services', PACKAGE);
    assert.match(services, /ConnectionService/, 'the foreground service should be running');
  });

  // Save a screenshot of the app in its connected state, for the docs.
  const shot = await view.screenshot();
  const { writeFile } = await import('node:fs/promises');
  await writeFile(fileURLToPath(new URL('../../docs/android-chat.png', import.meta.url)), Buffer.from(shot, 'base64'));
});

async function waitForMessage(target, text, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const found = await target.evaluate(
      `window.__p2p.getState().messages.some((m) => m.text === ${JSON.stringify(text)})`,
    );
    if (found) return true;
    await wait(400);
  }
  throw new Error(`message never arrived: ${text}`);
}
