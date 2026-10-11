/**
 * A single direct link between two peers.
 *
 * Deliberately transport-agnostic about *how* codes travel between the two
 * humans (WhatsApp, SMS, QR code, carrier pigeon). This class only knows how to
 * produce a code, consume the other side's code, and hand back a live
 * RTCDataChannel.
 */

import {
  currentIceServers,
  captureSkeleton,
  waitForIceGathering,
  extractSdpFields,
  buildSdpFromSkeleton,
  dedupeCandidates,
  parseCandidateLine,
} from './sdp.js';
import { KIND, sealInvite, openInvite } from './payload.js';
import { shortAuthString } from './crypto.js';
import { bytesToHex } from './codec.js';

/** Captured once per page load: the browser's own idea of a valid session description. */
let skeletonPromise = null;
export function localSkeleton(iceServers = currentIceServers()) {
  skeletonPromise ??= captureSkeleton(iceServers);
  return skeletonPromise;
}

export const LINK_STATE = {
  IDLE: 'idle',
  OFFER_READY: 'offer-ready',
  ANSWER_READY: 'answer-ready',
  CONNECTING: 'connecting',
  OPEN: 'open',
  CLOSED: 'closed',
  FAILED: 'failed',
};

const CONNECT_TIMEOUT_MS = 30000;

export class PairingSession extends EventTarget {
  #pc = null;
  #channel = null;
  #gathered = [];
  #identity;
  #iceServers;
  #timeout = null;

  localInvite = null;
  peerInvite = null;
  peerVerified = false;
  sas = null;
  state = LINK_STATE.IDLE;
  lastError = null;

  constructor({ identity, iceServers = currentIceServers(), roomId, groupLabel } = {}) {
    super();
    this.#identity = identity;
    this.#iceServers = iceServers;
    // Room membership is a property of the session, not of the identity object,
    // so mesh links created on the fly still advertise the right room.
    this.roomId = String(roomId ?? identity?.roomId ?? '0');
    this.groupLabel = groupLabel ?? identity?.groupLabel ?? '';
  }

  /** Exposed so a call can renegotiate the connection the chat already uses. */
  get peerConnection() {
    return this.#pc;
  }

  get channel() {
    return this.#channel;
  }

  /** The signing identity this session speaks with (needed to build mesh links). */
  get identity() {
    return this.#identity;
  }

  get fingerprint() {
    return this.localInvite?.fingerprint ?? null;
  }

