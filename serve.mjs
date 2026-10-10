/**
 * Zero-dependency static file server for local development and phone testing.
 *
 * This exists only to serve the app shell. It is NOT a signaling server: it
 * never sees an invite code, because invite payloads travel in the URL fragment,
 * which browsers do not transmit. Nothing here is needed at runtime either —
 * install the app once and it works offline from the service worker cache.
 *
 *   node serve.mjs                 # http://127.0.0.1:8080 (desktop only)
 *   node serve.mjs --lan           # also reachable from your phone on the LAN
 *   node serve.mjs --lan --https   # ...with TLS, which phones require
 *   node serve.mjs --lan --https --port 8443
 *
 * Why --https matters: browsers only expose `crypto.subtle` in a *secure
 * context*. Plain http:// on a LAN IP is not one, so the app cannot create an
 * identity key at all. Android can dodge this entirely with
 * `adb reverse tcp:8080 tcp:8080`, which makes the origin localhost on the
 * phone — a real secure context with no certificate warning.
 */

import { createServer } from 'node:http';
import { createServer as createSecureServer } from 'node:https';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { networkInterfaces } from 'node:os';
import { extname, join, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { encodeQr, qrToAnsi } from './src/qr.js';

const DEFAULT_ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)));
const CERT_DIR = resolve(DEFAULT_ROOT, '.devcert');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.map': 'application/json; charset=utf-8',
};

export async function createStaticServer({ root = DEFAULT_ROOT, port = 0, host = '127.0.0.1', tls = null } = {}) {
  // Normalize once: a caller-supplied root with a trailing slash would otherwise
  // produce a "//" prefix that no resolved path can match.
  const documentRoot = resolve(root);

  const handler = async (request, response) => {
    try {
      const url = new URL(request.url, `http://${request.headers.host ?? 'localhost'}`);
      let pathname = decodeURIComponent(url.pathname);
      if (pathname.endsWith('/')) pathname += 'index.html';
      const target = resolve(documentRoot, `.${pathname}`);
      if (target !== documentRoot && !target.startsWith(documentRoot + sep)) {
        response.writeHead(403).end('forbidden');
        return;
      }
      const body = await readFile(target);
      response.writeHead(200, {
        'content-type': MIME[extname(target).toLowerCase()] ?? 'application/octet-stream',
        'cache-control': 'no-store',
      });
      response.end(body);
    } catch {
      response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end('not found');
    }
  };

  const server = tls ? createSecureServer({ key: tls.key, cert: tls.cert }, handler) : createServer(handler);

  await new Promise((done, fail) => {
    server.once('error', fail);
    server.listen(port, host, done);
  });

  const { port: actualPort } = server.address();
  const scheme = tls ? 'https' : 'http';
  const displayHost = host === '0.0.0.0' || host === '::' ? firstLanAddress() ?? '127.0.0.1' : host;
  return {
    url: `${scheme}://${displayHost}:${actualPort}/`,
    localUrl: `${scheme}://127.0.0.1:${actualPort}/`,
    port: actualPort,
    tls: Boolean(tls),
    server,
    close: () => new Promise((done) => server.close(done)),
  };
}

export function firstLanAddress() {
  for (const addresses of Object.values(networkInterfaces())) {
    for (const address of addresses ?? []) {
      if (address.family === 'IPv4' && !address.internal) return address.address;
    }
  }
  return null;
}

/**
 * A self-signed certificate covering the LAN address.
 *
 * Browsers show a warning the first time; after you accept it, the origin counts
 * as a secure context and `crypto.subtle` becomes available. Generated once and
 * cached in .devcert/.
 */
export function ensureDevCertificate({ host }) {
  const keyPath = join(CERT_DIR, 'key.pem');
  const certPath = join(CERT_DIR, 'cert.pem');

  if (!existsSync(keyPath) || !existsSync(certPath)) {
    mkdirSync(CERT_DIR, { recursive: true });
    const subject = `/CN=${host}`;
    const altNames = `subjectAltName=DNS:localhost,IP:127.0.0.1,IP:${host}`;
    try {
      execFileSync(
        'openssl',
        [
          'req', '-x509', '-newkey', 'rsa:2048', '-nodes',
          '-keyout', keyPath, '-out', certPath,
          '-days', '30', '-subj', subject, '-addext', altNames,
        ],
        { stdio: 'pipe' },
      );
    } catch (error) {
      throw new Error(
        `could not generate a development certificate with openssl: ${error.message}\n` +
          'Install openssl, or use `adb reverse tcp:8080 tcp:8080` for an Android phone instead (no certificate needed).',
      );
    }
  }

  return { key: readFileSync(keyPath), cert: readFileSync(certPath) };
}

function printBanner({ url, localUrl, tls }) {
  const lan = firstLanAddress();
  console.log('\n  Wisp — private peer-to-peer chat\n');
  console.log(`  this computer:  ${localUrl}`);
  if (url !== localUrl) console.log(`  your phone:     ${url}`);

  console.log('\n  Open the URL above on the phone, then scan this to get there quickly:\n');
  try {
    console.log(qrToAnsi(encodeQr(url, { ecLevel: 'M' })));
  } catch {
    console.log('  (could not render a QR for this address)');
  }

  if (tls) {
    console.log('  The certificate is self-signed, so the phone will warn once:');
    console.log('  choose “Advanced” → “Proceed”. After that the origin is a secure');
    console.log('  context and the app can create its identity key.\n');
    console.log('  Android alternative with no warning at all:');
    console.log('    adb reverse tcp:8080 tcp:8080   then open http://localhost:8080\n');
  } else if (url !== localUrl) {
    console.log('  Note: plain http on a LAN address is NOT a secure context, so the app');
    console.log('  cannot create identity keys there. Re-run with --https, or use');
    console.log('  `adb reverse tcp:8080 tcp:8080` (Android) and open http://localhost:8080\n');
  }

  console.log('  Test it: open the URL in two places, create an invite in one, then');
  console.log('  scan or paste it into the other.\n');
  if (lan) console.log(`  (serving to the local network at ${lan})\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  const wantLan = args.includes('--lan');
  const wantHttps = args.includes('--https');
  const portIndex = args.indexOf('--port');
  const port = Number(portIndex >= 0 ? args[portIndex + 1] : process.env.PORT ?? 8080);

  const host = wantLan ? '0.0.0.0' : '127.0.0.1';
  const lanAddress = firstLanAddress();

  let tls = null;
  if (wantHttps) {
    if (!lanAddress) console.warn('  warning: no LAN address found; the certificate covers localhost only.');
    tls = ensureDevCertificate({ host: lanAddress ?? '127.0.0.1' });
  }

  const { url, localUrl } = await createStaticServer({ port, host, tls });
  printBanner({ url, localUrl, tls });
}
