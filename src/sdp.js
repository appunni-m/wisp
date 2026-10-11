/**
 * SDP handling for serverless signaling.
 *
 * The trick that keeps invite links short: both peers run the same app, so the
 * *structure* of the session description is already known to both sides. We
 * therefore never transmit SDP text. Each side captures a real, browser-generated
 * skeleton once at startup, and the wire format carries only the fields that
 * genuinely differ per session:
 *
 *   session id, ice-ufrag, ice-pwd, DTLS fingerprint, setup role, candidates
 *
 * Everything else (codecs, m-line, BUNDLE group, SCTP port) is reproduced from
 * the local skeleton at decode time.
 */

/**
 * ICE servers.
 *
 * STUN only, by default: it is a lookup service, so no chat traffic passes
 * through anyone else's machine. That keeps the "no server" promise, at the cost
 * of the pairs that symmetric NAT and carrier-grade NAT make unreachable — which
 * is most of the ~10–20% failure rate on mobile networks.
 *
 * Add a TURN relay to close that gap. It is still end-to-end encrypted: TURN
 * forwards DTLS packets it cannot read. Configure it here, or at runtime with
 * `configureIceServers()` / the `?ice=` URL parameter.
 */
export const DEFAULT_ICE_SERVERS = [
  { urls: ['stun:stun.l.google.com:19302', 'stun:stun.cloudflare.com:3478'] },
];

let iceServers = DEFAULT_ICE_SERVERS;

export function configureIceServers(servers) {
  if (!Array.isArray(servers)) return currentIceServers();
  // An empty list is meaningful: it means host candidates only, which is what a
  // test on one machine needs and what `?ice=none` asks for.
  iceServers = servers;
  return iceServers;
}

export const currentIceServers = () => iceServers;

/**
 * Parse `?ice=` — a comma-separated list of STUN/TURN URLs, with optional
 * shared credentials: `?ice=turn:host:3478&iceUser=u&icePass=p`.
 */
export function iceServersFromParams(params) {
  const raw = params.get('ice');
  if (!raw) return null;
  // `?ice=none` means do not use any server: two peers on one machine can reach
  // each other on host candidates alone, without waiting for a STUN reply.
  if (raw.trim().toLowerCase() === 'none') return [];
  const urls = raw.split(',').map((value) => value.trim()).filter(Boolean);
  if (!urls.length) return null;
  const entry = { urls };
  const username = params.get('iceUser');
  const credential = params.get('icePass');
  if (username) entry.username = username;
  if (credential) entry.credential = credential;
  return [entry];
}

export const CANDIDATE_TYPE = { host: 0, srflx: 1, prflx: 2, relay: 3 };
export const CANDIDATE_TYPE_BY_ID = ['host', 'srflx', 'prflx', 'relay'];
export const ADDRESS_KIND = { ipv4: 0, ipv6: 1, hostname: 2 };
export const SETUP = { actpass: 0, active: 1, passive: 2 };
export const SETUP_BY_ID = ['actpass', 'active', 'passive'];

const IPV4 = /^\d{1,3}(?:\.\d{1,3}){3}$/;

export function classifyAddress(address) {
  if (IPV4.test(address)) return ADDRESS_KIND.ipv4;
  if (address.includes(':')) return ADDRESS_KIND.ipv6;
  return ADDRESS_KIND.hostname;
}

export function ipv4ToBytes(address) {
  const parts = address.split('.').map(Number);
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) {
    throw new Error(`not an IPv4 address: ${address}`);
  }
  return new Uint8Array(parts);
}

export function bytesToIpv4(bytes) {
  if (bytes.length !== 4) throw new Error('IPv4 needs 4 bytes');
  return Array.from(bytes).join('.');
}

