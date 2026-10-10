/**
 * A minimal Chrome DevTools Protocol client for the Android WebView.
 *
 * Playwright's `connectOverCDP` refuses a WebView endpoint — it insists on
 * browser-level context management that WebView does not implement. Talking
 * straight to the page target over the built-in WebSocket is both smaller and
 * more reliable, and it lets the tests drive the real app on a real Android
 * runtime instead of a desktop imitation of one.
 *
 * Setup (the caller usually does this):
 *   adb forward tcp:9222 localabstract:webview_devtools_remote_<pid>
 */

const DEFAULT_PORT = 9222;

export async function listTargets({ port = DEFAULT_PORT, timeoutMs = 3000 } = {}) {
  // A stale `adb forward` leaves a socket that accepts but never answers, so an
  // unbounded fetch would hang for minutes instead of failing.
  const response = await fetch(`http://127.0.0.1:${port}/json/list`, {
    signal: AbortSignal.timeout(timeoutMs),
  });
  return response.json();
}

export async function connectWebView({ port = DEFAULT_PORT, match = 'localhost', timeoutMs = 20000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let target = null;
  while (Date.now() < deadline) {
    try {
      const targets = await listTargets({ port });
      target = targets.find((entry) => entry.type === 'page' && entry.url.includes(match));
      if (target?.webSocketDebuggerUrl) break;
    } catch {
      // the forward may not be up yet
    }
    await new Promise((done) => setTimeout(done, 500));
  }
  if (!target?.webSocketDebuggerUrl) {
    throw new Error(`no WebView page matching "${match}" on port ${port}; is the app running and forwarded?`);
  }

  const socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true });
    socket.addEventListener('error', () => reject(new Error('could not open the devtools socket')), { once: true });
  });

  let nextId = 1;
  const pending = new Map();
  socket.addEventListener('message', (event) => {
    let message;
    try {
      message = JSON.parse(event.data);
    } catch {
      return;
    }
    const handler = pending.get(message.id);
    if (handler) {
      pending.delete(message.id);
      handler(message);
    }
  });

  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const id = nextId++;
      pending.set(id, (message) => {
        if (message.error) reject(new Error(`${method}: ${message.error.message}`));
        else resolve(message.result);
      });
      socket.send(JSON.stringify({ id, method, params }));
    });

  const api = {
    target,

    /** Evaluate an expression in the page and return its value. */
    async evaluate(expression) {
      const result = await send('Runtime.evaluate', {
        expression,
        awaitPromise: true,
        returnByValue: true,
      });
      if (result.exceptionDetails) {
        const detail = result.exceptionDetails.exception?.description ?? result.exceptionDetails.text;
        throw new Error(`evaluate failed: ${detail}`);
      }
      return result.result.value;
    },

    /** Screenshot the WebView itself, as base64 PNG. */
    async screenshot() {
      const result = await send('Page.captureScreenshot', { format: 'png' });
      return result.data;
    },

    send,
    close: () => socket.close(),
  };

  // The app sets window.__p2p at the end of module evaluation; wait for it so
  // callers never race the boot sequence.
  await api.evaluate('window.__p2p ? window.__p2p.ready.then(() => true) : false');

  return api;
}
