/**
 * QR scanning, using the browser's own BarcodeDetector.
 *
 * Deliberately no decoder library: BarcodeDetector is a platform API (Chrome on
 * Android and desktop, Samsung Internet, Opera) and it is fast and battery
 * friendly. Safari ships it disabled by default, so where it is missing the UI
 * says so plainly and points at the system camera app, which reads QR codes
 * natively and opens the link — that path needs no support from us at all.
 */

import { extractCode } from './payload.js';

export function scannerCapability() {
  const hasDetector = typeof globalThis.BarcodeDetector === 'function';
  const hasCamera = typeof navigator !== 'undefined' && typeof navigator.mediaDevices?.getUserMedia === 'function';
  return {
    supported: hasDetector && hasCamera,
    hasDetector,
    hasCamera,
    explanation: hasDetector && hasCamera
      ? 'Point the camera at the other person’s QR code.'
      : hasDetector
        ? 'No camera is available here. Use the phone’s camera app to scan the code instead.'
        : 'This browser cannot scan codes itself. Your phone’s camera app can: point it at the code and it will open the invite.',
  };
}

let detectorPromise = null;

async function getDetector() {
  detectorPromise ??= (async () => {
    const formats = await globalThis.BarcodeDetector.getSupportedFormats();
    if (!formats.includes('qr_code')) throw new Error('this device cannot decode QR codes');
    return new globalThis.BarcodeDetector({ formats: ['qr_code'] });
  })();
  return detectorPromise;
}

/**
 * Open the camera and scan until a code appears.
 *
 * `deps` exists so the pipeline can be tested without a camera: pass
 * { detector, getUserMedia }.
 */
export async function startQrScan({ video, onCode, onError, deps = {} } = {}) {
  const getUserMedia = deps.getUserMedia ?? navigator.mediaDevices?.getUserMedia?.bind(navigator.mediaDevices);
  const detect = deps.detect ?? (async (source) => (await getDetector()).detect(source));

  if (!getUserMedia) throw new Error('this browser has no camera access');

  let stream;
  try {
    stream = await getUserMedia({ video: { facingMode: 'environment' }, audio: false });
  } catch (error) {
    throw new Error(
      error?.name === 'NotAllowedError'
        ? 'Camera permission was refused. Allow it, or paste the code instead.'
        : `Could not start the camera: ${error?.message ?? error}`,
    );
  }

  if (video) {
    video.srcObject = stream;
    video.setAttribute('playsinline', 'true');
    await video.play().catch(() => {});
  }

  let stopped = false;
  let timer = null;

  const stop = () => {
    if (stopped) return;
    stopped = true;
    clearTimeout(timer);
    for (const track of stream?.getTracks?.() ?? []) track.stop();
    if (video) video.srcObject = null;
  };

  const tick = async () => {
    if (stopped) return;
    try {
      const results = await detect(video ?? stream);
      for (const result of results ?? []) {
        const code = extractCode(result.rawValue ?? '');
        if (code) {
          stop();
          onCode?.(code, result);
          return;
        }
      }
    } catch (error) {
      // Transient detector failures (for example a frame with no image) are
      // normal; keep scanning. Anything else surfaces once and stops.
      if (!/no image|not enough|invalid state/i.test(String(error?.message ?? ''))) {
        stop();
        onError?.(error);
        return;
      }
    }
    timer = setTimeout(tick, 180);
  };

  timer = setTimeout(tick, 180);
  return { stop, stream };
}
