/**
 * Voice and video calls over the link that already exists.
 *
 * There is no signalling server to set up a call with, and there does not need
 * to be: the data channel *is* the signalling channel. Adding media means
 * renegotiating the peer connection, and the SDP for that travels as ordinary
 * messages over the connection the two peers already share.
 *
 * Only the caller ever offers. The callee answers, and adds its own tracks onto
 * the transceivers the offer already created. One exchange, no glare, no perfect
 * negotiation machinery — because a call here always starts one way.
 *
 * The interesting part is what happens afterwards. A phone on a train has a
 * connection that changes every few seconds, so the call watches its own stats
 * and moves between quality profiles: bitrate, resolution and frame rate come
 * down before the call breaks up, and if it gets bad enough the video is dropped
 * to keep the voice intelligible.
 */

export const CALL = {
  /** "I would like to call you" — rings before any media is touched. */
  INVITE: 'call-invite',
  RINGING: 'call-ringing',
  ACCEPT: 'call-accept',
  DECLINE: 'call-decline',
  /** Renegotiation, riding the open data channel. */
  OFFER: 'call-offer',
  ANSWER: 'call-answer',
  ICE: 'call-ice',
  END: 'call-end',
  /** Mute and camera state, so the other side can say "camera off". */
  STATE: 'call-state',
};

export const QUALITY = {
  GOOD: 'good',
  FAIR: 'fair',
  POOR: 'poor',
  BAD: 'bad',
};

/**
 * What each tier means in practice. The numbers are deliberately conservative:
 * a call that stays intelligible at 24 kbps is worth more than one that looks
 * sharp for ten seconds and then falls apart.
 */
export const QUALITY_PROFILES = {
  [QUALITY.GOOD]: {
    label: 'Good connection',
    video: true,
    videoBitrate: 1_500_000,
    audioBitrate: 40_000,
    scale: 1,
    maxFps: 30,
  },
  [QUALITY.FAIR]: {
    label: 'Fair connection',
    video: true,
    videoBitrate: 700_000,
    audioBitrate: 32_000,
    scale: 2,
    maxFps: 24,
  },
  [QUALITY.POOR]: {
    label: 'Poor connection',
    video: true,
    videoBitrate: 220_000,
    audioBitrate: 24_000,
    scale: 4,
    maxFps: 15,
  },
  [QUALITY.BAD]: {
    label: 'Audio only — the connection cannot carry video',
    video: false,
    videoBitrate: 0,
    audioBitrate: 20_000,
    scale: 4,
    maxFps: 10,
  },
};

/** Thresholds, loosest first, so the first match wins. */
const TIERS = [
  { tier: QUALITY.BAD, loss: 0.1, rtt: 1.0, jitter: 0.12, bitrate: 120_000 },
  { tier: QUALITY.POOR, loss: 0.05, rtt: 0.4, jitter: 0.06, bitrate: 350_000 },
  { tier: QUALITY.FAIR, loss: 0.02, rtt: 0.15, jitter: 0.025, bitrate: 900_000 },
];

/**
 * What the numbers say about the connection. Pure on purpose: the policy is the
 * part worth testing, and it can be tested without a network at all.
 *
 * `availableOutgoingBitrate` is used when the browser reports it, because it is
 * a direct measurement of what the link will take rather than a symptom.
 */
export function decideQuality({
  lossRate = 0,
  roundTripTime = 0,
  jitter = 0,
  availableOutgoingBitrate = null,
} = {}) {
  for (const step of TIERS) {
    if (lossRate > step.loss || roundTripTime > step.rtt || jitter > step.jitter) {
      return step.tier;
    }
    if (availableOutgoingBitrate !== null && availableOutgoingBitrate > 0 && availableOutgoingBitrate < step.bitrate) {
      return step.tier;
    }
  }
  return QUALITY.GOOD;
}

const ORDER = [QUALITY.BAD, QUALITY.POOR, QUALITY.FAIR, QUALITY.GOOD];
const rank = (tier) => ORDER.indexOf(tier);

/**
 * Keeps the tier from flapping.
 *
 * One bad sample is normal — a phone changing cells, a microwave, a lift. Two in
 * a row is a trend. Dropping quality happens on the first sign because a
 * stuttering call is worse than a soft one; climbing back up takes three calm
 * samples, because recovering and immediately dropping again is worse than
 * simply waiting.
 */