export function ipv6ToBytes(address) {
  const [head, tail] = address.includes('::') ? address.split('::') : [address, null];
  const headParts = head ? head.split(':').filter(Boolean) : [];
  const tailParts = tail !== null && tail !== undefined ? tail.split(':').filter(Boolean) : [];
  if (tail === null || tail === undefined) {
    if (headParts.length !== 8) throw new Error(`not an IPv6 address: ${address}`);
  } else if (headParts.length + tailParts.length > 8) {
    throw new Error(`not an IPv6 address: ${address}`);
  }
  const expand = (parts) => {
    const out = [];
    for (const part of parts) {
      if (part.includes('.')) {
        const v4 = ipv4ToBytes(part);
        out.push((v4[0] << 8) | v4[1], (v4[2] << 8) | v4[3]);
      } else {
        out.push(parseInt(part, 16));
      }
    }
    return out;
  };
  const headWords = expand(headParts);
  const tailWords = expand(tailParts);
  const fill = 8 - headWords.length - tailWords.length;
  const words = tail === null || tail === undefined
    ? headWords
    : [...headWords, ...new Array(fill).fill(0), ...tailWords];
  const bytes = new Uint8Array(16);
  words.forEach((word, i) => {
    bytes[i * 2] = (word >> 8) & 0xff;
    bytes[i * 2 + 1] = word & 0xff;
  });
  return bytes;
}

export function bytesToIpv6(bytes) {
  if (bytes.length !== 16) throw new Error('IPv6 needs 16 bytes');
  const words = [];
  for (let i = 0; i < 16; i += 2) words.push((bytes[i] << 8) | bytes[i + 1]);
  // Longest run of zero words -> "::"
  let bestStart = -1;
  let bestLength = 0;
  let start = -1;
  for (let i = 0; i <= 8; i++) {
    if (i < 8 && words[i] === 0) {
      if (start < 0) start = i;
    } else if (start >= 0) {
      const length = i - start;
      if (length > bestLength) {
        bestLength = length;
        bestStart = start;
      }
      start = -1;
    }
  }
  if (bestLength < 2) return words.map((w) => w.toString(16)).join(':');
  const head = words.slice(0, bestStart).map((w) => w.toString(16)).join(':');
  const tail = words.slice(bestStart + bestLength).map((w) => w.toString(16)).join(':');
  return `${head}::${tail}`;
}

/**
 * ICE priorities are recomputed rather than transmitted: they only influence the
 * order candidate pairs are checked in, never correctness. The standard formula
 * from RFC 8445 §5.1.2.1 is reproduced here (type preference, local preference,
 * component).
 */
const TYPE_PREFERENCE = { host: 126, prflx: 110, srflx: 100, relay: 0 };

export function computePriority(type, component = 1) {
  const typePref = TYPE_PREFERENCE[type] ?? 0;
  const localPref = 65535;
  return ((typePref << 24) >>> 0) + (localPref << 8) + (256 - component);
}

/** Parse one `a=candidate:` line into its compact form. */
export function parseCandidateLine(line) {
  const match = /^a=candidate:(\S+)\s+(\d+)\s+(\S+)\s+(\d+)\s+(\S+)\s+(\d+)\s+typ\s+(\S+)/.exec(line.trim());
  if (!match) return null;
  const [, foundation, component, transport, priority, address, port, type] = match;
  if (!(type in CANDIDATE_TYPE)) return null;
  return {
    foundation,
    component: Number(component),
    transport: transport.toLowerCase(),
    priority: Number(priority),
    address,
    port: Number(port),
    type,
    addressKind: classifyAddress(address),
  };
}

export function formatCandidateLine(candidate) {
  const priority = candidate.priority ?? computePriority(candidate.type, candidate.component);
  const transport = candidate.transport ?? 'udp';
  const foundation = candidate.foundation ?? String(computePriority(candidate.type, candidate.component));
  return `a=candidate:${foundation} ${candidate.component} ${transport} ${priority} ${candidate.address} ${candidate.port} typ ${candidate.type}`;
}

/**
 * Pull the per-session fields out of a real session description produced by the
 * local browser.
 */
