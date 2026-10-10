/**
 * Identity: the long-term key pair plus whatever the user chose to disclose.
 *
 * Three sharing modes, matching the three things a person actually wants:
 *
 *   pseudonym  a nickname, bound to a stable key — recognisable next time
 *   contact    a nickname plus a contact card (name / phone / email / note)
 *   burner     a nickname bound to a throwaway key — unlinkable to you
 *
 * The signature always covers the whole payload, so a nickname cannot be edited
 * by whoever carries the link.
 */

import { generateIdentityKeyPair, KEY_ALGO, keyFingerprint } from './crypto.js';
import { ID_MODE } from './payload.js';
import { idbGet, idbSet } from './store.js';

const ADJECTIVES = [
  'quiet', 'amber', 'brisk', 'clever', 'dusk', 'ember', 'fleet', 'gentle',
  'hollow', 'ivory', 'jade', 'keen', 'lunar', 'mellow', 'nimble', 'opal',
  'plain', 'quartz', 'rapid', 'silver', 'tidal', 'umber', 'velvet', 'wry',
];

const NOUNS = [
  'otter', 'falcon', 'cedar', 'heron', 'lynx', 'marten', 'osprey', 'pika',
  'raven', 'seal', 'tern', 'vole', 'wolf', 'wren', 'yak', 'finch',
];

export const CONTACT_FIELDS = ['name', 'phone', 'email', 'note'];

export function suggestNick() {
  const pick = (list, bytes) => list[bytes % list.length];
  const random = crypto.getRandomValues(new Uint8Array(2));
  return `${pick(ADJECTIVES, random[0])}-${pick(NOUNS, random[1])}`;
}

export function sanitizeContact(contact = {}) {
  const clean = {};
  for (const field of CONTACT_FIELDS) {
    const value = String(contact[field] ?? '').trim().slice(0, 200);
    if (value) clean[field] = value;
  }
  return clean;
}

export function contactIsEmpty(contact) {
  return Object.keys(sanitizeContact(contact)).length === 0;
}

const DEFAULT_PROFILE = {
  nick: '',
  idMode: ID_MODE.PSEUDONYM,
  contact: {},
  groupLabel: '',
};

const KEYS_RECORD_VERSION = 2;

export class Identity {
  #mainKey;
  #burnerKey = null;

  constructor({ keyPair, profile }) {
    this.#mainKey = keyPair;
    this.profile = { ...DEFAULT_PROFILE, ...profile };
    if (!this.profile.nick) this.profile.nick = suggestNick();
  }

  /** Load the stored identity, creating one on first run. */
  static async load() {
    let stored = await idbGet('keys', 'identity');
    if (!stored || stored.version !== KEYS_RECORD_VERSION) {
      const keyPair = await generateIdentityKeyPair(KEY_ALGO.P256);
      stored = {
        version: KEYS_RECORD_VERSION,
        keyAlgo: keyPair.keyAlgo,
        publicKey: [...keyPair.publicKey],
        privateKey: keyPair.privateKey,
        ecdhPrivateKey: keyPair.ecdhPrivateKey,
      };
      await idbSet('keys', 'identity', stored);
    }
    const profile = (await idbGet('profile', 'self')) ?? {};
    return new Identity({
      keyPair: {
        keyAlgo: stored.keyAlgo,
        publicKey: Uint8Array.from(stored.publicKey),
        privateKey: stored.privateKey,
        ecdhPrivateKey: stored.ecdhPrivateKey,
      },
      profile,
    });
  }

  get publicKey() {
    return this.#mainKey.publicKey;
  }

  get keyAlgo() {
    return this.#mainKey.keyAlgo;
  }

  async fingerprint() {
    return keyFingerprint(this.#mainKey.publicKey);
  }

  async saveProfile(patch) {
    this.profile = { ...this.profile, ...patch };
    if (this.profile.contact) this.profile.contact = sanitizeContact(this.profile.contact);
    await idbSet('profile', 'self', this.profile);
    return this.profile;
  }

  /**
   * Produce the identity material that goes into an invite, honouring the
   * selected sharing mode. Burner keys are generated on demand and kept only for
   * the lifetime of this session, so two burner invites are not linkable.
   */
  async signingIdentity({ mode = this.profile.idMode, nick = this.profile.nick, contact = this.profile.contact } = {}) {
    const wantsContact = mode === ID_MODE.CONTACT && !contactIsEmpty(contact);
    const base = {
      idMode: wantsContact ? ID_MODE.CONTACT : mode,
      nick: String(nick || suggestNick()).slice(0, 48),
      contact: wantsContact ? sanitizeContact(contact) : null,
    };

    if (mode === ID_MODE.BURNER) {
      this.#burnerKey ??= await generateIdentityKeyPair(KEY_ALGO.P256);
      return {
        ...base,
        idMode: wantsContact ? ID_MODE.CONTACT : ID_MODE.BURNER,
        keyAlgo: this.#burnerKey.keyAlgo,
        publicKey: this.#burnerKey.publicKey,
        privateKey: this.#burnerKey.privateKey,
        ecdhPrivateKey: this.#burnerKey.ecdhPrivateKey,
      };
    }

    return {
      ...base,
      keyAlgo: this.#mainKey.keyAlgo,
      publicKey: this.#mainKey.publicKey,
      privateKey: this.#mainKey.privateKey,
      ecdhPrivateKey: this.#mainKey.ecdhPrivateKey,
    };
  }

  /** Forget the burner key so the next burner invite is unlinkable again. */
  discardBurnerKey() {
    this.#burnerKey = null;
  }
}