  #emit(type, detail) {
    this.dispatchEvent(new CustomEvent(type, { detail }));
  }

  #setState(state) {
    this.state = state;
    this.#emit('statechange', { state });
  }

  #createPeerConnection() {
    const pc = new RTCPeerConnection({ iceServers: this.#iceServers });
    this.#gathered = [];
    pc.addEventListener('icecandidate', (event) => {
      if (!event.candidate) return;
      const parsed = parseCandidateLine(`a=${event.candidate.candidate}`);
      if (parsed) this.#gathered.push(parsed);
    });
    pc.addEventListener('connectionstatechange', () => {
      this.#emit('connectionstate', { connectionState: pc.connectionState });
      if (pc.connectionState === 'connected') {
        clearTimeout(this.#timeout);
        this.#setState(LINK_STATE.OPEN);
      } else if (pc.connectionState === 'failed') {
        this.#fail(
          'Direct connection failed. Both networks are probably behind symmetric NAT or carrier-grade NAT, which needs a TURN relay — STUN alone cannot traverse it.',
        );
      } else if (pc.connectionState === 'closed') {
        this.#setState(LINK_STATE.CLOSED);
      }
    });
    pc.addEventListener('iceconnectionstatechange', () => {
      this.#emit('iceconnectionstate', { iceConnectionState: pc.iceConnectionState });
    });
    this.#pc = pc;
    this.#armTimeout();
    return pc;
  }

  #armTimeout() {
    clearTimeout(this.#timeout);
    this.#timeout = setTimeout(() => {
      if (this.state !== LINK_STATE.OPEN) {
        this.#fail('Timed out waiting for the peer to connect. Check that the reply code was pasted into the tab that created the invite.');
      }
    }, CONNECT_TIMEOUT_MS);
  }

  #fail(message) {
    this.lastError = message;
    clearTimeout(this.#timeout);
    this.#setState(LINK_STATE.FAILED);
    this.#emit('error', { message });
  }

  #attachChannel(channel) {
    this.#channel = channel;
    channel.binaryType = 'arraybuffer';
    channel.addEventListener('open', () => {
      clearTimeout(this.#timeout);
      this.#setState(LINK_STATE.OPEN);
      this.#emit('open', {});
    });
    channel.addEventListener('close', () => {
      this.#setState(LINK_STATE.CLOSED);
      this.#emit('close', {});
    });
    channel.addEventListener('message', (event) => {
      // Text frames are control messages; anything else is file data. Trying to
      // JSON-parse a chunk of a video would silently drop it.
      if (typeof event.data !== 'string') {
        this.#emit('frame', { data: event.data });
        return;
      }
      let payload;
      try {
        payload = JSON.parse(event.data);
      } catch {
        return;
      }
      this.#emit('message', payload);
    });
  }

  #buildLocalInvite(fields, kind) {
    return {
      kind,
      idMode: this.#identity.idMode,
      createdAtSec: Math.floor(Date.now() / 1000),
      roomId: this.roomId,
      sessionId: fields.sessionId,
      ufrag: fields.ufrag,
      pwd: fields.pwd,
      fingerprint: fields.fingerprint.value,
      setup: fields.setup,
      candidates: dedupeCandidates(fields.candidates),
      nick: this.#identity.nick,
      contact: this.#identity.contact ?? null,
      keyAlgo: this.#identity.keyAlgo,
      publicKey: this.#identity.publicKey,
      groupLabel: this.groupLabel,
    };
  }

  /**
   * Step 1 (initiator): gather a complete offer and render it as a shareable code.
   */
  async createOffer({ roomId = 0, groupLabel = '' } = {}) {
    const pc = this.#createPeerConnection();
    this.#attachChannel(pc.createDataChannel('chat', { ordered: true }));
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    await waitForIceGathering(pc);
    const fields = extractSdpFields(pc.localDescription.sdp);
    fields.candidates = this.#gathered.length ? this.#gathered : fields.candidates;
    const invite = this.#buildLocalInvite(fields, KIND.OFFER);
    this.localInvite = invite;
    const code = await sealInvite(invite, this.#identity.privateKey, this.#identity.keyAlgo);
    this.#setState(LINK_STATE.OFFER_READY);
    return { code, invite };
  }

  /**
   * Step 2 (responder): consume the initiator's offer and produce the reply code.
   */
  async acceptOffer(code) {
    const opened = await openInvite(code);
    this.#adoptPeer(opened);
    if (opened.invite.kind !== KIND.OFFER) {
      throw new Error('that code is a reply, not an invite — paste it into the tab that created the invite');
    }
    const skeleton = await localSkeleton(this.#iceServers);
    const pc = this.#createPeerConnection();
    pc.addEventListener('datachannel', (event) => this.#attachChannel(event.channel));
    const remoteSdp = buildSdpFromSkeleton(skeleton, {
      sessionId: opened.invite.sessionId,
      ufrag: opened.invite.ufrag,
      pwd: opened.invite.pwd,
      fingerprint: { algo: 'sha-256', value: opened.invite.fingerprint },
      setup: 'actpass',
      candidates: opened.invite.candidates,
    });
    await pc.setRemoteDescription({ type: 'offer', sdp: remoteSdp });
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    await waitForIceGathering(pc);
    const fields = extractSdpFields(pc.localDescription.sdp);
    fields.candidates = this.#gathered.length ? this.#gathered : fields.candidates;
    const invite = this.#buildLocalInvite(fields, KIND.ANSWER);
    this.localInvite = invite;
    const replyCode = await sealInvite(invite, this.#identity.privateKey, this.#identity.keyAlgo);
    this.#setState(LINK_STATE.ANSWER_READY);
    this.#armTimeout();
    return { code: replyCode, invite };
  }

  /**
   * Step 3 (initiator): consume the reply and bring the channel up.
   */
  async acceptAnswer(code) {
    if (!this.#pc || !this.localInvite) {
      throw new Error('this tab has no pending invite — the invite must be created and completed in the same tab, because the connection state cannot be restored after a reload');
    }
    const opened = await openInvite(code);
    this.#adoptPeer(opened);
    if (opened.invite.kind !== KIND.ANSWER) {
      throw new Error('that code is an invite, not a reply — it needs to be opened by the person you invited');
    }
    const skeleton = await localSkeleton(this.#iceServers);
    const remoteSdp = buildSdpFromSkeleton(skeleton, {
      sessionId: opened.invite.sessionId,
      ufrag: opened.invite.ufrag,
      pwd: opened.invite.pwd,
      fingerprint: { algo: 'sha-256', value: opened.invite.fingerprint },
      setup: opened.invite.setup === 'actpass' ? 'active' : opened.invite.setup,
      candidates: opened.invite.candidates,
    });
    await this.#pc.setRemoteDescription({ type: 'answer', sdp: remoteSdp });
    this.#setState(LINK_STATE.CONNECTING);
    this.#armTimeout();
    return { invite: opened.invite, verified: opened.verified };
  }

  #adoptPeer(opened) {
    this.peerInvite = opened.invite;
    this.peerVerified = opened.verified;
    this.#emit('peer', { invite: opened.invite, verified: opened.verified });
  }

  /**
   * Both sides now know both DTLS fingerprints, so the short authentication
   * string can be computed. Compare it out of band to rule out a relay.
   */
  async computeShortAuthString() {
    if (!this.localInvite || !this.peerInvite) return null;
    const parts = [
      `dtls:${this.localInvite.fingerprint}`,
      `dtls:${this.peerInvite.fingerprint}`,
      `key:${bytesToHex(this.localInvite.publicKey)}`,
      `key:${bytesToHex(this.peerInvite.publicKey)}`,
    ];
    this.sas = await shortAuthString(parts);
    this.#emit('sas', this.sas);
    return this.sas;
  }

  send(text) {
    if (!this.#channel || this.#channel.readyState !== 'open') throw new Error('link is not open');
    this.#channel.send(text);
  }

  sendJson(object) {
    this.send(JSON.stringify(object));
  }

  get isOpen() {
    return this.#channel?.readyState === 'open';
  }

  close() {
    clearTimeout(this.#timeout);
    try {
      this.#channel?.close();
    } catch {
      /* already gone */
    }
    try {
      this.#pc?.close();
    } catch {
      /* already gone */
    }
    this.#setState(LINK_STATE.CLOSED);
  }
}
