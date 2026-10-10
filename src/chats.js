/**
 * Conversations: the chat list, its history, and the disappearing-message rules.
 *
 * Everything lives in IndexedDB on this device. There is no server to sync with
 * and no account to sync through, so "backup" means whatever the operating
 * system does with app data.
 *
 * Disappearing messages are decided locally, per conversation, and announced to
 * the peer when it changes. Each message records the expiry that applied when it
 * was sent or received — the same rule WhatsApp uses — so changing the setting
 * never retroactively deletes or revives older messages.
 */

import { idbAll, idbGet, idbSet, idbDelete, idbKeys } from './store.js';

export const conversationIdForPeer = (publicKeyHex) => `peer:${publicKeyHex}`;
export const conversationIdForRoom = (roomId) => `room:${roomId}`;

export const isRoomConversation = (id) => String(id).startsWith('room:');

/**
 * Drop messages whose timer has run out. Pure, so the rule can be tested
 * directly rather than through the UI.
 */
export function pruneExpired(messages, now = Date.now()) {
  if (!Array.isArray(messages)) return [];
  return messages.filter((message) => !message.expiresAt || message.expiresAt > now);
}

export function makeMessage({
  id,
  who,
  text,
  ts = Date.now(),
  from = null,
  state = 'sent',
  attachment = null,
  replyTo = null,
  starred = false,
  disappearingSeconds = 0,
}) {
  const message = { id: id ?? `${ts}-${Math.random().toString(36).slice(2, 8)}`, who, text, ts, state };
  if (from) message.from = from;
  if (replyTo) message.replyTo = replyTo;
  if (starred) message.starred = true;
  // Attachments must be carried explicitly: this used to copy a fixed set of
  // fields, which silently dropped the file and left an empty bubble.
  if (attachment) message.attachment = attachment;
  if (disappearingSeconds > 0 && who !== 'system') {
    message.expiresAt = ts + disappearingSeconds * 1000;
  }
  return message;
}

export function emptyChat({ id, kind = 'direct', nick = '', ...rest }) {
  return {
    id,
    kind,
    nick,
    idMode: 0,
    contact: null,
    publicKey: null,
    verified: false,
    sas: null,
    messages: [],
    unread: 0,
    updatedAt: Date.now(),
    disappearing: 0,
    pinned: false,
    lastSeenAt: null,
    muted: false,
    ...rest,
  };
}

/** How a message reads in a one-line preview. */
function describe(message) {
  const attachment = message.attachment;
  const body = String(message.text ?? '');
  let text = body;
  if (attachment) {
    const label =
      attachment.kind === 'image' ? 'Photo'
        : attachment.kind === 'video' ? 'Video'
          : attachment.kind === 'audio' ? 'Audio'
            : attachment.name || 'Document';
    const icon = attachment.kind === 'image' ? '📷' : attachment.kind === 'video' ? '🎬' : attachment.kind === 'audio' ? '🎵' : '📄';
    text = body ? `${icon} ${body}` : `${icon} ${label}`;
  }
  return text.length > 90 ? `${text.slice(0, 90)}…` : text;
}

/** The one-line preview shown in the chat list. */
export function previewOf(chat) {
  const last = chat.messages[chat.messages.length - 1];
  if (!last) return chat.kind === 'room' ? 'Room — nobody has spoken yet' : 'No messages yet';
  if (last.who === 'system') return last.text;
  const body = describe(last);
  if (last.who === 'me') return `You: ${body}`;
  return chat.kind === 'room' && last.from ? `${last.from}: ${body}` : body;
}

export class ChatStore {
  #chats = new Map();

  static async load() {
    const store = new ChatStore();
    for (const record of (await idbAll('chats')) ?? []) {
      const chat = { ...emptyChat({ id: record.id }), ...record };
      chat.messages = pruneExpired(chat.messages);
      store.#chats.set(chat.id, chat);
    }
    return store;
  }

  get size() {
    return this.#chats.size;
  }

  has(id) {
    return this.#chats.has(id);
  }

  get(id) {
    return this.#chats.get(id);
  }