export class QualityGovernor {
  #tier;
  #candidate = null;
  #streak = 0;

  constructor({ initial = QUALITY.GOOD, dropAfter = 1, riseAfter = 3 } = {}) {
    this.#tier = initial;
    this.dropAfter = dropAfter;
    this.riseAfter = riseAfter;
  }

  get tier() {
    return this.#tier;
  }

  /** Feed one sample; returns the new tier, which may be unchanged. */
  sample(reading) {
    const next = decideQuality(reading);
    if (next === this.#tier) {
      this.#candidate = null;
      this.#streak = 0;
      return this.#tier;
    }

    if (this.#candidate !== next) {
      this.#candidate = next;
      this.#streak = 1;
    } else {
      this.#streak += 1;
    }

    const falling = rank(next) < rank(this.#tier);
    const needed = falling ? this.dropAfter : this.riseAfter;
    if (this.#streak >= needed) {
      this.#tier = next;
      this.#candidate = null;
      this.#streak = 0;
    }
    return this.#tier;
  }
}

/** Read the numbers that matter out of a stats report. */
export function summariseStats(report) {
  let packetsLost = 0;
  let packetsReceived = 0;
  let roundTripTime = 0;
  let jitter = 0;
  let availableOutgoingBitrate = null;

  report.forEach((entry) => {
    if (entry.type === 'inbound-rtp' && !entry.isRemote) {
      packetsLost += entry.packetsLost ?? 0;
      packetsReceived += entry.packetsReceived ?? 0;
      jitter = Math.max(jitter, entry.jitter ?? 0);
    }
    if (entry.type === 'remote-inbound-rtp') {
      packetsLost += entry.packetsLost ?? 0;
      packetsReceived += entry.packetsReceived ?? 0;
      if (typeof entry.roundTripTime === 'number') {
        roundTripTime = Math.max(roundTripTime, entry.roundTripTime);
      }
      jitter = Math.max(jitter, entry.jitter ?? 0);
    }
    if (entry.type === 'candidate-pair' && entry.state === 'succeeded' && entry.nominated) {
      if (typeof entry.currentRoundTripTime === 'number') {
        roundTripTime = Math.max(roundTripTime, entry.currentRoundTripTime);
      }
      if (typeof entry.availableOutgoingBitrate === 'number') {
        availableOutgoingBitrate = entry.availableOutgoingBitrate;
      }
    }
  });

  const total = packetsLost + packetsReceived;
  return {
    lossRate: total > 0 ? Math.max(0, packetsLost) / total : 0,
    roundTripTime,
    jitter,
    availableOutgoingBitrate,
  };
}

/**
 * Audio preferences that matter more than they look.
 *
 * `useinbandfec` spends a little bandwidth on redundancy so a lost packet can be
 * reconstructed instead of heard as a click, and `usedtx` stops sending during
 * silence, which on a phone is most of the time.
 */
export function tuneOpus(sdp) {
  const rtpmap = sdp.match(/a=rtpmap:(\d+) opus\/48000\/2/i);
  if (!rtpmap) return sdp;
  const payloadType = rtpmap[1];
  const fmtp = new RegExp(`a=fmtp:${payloadType} ([^\\r\\n]*)`, 'i');
  const existing = sdp.match(fmtp);

  if (!existing) {
    // No parameters at all: put a line in after the rtpmap that declared it.
    return sdp.replace(
      new RegExp(`(a=rtpmap:${payloadType} opus\\/48000\\/2\\r?\\n)`, 'i'),
      `$1a=fmtp:${payloadType} minptime=10;useinbandfec=1;usedtx=1\r\n`,
    );
  }

  // Keep whatever the browser set, and make sure the two that matter are on.
  const parts = new Map(
    existing[1]
      .split(';')
      .map((piece) => piece.trim())
      .filter(Boolean)
      .map((piece) => {
        const [key, ...rest] = piece.split('=');
        return [key, rest.join('=')];
      }),
  );
  parts.set('useinbandfec', '1');
  parts.set('usedtx', '1');
  const rebuilt = [...parts].map(([key, value]) => (value === '' ? key : `${key}=${value}`)).join(';');
  return sdp.replace(existing[0], `a=fmtp:${payloadType} ${rebuilt}`);
}

/** Prefer the codecs that compress best, without excluding the safe fallbacks. */
export function preferCodecs(transceiver, kind) {
  if (typeof RTCRtpSender === 'undefined' || !RTCRtpSender.getCapabilities) return;
  const capabilities = RTCRtpSender.getCapabilities(kind);
  if (!capabilities?.codecs?.length) return;

  const wanted = kind === 'video' ? ['video/VP9', 'video/AV1', 'video/VP8', 'video/H264'] : ['audio/opus'];
  const ranked = [...capabilities.codecs].sort((a, b) => {
    const index = (codec) => {
      const at = wanted.indexOf(codec.mimeType);
      return at === -1 ? wanted.length : at;
    };
    return index(a) - index(b);
  });

  try {
    transceiver.setCodecPreferences?.(ranked);
  } catch {
    // A browser that dislikes the list keeps its own order, which is fine.
  }
}

/**
 * A call in progress.
 *
 * Owns the media, the renegotiation, and the loop that watches the connection.
 * It is handed the peer connection rather than creating one, because the call
 * shares the connection the chat is already using.
 */
export class CallSession {
  #pc;
  #send;
  #governor;
  #timer = null;
  #closed = false;
  #applied = null;
  #stats = { packetsLost: 0, packetsReceived: 0 };

