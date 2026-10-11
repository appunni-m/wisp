/**
 * The native app and the desktop client, pairing with each other.
 *
 * This is the acceptance test for the native transport: a phone running the
 * Kotlin client shows an invite, a browser pastes it and produces a reply, the
 * phone takes the reply, and a message crosses in both directions. Everything
 * before this was either a build or a unit test; this is the claim that the two
 * implementations actually talk.
 *
 * The emulator sits behind QEMU's NAT, which is the symmetric case STUN cannot
 * solve, so both sides are pointed at a local TURN relay. That is also the
 * fallback roughly one pair in ten needs in the real world, so it is worth
 * exercising rather than working around.
 *
 *   node tools/native-pair-check.mjs
 */

import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { createStaticServer } from '../serve.mjs';
import { startTurnServer, turnConfigFor, TURN_PORT } from './turn-server.mjs';
import { launchBrowser, openPeer, testUrl } from '../test/e2e/helpers.mjs';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const PACKAGE = 'chat.wisp.android';
const ACTIVITY = `${PACKAGE}/${PACKAGE}.MainActivity`;
const TAG = 'Wisp';

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

function findAdb() {
  const candidates = [
    process.env.ADB_PATH,
    `${ROOT}.android-sdk/platform-tools/adb`,
  ].filter(Boolean);
  for (const candidate of candidates) if (existsSync(candidate)) return candidate;
  try {
    return execFileSync('which', ['adb'], { stdio: 'pipe' }).toString().trim() || null;
  } catch {
    return null;
  }
}

const ADB = findAdb();
if (!ADB) {
  console.error('no adb on this machine');
  process.exit(2);
}

const adb = (...args) =>
  execFileSync(ADB, args, { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });

/** Launch, or deliver an intent to, the native activity specifically. */
const startActivity = (...extra) => adb('shell', 'am', 'start', '-n', ACTIVITY, ...extra);

/** Whether the package is on the device at all, running or not. */
function installed() {
  try {
    return adb('shell', 'pm', 'list', 'packages', PACKAGE).includes(PACKAGE);
  } catch {
    return false;
  }
}

function appPid() {
  try {
    if (!installed()) return null;
    return adb('shell', 'pidof', PACKAGE).trim() || null;
  } catch {
    return null;
  }
}

/**
 * Tap something by the text on it.
 *
 * Coordinates were the obvious approach and a bad one: they depend on the screen
 * size, the font scale and the theme, so they break on the first device that is
 * not the one they were measured on. Compose publishes its nodes to the
 * accessibility tree, so the text is enough.
 */
function tapText(label) {
  adb('shell', 'uiautomator', 'dump', '/sdcard/ui.xml');
  const xml = adb('shell', 'cat', '/sdcard/ui.xml');
  const node = xml
    .split('<node')
    .find((entry) => entry.includes(`text="${label}"`));
  if (!node) throw new Error(`no node with text "${label}" on screen`);
  const bounds = /bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/.exec(node);
  if (!bounds) throw new Error(`no bounds for "${label}"`);
  const [, left, top, right, bottom] = bounds.map(Number);
  adb('shell', 'input', 'tap', String(Math.round((left + right) / 2)), String(Math.round((top + bottom) / 2)));
}

/** Everything the app has logged under its tag, newest last. */
function appLog() {
  try {
    return adb('logcat', '-d', '-s', `${TAG}:I`).split('\n').filter(Boolean);
  } catch {
    return [];
  }
}

async function waitForLog(match, timeout = 60000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const line = appLog().find((entry) => match.test(entry));
    if (line) return line;
    await sleep(500);
  }
  return null;
}