  /** Pinned conversations first, then most recent — as every chat app does. */
  list({ filter = '' } = {}) {
    const needle = filter.trim().toLowerCase();
    const matches = [...this.#chats.values()].filter((chat) => {
      if (!needle) return true;
      if (chat.nick?.toLowerCase().includes(needle)) return true;
      return chat.messages.some((message) => String(message.text ?? '').toLowerCase().includes(needle));
    });
    return matches.sort((a, b) => {
      if (Boolean(a.pinned) !== Boolean(b.pinned)) return a.pinned ? -1 : 1;
      return b.updatedAt - a.updatedAt;
    });
  }

  async togglePin(chatId) {
    const chat = this.#chats.get(chatId);
    if (!chat) return null;
    chat.pinned = !chat.pinned;
    await this.save(chat);
    return chat;
  }

  async toggleStar(chatId, messageId) {
    const chat = this.#chats.get(chatId);
    const message = chat?.messages.find((entry) => entry.id === messageId);
    if (!message) return null;
    message.starred = !message.starred;
    await this.save(chat);
    return message;
  }

  async setLastSeen(chatId, ts) {
    const chat = this.#chats.get(chatId);
    if (!chat) return null;
    chat.lastSeenAt = ts;
    await this.save(chat);
    return chat;
  }

  async deleteMessage(chatId, messageId) {
    const chat = this.#chats.get(chatId);
    if (!chat) return null;
    const index = chat.messages.findIndex((entry) => entry.id === messageId);
    if (index < 0) return null;
    const [removed] = chat.messages.splice(index, 1);
    await this.save(chat);
    await this.dropUnreferencedMedia();
    return removed;
  }

  ensure({ id, kind = 'direct', nick = '', ...rest }) {
    let chat = this.#chats.get(id);
    if (!chat) {
      chat = emptyChat({ id, kind, nick, ...rest });
      this.#chats.set(id, chat);
    } else {
      Object.assign(chat, { nick: nick || chat.nick, ...rest });
    }
    return chat;
  }

  async save(chat) {
    chat.messages = pruneExpired(chat.messages);
    await idbSet('chats', chat.id, { ...chat });
    return chat;
  }

  async append(chatId, message, { unread = true } = {}) {
    const chat = this.#chats.get(chatId);
    if (!chat) throw new Error(`unknown conversation ${chatId}`);
    chat.messages.push(message);
    chat.updatedAt = message.ts;
    // Only count as unread when the conversation is not the one on screen.
    if (unread && message.who === 'them') chat.unread += 1;
    await this.save(chat);
    return chat;
  }

  async setMessageState(chatId, messageId, state) {
    const chat = this.#chats.get(chatId);
    if (!chat) return null;
    const message = chat.messages.find((entry) => entry.id === messageId);
    if (!message || message.state === state) return chat;
    message.state = state;
    await this.save(chat);
    return chat;
  }

  async markRead(chatId) {
    const chat = this.#chats.get(chatId);
    if (!chat || chat.unread === 0) return chat;
    chat.unread = 0;
    await this.save(chat);
    return chat;
  }

  async setDisappearing(chatId, seconds) {
    const chat = this.#chats.get(chatId);
    if (!chat) return null;
    chat.disappearing = seconds;
    await this.save(chat);
    return chat;
  }

  /** Remove expired messages from every conversation. Returns the ids that changed. */
  async sweep(now = Date.now()) {
    const changed = [];
    for (const chat of this.#chats.values()) {
      const kept = pruneExpired(chat.messages, now);
      if (kept.length !== chat.messages.length) {
        chat.messages = kept;
        await this.save(chat);
        changed.push(chat.id);
      }
    }
    // A photo that disappeared should not sit on disk afterwards. Blobs are
    // content addressed and can be shared, so this removes what nothing points
    // at rather than what one message pointed at.
    if (changed.length) await this.dropUnreferencedMedia();
    return changed;
  }

  /** Delete stored blobs no remaining message refers to. */
  async dropUnreferencedMedia() {
    const referenced = this.referencedMedia();
    const keys = (await idbKeys('media')) ?? [];
    let dropped = 0;
    for (const key of keys) {
      if (referenced.has(key)) continue;
      await idbDelete('media', key);
      dropped++;
    }
    return dropped;
  }

  async remove(chatId) {
    this.#chats.delete(chatId);
    await idbDelete('chats', chatId);
  }

  async clearMessages(chatId) {
    const chat = this.#chats.get(chatId);
    if (!chat) return null;
    // Blobs are content addressed and can be shared between messages, so they
    // are left in place; the sweeper removes anything no longer referenced.
    chat.messages = [];
    await this.save(chat);
    return chat;
  }

  /** Digest ids still referenced by any message, for storage cleanup. */
  referencedMedia() {
    const ids = new Set();
    for (const chat of this.#chats.values()) {
      for (const message of chat.messages) {
        if (message.attachment?.fileId && message.attachment.status === 'complete') {
          ids.add(message.attachment.fileId);
        }
      }
    }
    return ids;
  }

  /** Total unread, for the app badge. */
  unreadCount() {
    let total = 0;
    for (const chat of this.#chats.values()) total += chat.unread;
    return total;
  }
}

export { idbGet };