  constructor({ pc, send, role = 'caller', video = false, onEvent = () => {} } = {}) {
    this.#pc = pc;
    this.#send = send;
    this.role = role;
    this.wantsVideo = video;
    this.onEvent = onEvent;
    this.localStream = null;
    this.remoteStream = null;
    this.muted = false;
    this.cameraOn = video;
    this.startedAt = null;
    this.#governor = new QualityGovernor();
  }

  get tier() {
    return this.#governor.tier;
  }

  get profile() {
    return QUALITY_PROFILES[this.tier];
  }

  get pc() {
    return this.#pc;
  }

  #emit(type, detail = {}) {
    this.onEvent({ type, ...detail, call: this });
  }

  /** The track kinds already on the connection, so a re-call reuses them. */
  #senders(kind) {
    return this.#pc.getSenders().filter((sender) => sender.track?.kind === kind);
  }

  /** Open the microphone and camera. Throws with a readable reason. */
  async openMedia({ video = this.wantsVideo } = {}) {
    if (!navigator.mediaDevices?.getUserMedia) {
      throw new Error('This browser cannot use the microphone or camera.');
    }
    const constraints = {
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      // 640x480 at 24 fps is plenty once compression is applied, and asking for
      // more than that is what makes a phone hot and a uplink saturate.
      video: video ? { width: { ideal: 640 }, height: { ideal: 480 }, frameRate: { ideal: 24, max: 30 } } : false,
    };
    try {
      this.localStream = await navigator.mediaDevices.getUserMedia(constraints);
    } catch (error) {
      const reason = error?.name === 'NotAllowedError'
        ? 'Permission to use the microphone or camera was refused.'
        : error?.name === 'NotFoundError'
          ? 'No microphone or camera was found on this device.'
          : `Could not open the microphone or camera: ${error?.message ?? error}`;
      throw new Error(reason);
    }
    return this.localStream;
  }

  /** Attach the local media and produce the offer that starts renegotiation. */
  async createOffer() {
    this.#attachLocal();
    const offer = await this.#pc.createOffer();
    await this.#pc.setLocalDescription({ type: 'offer', sdp: tuneOpus(offer.sdp) });
    this.#apply(this.profile, { force: true });
    this.#emit('offer', { sdp: this.#pc.localDescription.sdp });
    return this.#pc.localDescription.sdp;
  }

  async acceptOffer(sdp) {
    await this.#pc.setRemoteDescription({ type: 'offer', sdp });
    // The offer created the transceivers; adding tracks here reuses them, so the
    // answer carries our media without a second round of negotiation.
    this.#attachLocal();
    const answer = await this.#pc.createAnswer();
    await this.#pc.setLocalDescription({ type: 'answer', sdp: tuneOpus(answer.sdp) });
    this.#apply(this.profile, { force: true });
    this.#emit('answer', { sdp: this.#pc.localDescription.sdp });
    return this.#pc.localDescription.sdp;
  }

  async acceptAnswer(sdp) {
    await this.#pc.setRemoteDescription({ type: 'answer', sdp });
  }

  async addIce(candidate) {
    try {
      await this.#pc.addIceCandidate(candidate);
    } catch {
      // A candidate arriving after the connection settled is not a problem.
    }
  }

  #attachLocal() {
    if (!this.localStream) return;
    for (const track of this.localStream.getTracks()) {
      const existing = this.#pc
        .getTransceivers()
        .find((t) => t.receiver.track?.kind === track.kind || t.sender.track?.kind === track.kind);
      if (existing && !existing.sender.track) {
        existing.sender.replaceTrack(track);
        existing.direction = 'sendrecv';
      } else if (!existing) {
        const transceiver = this.#pc.addTransceiver(track, { streams: [this.localStream], direction: 'sendrecv' });
        preferCodecs(transceiver, track.kind);
      }
    }
  }

  /** Start the clock, now that media is flowing. */
  markConnected() {
    if (this.startedAt) return;
    this.startedAt = Date.now();
    this.#emit('connected', { at: this.startedAt });
    this.#loop();
  }

  #loop() {
    clearInterval(this.#timer);
    this.#timer = setInterval(() => this.#sample().catch(() => {}), 2000);
  }

  async #sample() {
    if (this.#closed) return;
    const report = await this.#pc.getStats();
    const reading = summariseStats(report);
    const before = this.tier;
    const after = this.#governor.sample(reading);
    this.#emit('stats', { reading, tier: after });
    if (after !== before) {
      this.#emit('quality', { tier: after, profile: QUALITY_PROFILES[after] });
    }
    this.#apply(QUALITY_PROFILES[after]);
  }

  /**
   * Push a profile onto the senders. Called on every sample, but only does work
   * when something actually changed — `setParameters` is not free.
   */
  #apply(profile, { force = false } = {}) {
    const key = `${profile.videoBitrate}:${profile.audioBitrate}:${profile.scale}:${profile.maxFps}`;
    if (!force && key === this.#applied) return;
    this.#applied = key;

    for (const sender of this.#pc.getSenders()) {
      const kind = sender.track?.kind;
      if (!kind) continue;
      const params = sender.getParameters();
      if (!params.encodings?.length) params.encodings = [{}];
      const encoding = params.encodings[0];
      encoding.maxBitrate = kind === 'video' ? profile.videoBitrate : profile.audioBitrate;
      if (kind === 'video') {
        encoding.scaleResolutionDownBy = profile.scale;
        encoding.maxFramerate = profile.maxFps;
      }
      sender.setParameters(params).catch(() => {});
    }

    for (const transceiver of this.#pc.getTransceivers()) {
      if (transceiver.sender.track?.kind !== 'video') continue;
      // Dropping frames rather than resolution is what keeps a face readable.
      try {
        transceiver.degradationPreference = 'balanced';
      } catch {
        /* not supported, fine */
      }
    }

    // Video off is the last resort, and it is a real switch, not a bitrate of zero.
    if (!profile.video && this.cameraOn) this.setCameraEnabled(false, { silent: true });
  }

  setMuted(muted, { silent = false } = {}) {
    this.muted = muted;
    for (const track of this.localStream?.getAudioTracks() ?? []) track.enabled = !muted;
    this.#emit('state', { muted, cameraOn: this.cameraOn });
    if (!silent) this.#sendState();
    return muted;
  }

  setCameraEnabled(on, { silent = false } = {}) {
    this.cameraOn = on;
    for (const track of this.localStream?.getVideoTracks() ?? []) track.enabled = on;
    this.#emit('state', { muted: this.muted, cameraOn: on });
    if (!silent) this.#sendState();
    return on;
  }

  #sendState() {
    this.#send?.({ t: CALL.STATE, muted: this.muted, cameraOn: this.cameraOn });
  }

  /** Seconds since the call connected. */
  get duration() {
    return this.startedAt ? Math.floor((Date.now() - this.startedAt) / 1000) : 0;
  }

  close(reason = 'ended') {
    if (this.#closed) return;
    this.#closed = true;
    clearInterval(this.#timer);
    for (const track of this.localStream?.getTracks() ?? []) track.stop();
    // The tracks are stopped; the transceivers stay so the chat connection is
    // untouched and a second call needs no further negotiation.
    for (const sender of this.#pc.getSenders()) {
      try {
        if (sender.track) sender.replaceTrack(null);
      } catch {
        /* the connection may already be gone */
      }
    }
    this.localStream = null;
    this.remoteStream = null;
    this.#emit('ended', { reason, duration: this.duration });
  }

  get closed() {
    return this.#closed;
  }
}