export function extractSdpFields(sdp) {
  const lines = String(sdp).split(/\r\n|\n/);
  const fields = { candidates: [] };
  for (const line of lines) {
    if (line.startsWith('o=')) {
      const parts = line.slice(2).split(/\s+/);
      fields.sessionId = parts[1];
    } else if (line.startsWith('a=ice-ufrag:')) {
      fields.ufrag ??= line.slice('a=ice-ufrag:'.length).trim();
    } else if (line.startsWith('a=ice-pwd:')) {
      fields.pwd ??= line.slice('a=ice-pwd:'.length).trim();
    } else if (line.startsWith('a=fingerprint:')) {
      const rest = line.slice('a=fingerprint:'.length).trim();
      const space = rest.indexOf(' ');
      const algo = space < 0 ? 'sha-256' : rest.slice(0, space);
      const value = space < 0 ? rest : rest.slice(space + 1);
      fields.fingerprint ??= { algo, value: value.trim() };
    } else if (line.startsWith('a=setup:')) {
      fields.setup ??= line.slice('a=setup:'.length).trim();
    } else if (line.startsWith('a=candidate:')) {
      const candidate = parseCandidateLine(line);
      if (candidate) fields.candidates.push(candidate);
    }
  }
  return fields;
}

/** Strip candidate/end-of-candidates lines so a skeleton can be re-populated. */
export function stripCandidates(sdp) {
  return String(sdp)
    .split(/\r\n|\n/)
    .filter((line) => !line.startsWith('a=candidate:') && line.trim() !== 'a=end-of-candidates')
    .join('\r\n');
}

/**
 * Rebuild a full session description from a local skeleton plus the fields that
 * arrived over the wire.
 */
export function buildSdpFromSkeleton(skeleton, fields) {
  const lines = stripCandidates(skeleton).split(/\r\n|\n/).filter((line) => line.length > 0);
  const out = [];
  let originDone = false;
  for (const line of lines) {
    if (line.startsWith('o=') && !originDone) {
      const parts = line.slice(2).split(/\s+/);
      parts[1] = String(fields.sessionId ?? parts[1]);
      parts[2] = '2';
      out.push(`o=${parts.join(' ')}`);
      originDone = true;
    } else if (line.startsWith('a=ice-ufrag:')) {
      out.push(`a=ice-ufrag:${fields.ufrag}`);
    } else if (line.startsWith('a=ice-pwd:')) {
      out.push(`a=ice-pwd:${fields.pwd}`);
    } else if (line.startsWith('a=fingerprint:')) {
      const algo = fields.fingerprint?.algo ?? 'sha-256';
      out.push(`a=fingerprint:${algo} ${fields.fingerprint?.value ?? ''}`);
    } else if (line.startsWith('a=setup:')) {
      out.push(`a=setup:${fields.setup ?? 'actpass'}`);
    } else {
      out.push(line);
    }
  }
  for (const candidate of fields.candidates ?? []) {
    out.push(formatCandidateLine(candidate));
  }
  return `${out.join('\r\n')}\r\n`;
}

/** Deduplicate candidates that differ only in the way they were gathered. */
export function dedupeCandidates(candidates) {
  const seen = new Set();
  const out = [];
  for (const candidate of candidates) {
    const key = `${candidate.type}|${candidate.component}|${candidate.address}|${candidate.port}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(candidate);
  }
  return out;
}

/** Capture the local browser's session-description skeleton (browser only). */
export async function captureSkeleton(iceServers = DEFAULT_ICE_SERVERS) {
  const pc = new RTCPeerConnection({ iceServers });
  try {
    pc.createDataChannel('skeleton');
    const offer = await pc.createOffer();
    return stripCandidates(offer.sdp);
  } finally {
    pc.close();
  }
}

/** Wait until ICE gathering finishes, or the timeout elapses. */
export function waitForIceGathering(pc, timeoutMs = 4000) {
  if (pc.iceGatheringState === 'complete') return Promise.resolve(true);
  return new Promise((resolve) => {
    let settled = false;
    const finish = (complete) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      pc.removeEventListener('icegatheringstatechange', onChange);
      resolve(complete);
    };
    const onChange = () => {
      if (pc.iceGatheringState === 'complete') finish(true);
    };
    const timer = setTimeout(() => finish(false), timeoutMs);
    pc.addEventListener('icegatheringstatechange', onChange);
  });
}

export function isPrivateAddress(address) {
  if (IPV4.test(address)) {
    const [a, b] = address.split('.').map(Number);
    return a === 10 || a === 127 || (a === 192 && b === 168) || (a === 172 && b >= 16 && b <= 31) || (a === 169 && b === 254);
  }
  if (address.includes(':')) return address.startsWith('fe80') || address === '::1' || address.startsWith('fc') || address.startsWith('fd');
  return true; // mDNS hostnames resolve only on the local link
}
