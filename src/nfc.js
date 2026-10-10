/**
 * NFC pairing, on two different backends.
 *
 * The important design decision: what gets written to a tag is a **URL record**,
 * not a text blob. That means the tag works for everyone, including people who do
 * not have this app:
 *
 *   - iPhone (7 and later) reads NDEF URL tags in the background, with no app,
 *     and offers a notification that opens the link.
 *   - Android hands the URL straight to the browser or the installed app.
 *
 * Two backends, because neither covers everything:
 *
 *   - **Web NFC** (`NDEFReader`) — Chrome on Android, in the browser. Absent in a
 *     WebView, so it cannot serve the native app.
 *   - **The native plugin** — used when running inside the Capacitor app. It also
 *     provides the foreground service that keeps a connection alive.
 *
 * Phone-to-phone NFC tapping is not possible from either: it would need host card
 * emulation or NDEF push, which no browser exposes. A physical tag is required.
 */

export const NFC_TAG_HINTS = {
  tooSmall:
    'That tag is too small for an invite link. Use an NTAG215 or larger (504 bytes of user memory); an NTAG213 only holds 144.',
  notFormatted: 'That tag is not NDEF-formatted, so it cannot be written.',
  removed: 'The tag was moved away too early. Hold the phone still against it for a moment.',
  denied: 'NFC permission was refused. Allow it and try again.',
  readOnly: 'That tag is read-only.',
  off: 'NFC is switched off. Turn it on in Settings, then try again.',
  unsupportedBrowser:
    'This browser cannot write NFC tags. Web NFC exists only in Chrome on Android. On iPhone, read a tag by tapping it — iOS opens the link without any app.',
};

/** The Capacitor plugin, present only inside the native app. */
function native() {
  return globalThis.Capacitor?.Plugins?.Wisp ?? null;
}

export const isNativeApp = () => native() !== null;

/**
 * Ask the native side what the hardware can actually do.
 *
 * The plugin existing is not the same as the device having an NFC radio: plenty
 * of phones (and every emulator image) do not. Offering a "write tag" button on
 * those is a dead end, so the answer is cached and used by `nfcCapability()`.
 */
let nativeStatus = null;

export async function probeNativeSupport() {
  const plugin = native();
  if (!plugin) return null;
  try {
    nativeStatus = await plugin.status();
  } catch {
    nativeStatus = { nfc: false, nfcEnabled: false, keepAlive: false, background: false };
  }
  return nativeStatus;
}

export const nativeSupport = () => nativeStatus;

/** What this environment can actually do with NFC. */
export function nfcCapability() {
  const plugin = native();
  const hasWebNfc = typeof globalThis.NDEFReader === 'function';
  // A WebView happily exposes `NDEFReader` on a device with no NFC radio, so
  // where the native plugin is present its hardware answer is authoritative.
  const noRadio = Boolean(plugin) && nativeStatus?.nfc === false;
  const supported = plugin && nativeStatus ? nativeStatus.nfc === true : hasWebNfc;

  return {
    supported,
    native: Boolean(plugin),
    hasWebNfc,
    canWrite: supported,
    canRead: supported,
    // Receiving always works, on any phone, because the OS handles it.
    canReceiveByTap: true,
    // A foreground service keeps the connection alive when the app is hidden.
    canRunInBackground: Boolean(plugin) && nativeStatus?.background === true,
    explanation: supported
      ? 'Hold the phone against an NFC tag.'
      : noRadio
        ? 'This device has no NFC reader, so tags cannot be used here. Links, QR codes and typing the code all still work.'
        : 'Reading tags works on any phone without this app: the tag holds a link, and the system offers to open it. Writing a tag needs Chrome on Android or the installed app.',
  };
}

function describeError(error) {
  const message = String(error?.message ?? error ?? '');
  if (message.includes('TAG_TOO_SMALL')) return NFC_TAG_HINTS.tooSmall;
  if (message.includes('read-only')) return NFC_TAG_HINTS.readOnly;
  if (message.includes('switched off')) return NFC_TAG_HINTS.off;
  const name = error?.name ?? '';
  if (name === 'NotAllowedError') return NFC_TAG_HINTS.denied;
  if (name === 'NotSupportedError') return NFC_TAG_HINTS.unsupportedBrowser;
  if (name === 'NotReadableError') return NFC_TAG_HINTS.notFormatted;
  if (name === 'NetworkError') return NFC_TAG_HINTS.removed;
  if (name === 'AbortError') return 'NFC was cancelled.';
  if (/capacity|size|too (long|large)/i.test(message)) return NFC_TAG_HINTS.tooSmall;
  return message || 'NFC failed for an unknown reason.';
}