let failures = 0;
function check(label, ok, detail = '') {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${label}${detail ? `  ${detail}` : ''}`);
  if (!ok) failures++;
}

async function main() {
  if (!appPid() && !installed()) {
    console.error(`${PACKAGE} is not installed. Build and install it first:\n` +
      `  cd native && ./gradlew :app:assembleDebug\n` +
      `  adb install -r native/app/build/outputs/apk/debug/app-arm64-v8a-debug.apk`);
    process.exit(2);
  }

  console.log('starting a relay and a web client');
  startTurnServer({ debug: 'ERROR' });
  const server = await createStaticServer({ root: ROOT });
  const browser = await launchBrowser();

  try {
    const desktop = await openPeer(browser, server.url, 'desktop');
    // The relay replaces the default STUN list on both sides.
    await desktop.page.goto(testUrl(server.url) + `&ice=${encodeURIComponent(`turn:127.0.0.1:${TURN_PORT}?transport=udp`)}&iceUser=linkline&icePass=linkline-secret`);
    await desktop.page.evaluate(() => window.__p2p.ready);
    await desktop.page.click('#btn-settings');
    await desktop.page.fill('#nick-input', 'desktop');
    await desktop.page.click('#btn-new-chat');

    console.log('\nfinding the code the phone is offering');
    adb('shell', 'logcat', '-c');
    adb('shell', 'am', 'force-stop', PACKAGE);
    await sleep(500);
    startActivity('--es', 'ice', `turn:10.0.2.2:${TURN_PORT}`, '--es', 'iceUser', 'linkline', '--es', 'icePass', 'linkline-secret');
    await sleep(3000);

    tapText('Create an invite');
    const inviteLine = await waitForLog(/invite: P2P1[zr]-/, 45000);
    if (!inviteLine) {
      console.error('the phone never produced an invite. Log so far:\n' + appLog().join('\n'));
      process.exit(1);
    }
    const invite = inviteLine.slice(inviteLine.indexOf('invite: ') + 'invite: '.length).trim();
    check('the phone produced an invite', invite.startsWith('P2P1'), `${invite.length} characters`);

    console.log('\nhanding it to the desktop client');
    await desktop.page.fill('#paste-input', invite);
    await desktop.page.click('#btn-paste');
    await desktop.page.waitForSelector('#view-reply:not([hidden])', { timeout: 45000 });
    const reply = await desktop.page.inputValue('#reply-code');
    check('the desktop accepted it and replied', reply.startsWith('P2P1'), `${reply.length} characters`);

    const verified = await desktop.page.evaluate(() => window.__p2p.getState().peerVerified);
    check('the desktop verified the phone\'s signature', verified === true);
    const nick = await desktop.page.evaluate(() => window.__p2p.getState().peerNick);
    check('the phone\'s nickname arrived', nick === 'android', String(nick));

    console.log('\nsending the reply back to the phone');
    // The component is named explicitly: the Capacitor app on this device claims
    // the same scheme, so an implicit intent opens a chooser instead.
    adb('shell', 'am', 'start', '-a', 'android.intent.action.VIEW', '-n', ACTIVITY, '-d', `wisp://pair#i=${reply}`);
    const opened = await waitForLog(/I Wisp\s*:\s*open\s*$/, 60000);
    check('the data channel opened on the phone', Boolean(opened));

    const connected = await desktop.page
      .waitForFunction("window.__p2p.getState().open === true", null, { timeout: 60000 })
      .then(() => true)
      .catch(() => false);
    check('the desktop sees the link as open', connected);

    console.log('\nchecking that messages cross');
    const arrived = await desktop.page
      .waitForFunction(
        "window.__p2p.getState().messages.some((m) => m.text === 'hello from android')",
        null,
        { timeout: 30000 },
      )
      .then(() => true)
      .catch(() => false);
    check('the phone\'s message reached the desktop', arrived);

    await desktop.page.fill('#message-input', 'hello from the desktop');
    await desktop.page.click('#btn-send');
    const received = await waitForLog(/I Wisp\s*:\s*received: .*hello from the desktop/, 45000);
    check('the desktop\'s message reached the phone', Boolean(received));

    if (!failures) console.log('\nthe native client and the web client paired and talked');
  } finally {
    await browser.close();
    await server.close();
    process.exit(failures ? 1 : 0);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
