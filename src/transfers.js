/**
 * Durable storage for file transfers.
 *
 * Two things have to outlive a dropped link, a reload, or a phone going to
 * sleep:
 *
 *   1. **The bytes already received.** Each chunk is stored under its own key, so
 *      a partial transfer is a set of small writes rather than one huge blob
 *      rewritten on every packet. What the receiver holds is then simply the
 *      keys that exist — the bitmap can never drift out of sync with the data.
 *   2. **What was in flight.** An outgoing transfer keeps its `File` (IndexedDB
 *      stores blobs natively, so nothing is copied into memory), which is what
 *      lets the app re-offer it automatically when the peer reconnects.
 *
 * Completed files are stored once, keyed by their content digest. That makes the
 * store content-addressed: the same photo sent twice occupies one slot, and a
 * peer that already has a file can say so without receiving it again.
 */

import { idbGet, idbSet, idbDelete, idbKeysFrom, idbAll } from './store.js';

export const chunkKey = (fileId, sequence) => `${fileId}:${sequence}`;

const parseSequence = (key) => Number(String(key).slice(String(key).lastIndexOf(':') + 1));

export class TransferStore {
  #outgoing = new Map();
  #incoming = new Map();

  static async load() {
    const store = new TransferStore();
    for (const record of (await idbAll('transfers')) ?? []) {
      if (record.direction === 'out') store.#outgoing.set(record.fileId, record);
      else store.#incoming.set(record.fileId, record);
    }
    return store;
  }

  /* ---------------------------------------------------------------- chunks */

  async putChunk(fileId, sequence, bytes) {
    await idbSet('chunks', chunkKey(fileId, sequence), bytes);
  }

  /** The sequences already on disk for this file. */
  async heldSequences(fileId) {
    const keys = (await idbKeysFrom('chunks', `${fileId}:`)) ?? [];
    return new Set(keys.map(parseSequence));
  }

  async heldCount(fileId) {
    return (await this.heldSequences(fileId)).size;
  }

  /** Rebuild the file from its stored chunks. */
  async assemble(fileId, { total, mime = '' }) {
    const keys = (await idbKeysFrom('chunks', `${fileId}:`)) ?? [];
    if (keys.length < total) {
      throw new Error(`only ${keys.length} of ${total} chunks are stored`);
    }
    const ordered = keys
      .map((key) => ({ key, sequence: parseSequence(key) }))
      .sort((a, b) => a.sequence - b.sequence);

    const parts = [];
    for (const { key } of ordered) {
      const part = await idbGet('chunks', key);
      if (part) parts.push(part);
    }
    return new Blob(parts, { type: mime });
  }

  async dropChunks(fileId) {
    const keys = (await idbKeysFrom('chunks', `${fileId}:`)) ?? [];
    for (const key of keys) await idbDelete('chunks', key);
    return keys.length;
  }

  /* ----------------------------------------------------------- media blobs */

  async putMedia(fileId, blob, meta = {}) {
    await idbSet('media', fileId, { fileId, blob, size: blob.size, ...meta });
  }

  async getMedia(fileId) {
    return idbGet('media', fileId);
  }

  async hasMedia(fileId) {
    return Boolean(await idbGet('media', fileId));
  }

  async dropMedia(fileId) {
    await idbDelete('media', fileId);
  }

  /* ------------------------------------------------------- transfer records */

  /**
   * Outgoing records are keyed by file *and* peer: in a room the same file is
   * offered to every member, and each needs its own progress.
   */
  static outgoingId(record) {
    return record.peerKey ? `${record.fileId}@${record.peerKey}` : record.fileId;
  }

  async saveOutgoing(record) {
    const id = TransferStore.outgoingId(record);
    this.#outgoing.set(id, record);
    await idbSet('transfers', id, record);
  }

  async removeOutgoing(fileId, peerKey = null) {
    const id = peerKey ? `${fileId}@${peerKey}` : fileId;
    this.#outgoing.delete(id);
    await idbDelete('transfers', id);
    // A direct-chat record may still be stored under the bare file id.
    if (peerKey) {
      this.#outgoing.delete(fileId);
      await idbDelete('transfers', fileId);
    }
  }

  async saveIncoming(record) {
    this.#incoming.set(record.fileId, record);
    await idbSet('transfers', record.fileId, record);
  }

  async removeIncoming(fileId) {
    this.#incoming.delete(fileId);
    await idbDelete('transfers', fileId);
  }

  /** Unfinished sends for a conversation, oldest first. */
  outgoingFor(chatId) {
    return [...this.#outgoing.values()]
      .filter((record) => record.chatId === chatId)
      .sort((a, b) => a.startedAt - b.startedAt);
  }

  /** Unfinished receives for a conversation. */
  incomingFor(chatId) {
    return [...this.#incoming.values()].filter((record) => record.chatId === chatId);
  }

  get pendingCount() {
    return this.#outgoing.size + this.#incoming.size;
  }

  /** Delete everything belonging to one file: chunks, blob and records. */
  async forget(fileId) {
    await this.dropChunks(fileId);
    await this.dropMedia(fileId);
    await this.removeOutgoing(fileId);
    await this.removeIncoming(fileId);
  }
}