export class NfcError extends Error {
  constructor(message, cause) {
    super(message);
    this.name = 'NfcError';
    this.cause = cause;
  }
}

/** Write an invite link to a tag. Must be called from a user gesture. */
export async function writeInviteToTag(url) {
  const plugin = native();
  if (plugin) {
    try {
      await plugin.nfcWrite({ url });
      return { ok: true, url, backend: 'native' };
    } catch (error) {
      throw new NfcError(describeError(error), error);
    }
  }

  if (typeof globalThis.NDEFReader !== 'function') {
    throw new NfcError(NFC_TAG_HINTS.unsupportedBrowser);
  }
  const writer = new globalThis.NDEFReader();
  try {
    await writer.write({ records: [{ recordType: 'url', data: url }] });
    return { ok: true, url, backend: 'web' };
  } catch (error) {
    throw new NfcError(describeError(error), error);
  }
}

/** Parse an NDEF reading event down to an invite code, if there is one. */
export function inviteCodeFromNdef(event) {
  for (const record of event?.message?.records ?? []) {
    let value = null;
    if (record.recordType === 'url' || record.recordType === 'absolute-url') {
      value = typeof record.data === 'string' ? record.data : new TextDecoder().decode(record.data);
    } else if (record.recordType === 'text') {
      value = new TextDecoder(record.encoding ?? 'utf-8').decode(record.data);
    }
    if (!value) continue;
    const match = /P2P1[zr]-[A-Za-z0-9_-]+/.exec(value);
    if (match) return match[0];
  }
  return null;
}

export function inviteCodeFromUrl(url) {
  if (!url) return null;
  const match = /P2P1[zr]-[A-Za-z0-9_-]+/.exec(String(url));
  return match ? match[0] : null;
}

/**
 * Listen for a tag. Returns a stop function. Reading a tag written by anyone —
 * including a stranger's business card — lands here.
 */
export async function scanForInvite({ onCode, onError } = {}) {
  const plugin = native();
  if (plugin) {
    const handle = await plugin.addListener('nfcTag', (event) => {
      const code = inviteCodeFromUrl(event?.url);
      if (code) onCode?.(code, event);
      else onError?.(new NfcError('That tag does not contain an invite.'));
    });
    try {
      await plugin.nfcScan();
    } catch (error) {
      await handle.remove();
      throw new NfcError(describeError(error), error);
    }
    return () => {
      handle.remove();
      plugin.nfcStop().catch(() => {});
    };
  }

  if (typeof globalThis.NDEFReader !== 'function') {
    throw new NfcError(NFC_TAG_HINTS.unsupportedBrowser);
  }
  const reader = new globalThis.NDEFReader();
  const controller = new AbortController();

  reader.addEventListener('reading', (event) => {
    const code = inviteCodeFromNdef(event);
    if (code) onCode?.(code, event);
    else onError?.(new NfcError('That tag does not contain an invite.'));
  });
  reader.addEventListener('readingerror', () => {
    onError?.(new NfcError('Could not read that tag. Try holding the phone against it again.'));
  });

  try {
    await reader.scan({ signal: controller.signal });
  } catch (error) {
    throw new NfcError(describeError(error), error);
  }

  return () => controller.abort();
}

/* ------------------------------------------------------------ native extras */

/**
 * Hold the process open so an open connection survives the app being hidden.
 * Native only — a browser tab cannot do this, which is the main reason to
 * install the app at all.
 */
export async function keepAlive(enabled, text) {
  const plugin = native();
  if (!plugin) return false;
  try {
    await plugin.keepAlive({ enabled, text });
    return true;
  } catch {
    return false;
  }
}

/** Ask for notification permission, needed before the service can be shown. */
export async function requestNotificationPermission() {
  if (typeof Notification === 'undefined') return 'unsupported';
  if (Notification.permission === 'granted' || Notification.permission === 'denied') return Notification.permission;
  try {
    return await Notification.requestPermission();
  } catch {
    return 'unsupported';
  }
}

/**
 * Invite links that opened or arrived at the app, e.g. `wisp://pair#i=...`.
 * The code is verified like any other, so this is a convenience, not a trust
 * boundary.
 */
export async function subscribeToAppUrls(handler) {
  const plugin = native();
  if (!plugin) return () => {};

  const handle = await plugin.addListener('appUrl', (event) => {
    const code = inviteCodeFromUrl(event?.url);
    if (code) handler(code, event.url);
  });

  try {
    const launch = await plugin.getLaunchUrl();
    const code = inviteCodeFromUrl(launch?.url);
    if (code) setTimeout(() => handler(code, launch.url), 0);
  } catch {
    // no launch URL
  }

  return () => handle.remove();
}
