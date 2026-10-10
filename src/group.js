/**
 * Group chat with no server and no rendezvous point.
 *
 * Topology
 * --------
 * Everyone performs exactly ONE manual code exchange, with whoever created the
 * room. That first data channel is then used as a signaling channel: members
 * tunnel WebRTC offers and answers through it to build a direct mesh between
 * every pair. N members cost N manual exchanges, not N².
 *
 * Relay resistance
 * ----------------
 * Group messages are sealed separately for each recipient with a key derived
 * from the two long-term identity keys (ECDH over P-256). A member who merely
 * forwards ciphertext for others — the room creator, typically — can route
 * messages but cannot read them. Flooding with de-duplication means the room
 * still works when the mesh is only partial, which matters because a direct
 * link between two members can fail on hostile NATs while both remain reachable
 * through the hub.
 */

import { PairingSession } from './session.js';
import { deriveSharedKey } from './crypto.js';
import { bytesToHex, b64urlEncode, b64urlDecode } from './codec.js';

export const GROUP = {
  HELLO: 'g.hello',
  ROSTER: 'g.roster',
  OFFER: 'g.offer',
  ANSWER: 'g.answer',
  CHAT: 'g.chat',
};

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export class GroupSession extends EventTarget {
  constructor({ identity, roomId, label = '', isHost = false }) {
    super();
    this.identity = identity;
    this.roomId = String(roomId);
    this.label = label;
    this.isHost = isHost;
    this.myKey = bytesToHex(identity.publicKey);

    this.links = new Map(); // peerKey -> PairingSession
    this.members = new Map(); // peerKey -> member record
    this.pendingMesh = new Map(); // peerKey -> PairingSession awaiting an answer
    this.pairwise = new Map(); // peerKey -> AES-GCM CryptoKey
    this.seen = new Set();
    this.seq = 0;

    this.#upsert(
      this.myKey,
      {
        nick: identity.nick,
        idMode: identity.idMode,
        contact: identity.contact,
        publicKey: identity.publicKey,
      },
      { online: true, direct: false },
    );
  }

  #nextId() {
    this.seq += 1;
    return `${this.myKey}:${this.seq}`;
  }

  #emit(type, detail) {
    this.dispatchEvent(new CustomEvent(type, { detail }));
  }

  #emitMembers() {
    this.#emit('members', { members: this.membersList() });
  }

  membersList() {
    return [...this.members.values()].map((member) => ({
      key: member.key,
      nick: member.nick,
      idMode: member.idMode,
      contact: member.contact,
      direct: Boolean(member.direct),
      online: Boolean(member.online),
      isSelf: member.key === this.myKey,
    }));
  }

  #upsert(key, fields, flags = {}) {
    const existing = this.members.get(key) ?? { key, online: false, direct: false };
    const member = {
      ...existing,
      ...Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== undefined && value !== null)),
      ...flags,
    };
    this.members.set(key, member);
    return member;
  }

  /* ------------------------------------------------------------ linking */

  /** Register a live PairingSession (the hub link, or a mesh link). */
  attach(session) {
    const invite = session.peerInvite;
    if (!invite) return null;
    const key = bytesToHex(invite.publicKey);
    if (this.links.has(key)) return key;

    this.links.set(key, session);
    this.#upsert(
      key,
      { nick: invite.nick, idMode: invite.idMode, contact: invite.contact, publicKey: invite.publicKey },
      { direct: true, online: true },
    );

    session.addEventListener('message', (event) => {
      this.#onMessage(event.detail, key).catch(() => {});
    });
    // Binary frames matter too: a member serving file chunks to another member
    // sends them over this link, and they are not control messages.
    session.addEventListener('frame', (event) => {
      this.#emit('frame', { data: event.detail.data, peerKey: key, session });
    });
    session.addEventListener('close', () => {
      this.links.delete(key);
      const member = this.members.get(key);
      if (member) {
        member.online = false;
        member.direct = false;
      }
      this.#emitMembers();
    });

    this.#send(session, this.#hello());
    if (this.isHost) this.#broadcastRoster();
    this.#emitMembers();
    return key;
  }

  #hello() {
    return {
      t: GROUP.HELLO,
      mid: this.#nextId(),
      from: this.myKey,
      roomId: this.roomId,
      label: this.label,
      nick: this.identity.nick,
      idMode: this.identity.idMode,
      contact: this.identity.contact,
      publicKey: b64urlEncode(this.identity.publicKey),
    };
  }

  #send(session, message) {
    try {
      if (session.isOpen) session.sendJson(message);
    } catch {
      /* the link died between the check and the send */
    }
  }

  /** Send to every direct link, optionally skipping one. */
  flood(message, exceptKey = null) {
    if (message.mid) this.seen.add(message.mid);
    for (const [key, session] of this.links) {
      if (key === exceptKey) continue;
      this.#send(session, message);
    }
  }

  #broadcastRoster() {
    this.flood({
      t: GROUP.ROSTER,
      mid: this.#nextId(),
      from: this.myKey,
      host: this.myKey,
      members: [...this.members.values()].map((member) => ({
        key: member.key,
        nick: member.nick,
        idMode: member.idMode,
        contact: member.contact,
        publicKey: b64urlEncode(member.publicKey ?? new Uint8Array()),
      })),
    });
  }

  /* ----------------------------------------------------------- messages */

  async #onMessage(message, fromKey) {
    if (!message || typeof message.t !== 'string') return;

    // Anything that is not group signalling belongs to the application. Mesh
    // links are created here, so without this hand-off a message sent straight
    // between two members — a file announcement, a typing notice — would vanish.
    if (!message.t.startsWith('g.')) {
      this.#emit('peer-message', {
        message,
        peerKey: fromKey,
        session: this.links.get(fromKey) ?? null,
      });
      return;
    }

    // De-duplicate synchronously, before any await, so a message arriving both
    // directly and via a relay is only ever handled once.
    if (message.mid) {
      if (this.seen.has(message.mid)) return;
      this.seen.add(message.mid);
    }

    // The logical sender is whoever signed the message, which is NOT necessarily
    // the link it arrived on: a mesh offer from member B reaches member C
    // through the hub. `fromKey` is only used to avoid echoing back.
    const origin = typeof message.from === 'string' ? message.from : fromKey;

    // Addressed to someone else: pass it along and stop.
    if (message.to && message.to !== this.myKey) {
      this.#forward(message, fromKey);
      return;
    }

    switch (message.t) {
      case GROUP.HELLO: {
        // Hello is only ever sent on a direct link, so the link key is the
        // authenticated identity here. Anything else is a spoof attempt.
        if (message.from && message.from !== fromKey) break;
        if (message.publicKey) {
          this.#upsert(
            fromKey,
            {
              nick: message.nick,
              idMode: message.idMode,
              contact: message.contact,
              publicKey: b64urlDecode(message.publicKey),
            },
            { online: true },
          );
        }
        this.#emitMembers();
        // The hub is the only source of roster truth, so it re-announces the
        // membership whenever somebody new says hello. Members that joined later
        // then dial the ones already present.
        if (this.isHost) this.#broadcastRoster();
        break;
      }

      case GROUP.ROSTER: {
        this.#adoptRoster(Array.isArray(message.members) ? message.members : []);
        break;
      }

      case GROUP.OFFER: {
        await this.#answerMesh(message, origin);
        break;
      }

      case GROUP.ANSWER: {
        const session = this.pendingMesh.get(origin);
        this.pendingMesh.delete(origin);
        if (!session) break;
        session.addEventListener('open', () => this.attach(session));
        try {
          await session.acceptAnswer(message.code);
          // The code is signed: confirm it really came from the peer we dialed.
          if (bytesToHex(session.peerInvite.publicKey) !== origin) {
            session.close();
            this.#emit('warning', { message: 'a mesh reply was signed by the wrong key' });
          }
        } catch (error) {
          this.#emit('warning', { message: `mesh link could not be completed: ${error.message}` });
        }
        break;
      }

      case GROUP.CHAT: {
        const text = await this.#open(message);
        if (text !== null) {
          const member = this.members.get(message.from);
          this.#emit('message', {
            from: message.from,
            nick: member?.nick ?? 'unknown',
            text,
            ts: message.ts ?? Date.now(),
            direct: this.links.has(message.from),
          });
        }
        // Keep flooding: a member with no direct link to the sender still gets it.
        this.#forward(message, fromKey);
        break;
      }

      default:
        break;
    }
  }

  #forward(message, exceptKey) {
    for (const [key, session] of this.links) {
      if (key === exceptKey) continue;
      this.#send(session, message);
    }
  }

  #adoptRoster(entries) {
    for (const entry of entries) {
      if (!entry?.key || entry.key === this.myKey) continue;
      this.#upsert(
        entry.key,
        {
          nick: entry.nick,
          idMode: entry.idMode,
          contact: entry.contact,
          publicKey: entry.publicKey ? b64urlDecode(entry.publicKey) : undefined,
        },
      );
    }
    this.#emitMembers();

    // Only members who joined later dial earlier ones. The roster order comes
    // from the host alone, so both sides agree on who dials whom and no pair
    // ends up with two links.
    const myIndex = entries.findIndex((entry) => entry?.key === this.myKey);
    if (myIndex <= 0) return;
    for (const entry of entries.slice(0, myIndex)) {
      if (!entry?.key || entry.key === this.myKey) continue;
      if (this.links.has(entry.key) || this.pendingMesh.has(entry.key)) continue;
      this.#initiateMesh(entry).catch(() => {});
    }
  }

  /** Open a direct link to an existing member, signaled through the mesh. */
  async #initiateMesh(member) {
    if (!this.identity.privateKey) return;
    const session = new PairingSession({ identity: this.identity, roomId: this.roomId, groupLabel: this.label });
    this.pendingMesh.set(member.key, session);
    const giveUp = setTimeout(() => this.pendingMesh.delete(member.key), 45000);
    try {
      const { code } = await session.createOffer({ roomId: this.roomId, groupLabel: this.label });
      this.flood({ t: GROUP.OFFER, mid: this.#nextId(), from: this.myKey, to: member.key, code });
    } catch (error) {
      clearTimeout(giveUp);
      this.pendingMesh.delete(member.key);
      this.#emit('warning', { message: `could not offer a mesh link: ${error.message}` });
    }
  }

  async #answerMesh(message, origin) {
    if (!message.code || origin === this.myKey) return;
    if (this.links.has(origin)) return;
    const session = new PairingSession({ identity: this.identity, roomId: this.roomId, groupLabel: this.label });
    session.addEventListener('open', () => this.attach(session));
    try {
      const { code } = await session.acceptOffer(message.code);
      // The offer is signed: make sure it is really from the member it claims.
      if (bytesToHex(session.peerInvite.publicKey) !== origin) {
        session.close();
        this.#emit('warning', { message: 'a mesh offer was signed by the wrong key' });
        return;
      }
      this.flood({ t: GROUP.ANSWER, mid: this.#nextId(), from: this.myKey, to: origin, code });
    } catch (error) {
      this.#emit('warning', { message: `could not answer a mesh offer: ${error.message}` });
    }
  }

  /* --------------------------------------------------------- encryption */

  async #pairwiseKeyFor(member) {
    if (this.pairwise.has(member.key)) return this.pairwise.get(member.key);
    if (!this.identity.ecdhPrivateKey || !member.publicKey) return null;
    const key = await deriveSharedKey(
      this.identity.ecdhPrivateKey,
      member.publicKey,
      `p2pchat/v1/group/${this.roomId}`,
    );
    this.pairwise.set(member.key, key);
    return key;
  }

  async #seal(text) {
    const sealed = {};
    const plaintext = encoder.encode(text);
    for (const [key, member] of this.members) {
      if (key === this.myKey) continue;
      const aes = await this.#pairwiseKeyFor(member);
      if (!aes) continue;
      const iv = crypto.getRandomValues(new Uint8Array(12));
      const ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, aes, plaintext));
      sealed[key] = { iv: b64urlEncode(iv), ct: b64urlEncode(ciphertext) };
    }
    return sealed;
  }

  async #open(message) {
    const entry = message.sealed?.[this.myKey];
    if (!entry) return null;
    const sender = this.members.get(message.from);
    if (!sender) return null;
    const aes = await this.#pairwiseKeyFor(sender);
    if (!aes) return null;
    try {
      const plaintext = await crypto.subtle.decrypt(
        { name: 'AES-GCM', iv: b64urlDecode(entry.iv) },
        aes,
        b64urlDecode(entry.ct),
      );
      return decoder.decode(plaintext);
    } catch {
      return null;
    }
  }

  /** Send one message to the whole room, sealed separately for every member. */
  async sendChat(text) {
    const mid = this.#nextId();
    const sealed = await this.#seal(text);
    const message = { t: GROUP.CHAT, mid, from: this.myKey, ts: Date.now(), sealed };
    this.seen.add(mid);
    this.#forward(message, null);
    return message;
  }

  get memberCount() {
    return this.members.size;
  }

  close() {
    for (const session of this.links.values()) session.close();
    this.links.clear();
  }
}
