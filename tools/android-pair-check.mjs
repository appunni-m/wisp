/**
 * Scratch harness: pair the real Android app with a desktop browser.
 * Run with: node tools/android-pair-check.mjs
 */

import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { chromium } from 'playwright-core';

import { createStaticServer } from '../serve.mjs';
import { DEFAULT_ICE_SERVERS } from '../src/sdp.js';
import { connectWebView } from './android-cdp.mjs';
import { turnConfigFor } from './turn-server.mjs';

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const ADB = new URL('../.android-sdk/platform-tools/adb', import.meta.url).pathname;

const wait = (ms) => new Promise((done) => setTimeout(done, ms));

async function main() {
  const server = await createStaticServer({ port: 8080 });
  const browser = await chromium.launch({ executablePath: CHROME, headless: true });
  const page = await (await browser.newContext()).newPage();
  page.on('pageerror', (error) => console.error('[desktop] page error:', error.message));
  await page.goto(server.url);
  await page.evaluate(() => window.__p2p.ready);

  const view = await connectWebView();
  await view.evaluate('window.__p2p.ready');

  // The emulator is behind QEMU's NAT, so this pairing needs a relay. Configure
  // both sides to use the local TURN server: reachable at the host loopback for
  // the emulator (10.0.2.2) and directly for the desktop.
  const desktopIce = [...DEFAULT_ICE_SERVERS, ...turnConfigFor('127.0.0.1')];
  const androidIce = [...DEFAULT_ICE_SERVERS, ...turnConfigFor('10.0.2.2')];
  await page.evaluate((servers) => window.__p2p.setIceServers(servers), desktopIce);
  await view.evaluate(`window.__p2p.setIceServers(${JSON.stringify(androidIce)})`);
  console.log('0. both peers configured with the local TURN relay');

  console.log('1. desktop creates an invite');
  await page.click('#btn-settings');
  await page.fill('#nick-input', 'desktop-peer');
  await page.click('#btn-create');
  await page.waitForSelector('#invite-result:not([hidden])', { timeout: 30000 });
  const invite = await page.inputValue('#invite-code');
  console.log(`   invite: ${invite.length} chars`);

  console.log('2. hand it to the Android app as a deep link');
  execFileSync(ADB, [
    'shell',
    `am start -a android.intent.action.VIEW -d 'linkline://pair#i=${invite}'`,
  ], { stdio: 'pipe' });

  console.log('3. waiting for the app to produce a reply');
  let reply = '';
  for (let i = 0; i < 60; i++) {
    reply = await view.evaluate("document.getElementById('reply-code').value || ''");
    if (reply) break;
    await wait(500);
  }
  if (!reply) {
    const diagnostic = await view.evaluate(
      "JSON.stringify({ hint: document.getElementById('paste-hint').textContent, view: window.__p2p.getState().view, error: window.__p2p.getState().error })",
    );
    throw new Error(`no reply code appeared. ${diagnostic}`);
  }
  console.log(`   reply: ${reply.length} chars`);

  console.log('4. desktop accepts the reply');
  await page.fill('#paste-input', reply);
  await page.click('#btn-paste');

  const deadline = Date.now() + 60000;
  let connected = false;
  while (Date.now() < deadline) {
    const [desktopOpen, androidOpen] = await Promise.all([
      page.evaluate(() => window.__p2p.getState().open),
      view.evaluate('window.__p2p.getState().open'),
    ]);
    if (desktopOpen && androidOpen) {
      connected = true;
      break;
    }
    await wait(500);
  }
  const desktopState = await page.evaluate(() => JSON.stringify(window.__p2p.getState()));
  const androidState = await view.evaluate('JSON.stringify(window.__p2p.getState())');
  console.log(`   connected: ${connected}`);
  console.log(`   desktop sas: ${JSON.parse(desktopState).sas?.digits}  android sas: ${JSON.parse(androidState).sas?.digits}`);
  console.log(`   android sees peer: ${JSON.parse(androidState).peerNick}`);

  if (!connected) {
    console.log('   desktop:', desktopState);
    console.log('   android:', androidState);
    process.exitCode = 1;
    return;
  }

  console.log('5. desktop -> android message');
  await page.fill('#message-input', 'hello from the desktop');
  await page.click('#btn-send');
  for (let i = 0; i < 40; i++) {
    const messages = await view.evaluate('JSON.stringify(window.__p2p.getState().messages)');
    if (JSON.parse(messages).some((m) => m.text === 'hello from the desktop')) {
      console.log('   delivered');
      break;
    }
    await wait(500);
  }

  console.log('6. android -> desktop message');
  await view.evaluate("document.getElementById('message-input').value = 'hello from android'");
  await view.evaluate("document.getElementById('composer').requestSubmit()");
  for (let i = 0; i < 40; i++) {
    const messages = await page.evaluate(() => JSON.stringify(window.__p2p.getState().messages));
    if (JSON.parse(messages).some((m) => m.text === 'hello from android')) {
      console.log('   delivered');
      break;
    }
    await wait(500);
  }

  console.log('7. background the app and check the connection survives');
  execFileSync(ADB, ['shell', 'input', 'keyevent', 'KEYCODE_HOME'], { stdio: 'pipe' });
  await wait(3000);
  await page.fill('#message-input', 'sent while the app was in the background');
  await page.click('#btn-send');
  await wait(5000);
  execFileSync(ADB, ['shell', 'am', 'start', '-n', 'chat.linkline.app/.MainActivity'], { stdio: 'pipe' });
  await wait(3000);

  const survived = await view.evaluate(
    "JSON.stringify(window.__p2p.getState().messages.some((m) => m.text === 'sent while the app was in the background'))",
  );
  const stillOpen = await view.evaluate('window.__p2p.getState().open');
  console.log(`   link still open after backgrounding: ${stillOpen}`);
  console.log(`   message arrived while backgrounded: ${survived}`);

  const foreground = execFileSync(ADB, ['shell', 'dumpsys', 'activity', 'services', 'chat.linkline.app'], {
    stdio: 'pipe',
  }).toString();
  console.log(`   foreground service reported: ${/ConnectionService/.test(foreground)}`);

  view.close();
  await browser.close();
  await server.close();
}

main().catch((error) => {
  console.error('FAILED:', error.message);
  process.exit(1);
});
