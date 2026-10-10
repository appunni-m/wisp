/**
 * Wisp — the UI layer.
 *
 * Views, in the order a person meets them:
 *   home     the chat list
 *   connect  create an invite, or take one
 *   reply    hand the reply code back
 *   chat     the conversation
 *
 * The pairing and group machinery lives in session.js / group.js; this file is
 * about presenting it, and about keeping conversations on disk.
 */

import { Identity } from './identity.js';
import { PairingSession, LINK_STATE } from './session.js';
import { GroupSession } from './group.js';
import { openInvite, buildInviteLink, codeFromHash, KIND, ID_MODE, ID_MODE_NAME, inviteAgeSeconds } from './payload.js';
import { keyFingerprint } from './crypto.js';
import { idbGet, idbSet } from './store.js';
import {
  ChatStore,
  conversationIdForPeer,
  conversationIdForRoom,
  makeMessage,
  previewOf,
} from './chats.js';
import {
  APP_NAME,
  DISAPPEARING_OPTIONS,
  disappearingLabel,
  formatListTime,
  formatClock,
  formatDaySeparator,
  formatLastSeen,
  avatarColour,
  initialsFor,
} from './config.js';
import { encodeQr, drawQrToCanvas } from './qr.js';
import { scannerCapability, startQrScan } from './scan.js';
import {
  nfcCapability,
  writeInviteToTag,
  scanForInvite,
  NfcError,
  keepAlive,
  requestNotificationPermission,
  subscribeToAppUrls,
  probeNativeSupport,
} from './nfc.js';
import { configureIceServers, iceServersFromParams, currentIceServers } from './sdp.js';
import { TransferStore } from './transfers.js';
import { hashBlob } from './sha256.js';
import {
  CHUNK_SIZE,
  MAX_FILE_BYTES,
  WARN_FILE_BYTES,
  TRANSFER,
  makeTransferId,
  chunkCount,
  readFrame,
  encodeBitmap,
  decodeBitmap,
  kindFor,
  extensionFor,
  formatBytes,
  makeThumbnail,
  IncomingTransfer,
  OutgoingTransfer,
  channelDrain,
  serveChunks,
  missingSequences,
} from './media.js';
import { b64urlEncode, b64urlDecode } from './codec.js';
import { planSources, toBatches } from './swarm.js';

const el = (id) => document.getElementById(id);
const INVITE_STALE_SECONDS = 15 * 60;
const SWEEP_INTERVAL_MS = 15000;

const state = {
  identity: null,
  chats: null,
  transfers: null,
  /** Live receives, keyed by transfer id, so a binary frame can find its file. */
  receiving: new Map(),
  /** Live sends, keyed by file id, so a cancel can stop one. */
  sending: new Map(),
  /** Preview state for the attachment sheet. */
  pendingAttachments: [],
  /** Counters that make resume observable rather than assumed. */
  stats: { sentBytes: 0, skippedBytes: 0, runs: 0, resumed: 0, completed: 0, served: 0 },
  /** The message being replied to, shown above the composer. */
  replyingTo: null,
  /** The message a long press opened the menu for. */
  menuMessageId: null,
  /** The chat a long press opened the menu for. */
  menuChatId: null,
  /** Transient "typing…" flags, keyed by conversation. */
  typing: new Map(),
  /** Who has announced they hold a finished file: fileId -> Set of peer keys. */
  holders: new Map(),
  /** Chunk reads we are currently serving to somebody else. */
  serving: new Map(),
  searching: false,
  recorder: null,
  activeChatId: null,
  session: null,
  group: null,
  groupIdentity: null,
  view: 'connect',
  peer: null,
  peerVerified: false,
  sas: null,
  lastError: null,
};

function randomRoomId() {
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  let value = 0n;
  for (const byte of bytes) value = (value << 8n) | BigInt(byte);
  return value.toString();
}

const hex = (bytes) => [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');

/* -------------------------------------------------------------------- views */

const VIEWS = ['home', 'connect', 'reply', 'chat', 'settings', 'info'];

function showView(name) {
  state.view = name;
  if (name !== 'connect') stopScanning();
  for (const view of VIEWS) {
    el(`view-${view}`).hidden = view !== name;
  }
  // The identity form is the body of the settings page.
  el('identity-panel').hidden = name !== 'settings';

  const inChat = name === 'chat';
  el('appbar').hidden = inChat;
  el('tabbar').hidden = inChat;
  el('search-bar').hidden = !(name === 'home' && state.searching);
  el('tab-chats').setAttribute('aria-selected', String(name !== 'settings'));
  el('tab-settings').setAttribute('aria-selected', String(name === 'settings'));
  el('link-dot').dataset.state = inChat ? 'open' : 'idle';
}

function setDot(value) {
  el('link-dot').dataset.state = value;
}

let toastTimer = null;
function toast(message, bad = false) {
  const node = el('toast');
  node.textContent = message;
  node.classList.toggle('bad', Boolean(bad));
  node.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    node.hidden = true;
  }, bad ? 6000 : 3200);
}

const activeChat = () => (state.activeChatId ? state.chats.get(state.activeChatId) : null);

/* ------------------------------------------------------------------ identity */

const MODE_BY_NAME = { pseudonym: ID_MODE.PSEUDONYM, contact: ID_MODE.CONTACT, burner: ID_MODE.BURNER };

function hydrateIdentityForm() {
  const { profile } = state.identity;
  el('nick-input').value = profile.nick;
  for (const radio of document.querySelectorAll('input[name="id-mode"]')) {
    radio.checked = radio.value === ID_MODE_NAME[profile.idMode];
  }
  const contact = profile.contact ?? {};
  el('contact-name').value = contact.name ?? '';
  el('contact-phone').value = contact.phone ?? '';
  el('contact-email').value = contact.email ?? '';
  el('contact-note').value = contact.note ?? '';
  el('contact-block').hidden = selectedMode() !== ID_MODE.CONTACT;
  state.identity.fingerprint().then((fingerprint) => {
    el('own-fingerprint').textContent = `Your key fingerprint: ${fingerprint}`;
  });
}

function selectedMode() {
  for (const radio of document.querySelectorAll('input[name="id-mode"]')) {
    if (radio.checked) return MODE_BY_NAME[radio.value] ?? ID_MODE.PSEUDONYM;
  }
  return ID_MODE.PSEUDONYM;
}

function readForm() {
  return {
    nick: el('nick-input').value.trim() || state.identity.profile.nick,
    mode: selectedMode(),
    contact: {
      name: el('contact-name').value,
      phone: el('contact-phone').value,
      email: el('contact-email').value,
      note: el('contact-note').value,
    },
  };
}

async function signingIdentity(overrides = {}) {
  const form = { ...readForm(), ...overrides };
  await state.identity.saveProfile({ nick: form.nick, idMode: form.mode, contact: form.contact });
  return state.identity.signingIdentity({ mode: form.mode, nick: form.nick, contact: form.contact });
}

/* ----------------------------------------------------------------- chat list */

function renderChatList() {
  const list = el('chat-list');
  const chats = state.chats.list({ filter: el('chat-search')?.value ?? '' });
  el('empty-state').hidden = chats.length > 0;
  list.innerHTML = '';

  for (const chat of chats) {
    const item = document.createElement('li');
    item.className = `chat-row${chat.pinned ? ' pinned' : ''}`;
    item.dataset.chatId = chat.id;

    const avatar = document.createElement('span');
    avatar.className = 'avatar';
    avatar.style.background = avatarColour(chat.publicKey ?? chat.id);
    avatar.textContent = initialsFor(chat.nick || 'Room');
    item.append(avatar);

    const main = document.createElement('div');
    main.className = 'chat-row-main';

    const top = document.createElement('div');
    top.className = 'chat-row-top';
    const name = document.createElement('span');
    name.className = 'chat-row-name';
    name.textContent = chat.nick || 'Unknown';
    const time = document.createElement('span');
    time.className = `chat-row-time${chat.unread ? ' unread' : ''}`;
    time.textContent = formatListTime(chat.updatedAt);
    top.append(name, time);

    const bottom = document.createElement('div');
    bottom.className = 'chat-row-bottom';
    const preview = document.createElement('span');
    preview.className = 'chat-row-preview';
    preview.textContent = previewOf(chat);
    bottom.append(preview);

    const flags = document.createElement('span');
    flags.className = 'chat-row-flags';
    if (chat.disappearing > 0) {
      const timer = document.createElement('span');
      timer.className = 'badge warn';
      timer.textContent = `⏱ ${disappearingLabel(chat.disappearing)}`;
      flags.append(timer);
    }
    if (chat.verified) {
      const verified = document.createElement('span');
      verified.className = 'badge ok';
      verified.textContent = '✓';
      verified.title = 'Signed invite';
      flags.append(verified);
    }
    if (chat.unread) {
      const pill = document.createElement('span');
      pill.className = 'unread-pill';
      pill.textContent = String(chat.unread);
      flags.append(pill);
    }
    bottom.append(flags);
    main.append(top, bottom);
    item.append(main);

    item.addEventListener('click', () => openChat(chat.id));
    // A long press (or right click) opens the row's actions, as it does everywhere else.
    onLongPress(item, () => openChatMenu(chat.id));
    list.append(item);
  }
}

function openChat(chatId) {
  const chat = state.chats.get(chatId);
  if (!chat) return;
  state.activeChatId = chatId;
  state.chats.markRead(chatId).catch(() => {});
  renderChatHeader();
  renderConversation();
  renderPeerCard();
  renderGroupPanel();
  updateComposerState();
  renderChatList();
  showView('chat');
}

function goHome() {
  state.activeChatId = null;
  renderChatList();
  showView(state.chats.size ? 'home' : 'connect');
}

/* ------------------------------------------------------------- conversation */

function renderChatHeader() {
  const chat = activeChat();
  if (!chat) return;
  const connected = Boolean(state.session?.isOpen) || Boolean(state.group?.links.size);
  el('chat-header-title').textContent = chat.nick || 'Unknown';
  const avatar = el('chat-avatar');
  avatar.textContent = initialsFor(chat.nick || 'Room');
  avatar.style.background = avatarColour(chat.publicKey ?? chat.id);

  const status = el('chat-header-status');
  const typing = state.typing.get(chat.id);

  if (typing) {
    // "typing…" beats every other status, exactly as it does in a chat app.
    status.textContent = 'typing…';
    status.className = 'typing';
    return;
  }
  status.className = connected ? 'online' : '';

  const parts = [];
  if (chat.kind === 'room') parts.push(`${state.group?.memberCount ?? chat.memberCount ?? 1} in room`);
  if (connected) parts.push('online');
  else if (chat.lastSeenAt) parts.push(formatLastSeen(chat.lastSeenAt));
  else parts.push('offline');
  if (chat.disappearing > 0) parts.push(`disappears after ${disappearingLabel(chat.disappearing)}`);
  status.textContent = parts.join(' · ');
}

function updateComposerState() {
  const chat = activeChat();
  const connected = Boolean(state.session?.isOpen) || Boolean(state.group?.links.size);
  const bar = el('offline-bar');
  if (!chat) {
    bar.hidden = true;
    return;
  }
  bar.hidden = connected;
  if (!connected) {
    bar.textContent =
      chat.kind === 'room'
        ? 'Nobody is connected to this room right now.'
        : `Waiting for ${chat.nick || 'them'}. Messages can only be sent while you are both here.`;
  }
  el('message-input').disabled = !connected;
  el('btn-send').disabled = !connected;
}

function tickMarkup(message) {
  const span = document.createElement('span');
  span.className = `ticks${message.state === 'delivered' ? ' delivered' : ''}`;
  span.textContent = message.state === 'delivered' ? '✓✓' : '✓';
  span.title = message.state === 'delivered' ? 'Delivered' : 'Sent';
  return span;
}

function renderConversation() {
  const box = el('messages');
  const chat = activeChat();
  box.innerHTML = '';
  if (!chat) return;

  let lastDay = null;
  let previousWho = null;

  for (const message of chat.messages) {
    const day = new Date(message.ts).toDateString();
    if (day !== lastDay) {
      const separator = document.createElement('div');
      separator.className = 'day-sep';
      const pill = document.createElement('span');
      pill.textContent = formatDaySeparator(message.ts);
      separator.append(pill);
      box.append(separator);
      lastDay = day;
      previousWho = null;
    }

    const node = document.createElement('div');
    node.className = `msg ${message.who}`;
    if (message.who !== 'system' && message.who !== previousWho) node.classList.add('first-in-group');
    if (message.state === 'failed') node.classList.add('failed');
    node.dataset.messageId = message.id;

    if (message.from && message.who === 'them') {
      const sender = document.createElement('span');
      sender.className = 'sender';
      sender.textContent = message.from;
      node.append(sender);
    }

    if (message.replyTo) {
      const quoted = document.createElement('span');
      quoted.className = 'quoted';
      const who = document.createElement('strong');
      who.textContent = message.replyTo.nick || 'message';
      const preview = document.createElement('span');
      preview.textContent = message.replyTo.preview || '';
      quoted.append(who, preview);
      node.append(quoted);
    }

    if (message.attachment) node.append(renderAttachment(message.attachment, message));

    if (message.text) {
      const body = document.createElement('span');
      body.className = message.attachment ? 'body caption' : 'body';
      body.textContent = message.text;
      node.append(body);
    }

    if (message.who !== 'system') {
      const meta = document.createElement('span');
      meta.className = 'meta';
      meta.append(document.createTextNode(formatClock(message.ts)));
      if (message.who === 'me' && message.state !== 'failed') meta.append(tickMarkup(message));
      node.append(meta);
    }

    if (message.starred) {
      const star = document.createElement('span');
      star.className = 'star';
      star.textContent = '★';
      node.append(star);
    }

    if (message.who !== 'system') onLongPress(node, () => openMessageMenu(message.id));
    box.append(node);
    previousWho = message.who;
  }

  box.scrollTop = box.scrollHeight;
}

function renderPeerCard() {
  const card = el('peer-card');
  const chat = activeChat();
  card.innerHTML = '';
  if (!chat) return;

  const who = document.createElement('div');
  who.className = 'who';
  const nick = document.createElement('span');
  nick.className = 'nick';
  nick.textContent = chat.nick || 'Unknown';
  who.append(nick);

  if (chat.kind !== 'room') {
    const mode = document.createElement('span');
    mode.className = 'badge';
    mode.textContent = ['nickname', 'contact shared', 'throwaway'][chat.idMode] ?? 'unknown';
    who.append(mode);

    const trust = document.createElement('span');
    trust.className = `badge ${chat.verified ? 'ok' : 'bad'}`;
    trust.textContent = chat.verified ? 'signed' : 'unverified';
    who.append(trust);
  }
  card.append(who);

  const details = document.createElement('dl');
  const add = (term, value) => {
    const dt = document.createElement('dt');
    dt.textContent = term;
    const dd = document.createElement('dd');
    dd.textContent = value;
    details.append(dt, dd);
  };
  if (chat.contact) for (const [key, value] of Object.entries(chat.contact)) add(key, value);

  const fingerRow = document.createElement('div');
  if (chat.publicKey) {
    add('key', '…');
    keyFingerprint(Uint8Array.from(chat.publicKeyBytes ?? [])).then((fingerprint) => {
      const values = details.querySelectorAll('dd');
      if (values.length) values[values.length - 1].textContent = fingerprint;
    });
  }
  void fingerRow;
  card.append(details);

  if (chat.sas) {
    const sas = document.createElement('div');
    sas.className = 'sas';
    const emoji = document.createElement('span');
    emoji.className = 'emoji';
    emoji.textContent = chat.sas.emoji.join(' ');
    const digits = document.createElement('span');
    digits.className = 'digits';
    digits.textContent = chat.sas.digits;
    const note = document.createElement('span');
    note.className = 'hint';
    note.textContent = 'Read these aloud on a call you already trust. If they match, nobody is in the middle.';
    sas.append(emoji, digits, note);
    card.append(sas);
  }
}

/* ------------------------------------------------------------------- session */

function wireSession(session) {
  session.addEventListener('statechange', ({ detail }) => {
    if (detail.state === LINK_STATE.CLOSED || detail.state === LINK_STATE.FAILED) {
      stopKeepAlive().catch(() => {});
      // Half-finished files stay on disk, marked as waiting rather than failed:
      // they resume the moment a link is back.
      pauseTransfers().catch(() => {});
      // Remember when they were last around, so the header can say "last seen…".
      const chatId = chatIdForSession(session);
      if (chatId) {
        state.typing.delete(chatId);
        state.chats.setLastSeen(chatId, Date.now()).catch(() => {});
      }
      updateComposerState();
      renderChatHeader();
    }
    if (state.view === 'chat') return;
    if (detail.state === LINK_STATE.FAILED) setDot('failed');
    else if (detail.state === LINK_STATE.CLOSED) setDot('idle');
    else if (detail.state === LINK_STATE.OPEN) setDot('open');
    else setDot('connecting');
  });

  session.addEventListener('open', () => {
    enterConversation();
  });

  session.addEventListener('message', ({ detail }) => routeMessage(session, detail));

  session.addEventListener('frame', ({ detail }) => {
    receiveFileChunk(session, detail.data);
  });

  session.addEventListener('error', ({ detail }) => {
    state.lastError = detail.message;
    setDot('failed');
    toast(detail.message, true);
    el('paste-hint').textContent = detail.message;
    el('paste-hint').className = 'hint bad';
  });

  session.addEventListener('peer', async ({ detail }) => {
    state.peer = detail.invite;
    state.peerVerified = detail.verified;
    if (detail.invite.kind === KIND.OFFER) {
      el('reply-peer').textContent = detail.verified ? detail.invite.nick : 'An unverified contact';
    }
    if (!detail.verified) toast('Warning: this code failed signature verification.', true);
  });

  session.addEventListener('sas', ({ detail }) => {
    state.sas = detail;
    const chat = state.chats.get(chatIdForSession(session));
    if (chat) {
      chat.sas = detail;
      state.chats.save(chat).catch(() => {});
    }
    renderPeerCard();
  });
}

/**
 * Which conversation does this link belong to?
 *
 * Derived from the link itself, never from whichever view happens to be open:
 * a message that arrives while the user is reading the chat list must still land
 * in the right conversation.
 */
function chatIdForSession(session) {
  const local = session?.localInvite;
  const peer = session?.peerInvite;
  const roomId = [local?.roomId, peer?.roomId].find((id) => id && id !== '0');
  if (roomId) return conversationIdForRoom(roomId);
  if (peer) return conversationIdForPeer(hex(peer.publicKey));
  return null;
}

const chatIdForGroup = (group) => (group ? conversationIdForRoom(group.roomId) : null);

/** Every control message, whichever kind of link it arrived on. */
function routeMessage(session, detail) {
  if (detail?.t === 'msg') receiveMessage(session, detail);
  else if (detail?.t === 'ack') receiveAck(session, detail);
  else if (detail?.t === 'ttl') receiveDisappearing(session, detail);
  else if (detail?.t === TRANSFER.OFFER) receiveFileOffer(session, detail);
  else if (detail?.t === TRANSFER.HAVE) receiveFileHave(session, detail);
  else if (detail?.t === TRANSFER.COMPLETE) receiveFileComplete(session, detail);
  else if (detail?.t === TRANSFER.CANCEL) receiveFileCancel(session, detail);
  else if (detail?.t === 'typing') receiveTyping(session, detail);
  else if (detail?.t === TRANSFER.AVAILABLE) receiveAvailable(session, detail);
  else if (detail?.t === TRANSFER.SERVE) receiveServeRequest(session, detail);
}

/** Work out which conversation this link belongs to, and open it. */
function enterConversation(chatId = null) {
  const local = state.session?.localInvite;
  const peer = state.peer;
  const roomId = [local?.roomId, peer?.roomId].find((id) => id && id !== '0');

  const id = chatId ?? chatIdForSession(state.session);
  if (!id) return;

  if (roomId) {
    attachToGroup(id);
    state.chats.ensure({
      id,
      kind: 'room',
      nick: state.group?.label || 'Room',
      memberCount: state.group?.memberCount ?? 1,
    });
  } else if (peer) {
    state.chats.ensure({
      id,
      kind: 'direct',
      nick: peer.nick,
      idMode: peer.idMode,
      contact: peer.contact,
      publicKey: hex(peer.publicKey),
      publicKeyBytes: [...peer.publicKey],
      verified: state.peerVerified,
    });
  }

  state.activeChatId = id;
  startKeepAlive().catch(() => {});
  rememberPeer().catch(() => {});
  state.session?.computeShortAuthString().catch(() => {});

  const chat = state.chats.get(id);
  if (chat) state.chats.save(chat).catch(() => {});

  renderChatHeader();
  renderConversation();
  renderPeerCard();
  renderGroupPanel();
  updateComposerState();
  renderChatList();
  showView('chat');
  el('message-input').focus();

  // Anything still in flight for this conversation picks up where it stopped:
  // re-offering makes the peer answer with what it already holds.
  resumeTransfers(id).catch(() => {});
}

/* ------------------------------------------------------------------ messages */

async function receiveMessage(session, detail) {
  const chat = state.chats.get(chatIdForSession(session));
  if (!chat) return;
  try {
    session.sendJson({ t: 'ack', id: detail.id });
  } catch {
    /* the link died between receiving and answering */
  }

  const unread = !(state.activeChatId === chat.id && state.view === 'chat' && !document.hidden);
  await state.chats.append(
    chat.id,
    makeMessage({
      id: detail.id,
      who: 'them',
      text: String(detail.text ?? ''),
      ts: detail.ts ?? Date.now(),
      disappearingSeconds: chat.disappearing,
      replyTo: detail.replyTo ?? null,
    }),
    { unread },
  );
  if (state.activeChatId === chat.id) renderConversation();
  renderChatList();
}

async function receiveAck(session, detail) {
  const chat = state.chats.get(chatIdForSession(session));
  if (!chat || !detail?.id) return;
  await state.chats.setMessageState(chat.id, detail.id, 'delivered');
  renderConversation();
}

async function sendMessage(text) {
  const trimmed = String(text ?? '').trim();
  const chat = activeChat();
  if (!trimmed || !chat) return;

  if (chat.kind === 'room') {
    if (!state.group || state.group.links.size === 0) {
      toast('Nobody is connected to the room yet.', true);
      return;
    }
    const message = makeMessage({
      who: 'me',
      text: trimmed,
      from: state.group.identity.nick,
      disappearingSeconds: chat.disappearing,
      replyTo: state.replyingTo,
    });
    cancelReply();
    await state.group.sendChat(trimmed);
    await state.chats.append(chat.id, message, { unread: false });
    renderConversation();
    renderChatList();
    return;
  }

  if (!state.session?.isOpen) {
    toast('This chat is not connected right now.', true);
    return;
  }

  const message = makeMessage({
    who: 'me',
    text: trimmed,
    disappearingSeconds: chat.disappearing,
    replyTo: state.replyingTo,
  });
  cancelReply();
  await state.chats.append(chat.id, message, { unread: false });
  renderConversation();
  renderChatList();
  try {
    state.session.sendJson({
      t: 'msg',
      id: message.id,
      text: trimmed,
      ts: message.ts,
      replyTo: message.replyTo ?? null,
    });
  } catch (error) {
    message.state = 'failed';
    await state.chats.save(chat);
    renderConversation();
    toast(`Not sent: ${error.message}`, true);
  }
}

/* ---------------------------------------------------- disappearing messages */

function renderDisappearingOptions() {
  const chat = activeChat();
  const box = el('ttl-options');
  box.innerHTML = '';
  const current = chat?.disappearing ?? 0;
  for (const option of DISAPPEARING_OPTIONS) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'ttl-option';
    button.textContent = option.label;
    button.dataset.seconds = String(option.seconds);
    button.setAttribute('aria-pressed', String(option.seconds === current));
    button.addEventListener('click', () => {
      setDisappearing(option.seconds).catch((error) => toast(error.message, true));
    });
    box.append(button);
  }
  el('ttl-hint').textContent = current
    ? `New messages vanish from both devices ${disappearingLabel(current).toLowerCase()} after they are sent.`
    : 'Off — messages stay on both devices until you clear them.';
}

async function setDisappearing(seconds, { announce = true } = {}) {
  const chat = activeChat();
  if (!chat) return;
  await state.chats.setDisappearing(chat.id, seconds);

  const note = seconds
    ? `You set messages to disappear after ${disappearingLabel(seconds)}.`
    : 'You turned off disappearing messages.';
  await state.chats.append(chat.id, makeMessage({ who: 'system', text: note }), { unread: false });

  if (announce) {
    const frame = { t: 'ttl', seconds };
    try {
      if (chat.kind === 'room' && state.group) state.group.flood(frame);
      else if (state.session?.isOpen) state.session.sendJson(frame);
    } catch {
      /* the peer picks the setting up next time they change it */
    }
  }

  renderConversation();
  renderChatHeader();
  renderDisappearingOptions();
  renderChatList();
}

async function receiveDisappearing(session, detail) {
  const chat = state.chats.get(chatIdForSession(session));
  if (!chat || typeof detail?.seconds !== 'number') return;
  if (chat.disappearing === detail.seconds) return;
  await state.chats.setDisappearing(chat.id, detail.seconds);
  await state.chats.append(
    chat.id,
    makeMessage({
      who: 'system',
      text: detail.seconds
        ? `${chat.nick || 'They'} set messages to disappear after ${disappearingLabel(detail.seconds)}.`
        : `${chat.nick || 'They'} turned off disappearing messages.`,
    }),
    { unread: false },
  );
  renderConversation();
  renderChatHeader();
  renderDisappearingOptions();
}

async function sweepExpired() {
  const changed = await state.chats.sweep();
  if (!changed.length) return;
  renderConversation();
  renderChatList();
}

/* ------------------------------------------------------------------ pairing */

let activeScan = null;

function renderQr(canvas, code, caption) {
  const qr = encodeQr(code, { ecLevel: 'M' });
  drawQrToCanvas(qr, canvas, { quietZone: 4 });
  if (caption) {
    caption.textContent = `Version ${qr.version} (${qr.size}×${qr.size} modules). Point a camera at it — no network needed for this step.`;
  }
  return qr;
}

function stopScanning() {
  activeScan?.stop();
  activeScan = null;
  const scanner = el('scanner');
  if (scanner) scanner.hidden = true;
}

async function beginQrScan() {
  if (activeScan) {
    stopScanning();
    return;
  }
  const capability = scannerCapability();
  if (!capability.supported) {
    toast(capability.explanation, true);
    return;
  }
  el('scanner').hidden = false;
  el('scanner-status').textContent = 'Looking for a code…';
  try {
    activeScan = await startQrScan({
      video: el('scanner-video'),
      onCode: async (code) => {
        stopScanning();
        el('paste-input').value = code;
        try {
          await handleIncomingCode(code);
          el('paste-input').value = '';
        } catch (error) {
          el('paste-hint').textContent = error.message;
          el('paste-hint').className = 'hint bad';
          toast(error.message, true);
        }
      },
      onError: (error) => {
        stopScanning();
        toast(`Scanning stopped: ${error.message}`, true);
      },
    });
  } catch (error) {
    stopScanning();
    toast(error.message, true);
  }
}

async function beginNfcScan() {
  if (activeScan?.kind === 'nfc') {
    activeScan.stop();
    activeScan = null;
    el('btn-tap-nfc').textContent = 'Tap NFC tag';
    return;
  }
  try {
    el('btn-tap-nfc').textContent = 'Waiting for a tap…';
    const stop = await scanForInvite({
      onCode: async (code) => {
        stop();
        activeScan = null;
        el('btn-tap-nfc').textContent = 'Tap NFC tag';
        el('paste-input').value = code;
        try {
          await handleIncomingCode(code);
          el('paste-input').value = '';
        } catch (error) {
          toast(error.message, true);
        }
      },
      onError: (error) => toast(error.message, true),
    });
    activeScan = { kind: 'nfc', stop };
  } catch (error) {
    el('btn-tap-nfc').textContent = 'Tap NFC tag';
    toast(error.message, true);
  }
}

async function writeNfcTag(code) {
  const url = buildInviteLink(location.href.split('#')[0], code);
  el('btn-write-nfc').disabled = true;
  el('btn-write-nfc').textContent = 'Hold against a tag…';
  try {
    await writeInviteToTag(url);
    toast('Tag written. Any phone can now tap it to open this invite.');
  } catch (error) {
    toast(error instanceof NfcError ? error.message : String(error.message ?? error), true);
  } finally {
    el('btn-write-nfc').disabled = false;
    el('btn-write-nfc').textContent = 'Write to NFC tag';
  }
}

function applyPairingCapabilities() {
  const scanner = scannerCapability();
  const nfc = nfcCapability();

  el('btn-scan-qr').hidden = !scanner.supported;
  el('btn-tap-nfc').hidden = !nfc.canRead;
  el('btn-write-nfc').hidden = !nfc.canWrite;

  const notes = [];
  if (!scanner.supported) notes.push(scanner.explanation);
  if (!nfc.supported) notes.push(nfc.explanation);
  el('pairing-capabilities').textContent = notes.join(' ');

  return { scanner, nfc };
}

/**
 * One invite code carries exactly one answer, because each pairing is its own
 * RTCPeerConnection — so a room hands out one code per member. Every code in a
 * room shares the roomId and the identity, which is what lets members recognise
 * each other.
 */
async function createInvite({ group = false, label = '', reuseIdentity = null } = {}) {
  let identity = reuseIdentity;
  if (!identity) {
    const base = await signingIdentity();
    identity = {
      ...base,
      roomId: group ? randomRoomId() : '0',
      groupLabel: group ? String(label).slice(0, 40) : '',
    };
  }

  const session = new PairingSession({ identity });
  wireSession(session);
  state.session = session;

  if (!reuseIdentity) {
    state.group = null;
    state.groupIdentity = null;
    if (group) {
      state.groupIdentity = identity;
      state.group = new GroupSession({
        identity,
        roomId: identity.roomId,
        label: identity.groupLabel,
        isHost: true,
      });
      wireGroup(state.group);
    }
  }

  const { code } = await session.createOffer({ roomId: identity.roomId, groupLabel: identity.groupLabel });
  if (!reuseIdentity) state.identity.discardBurnerKey();

  el('invite-code').value = code;
  renderQr(el('qr-canvas'), code, el('qr-caption'));
  el('invite-result').hidden = false;
  el('paste-heading').textContent = '2. Paste their reply';
  el('btn-paste').textContent = 'Complete connection';
  el('paste-hint').className = 'hint';
  el('paste-hint').textContent =
    group || reuseIdentity
      ? 'Send this code to one person. When they send their reply back, paste it here — then invite the next one.'
      : 'Send the code above, then paste the reply they send back.';
  el('connect-heading').textContent = group ? 'Invite someone to the room' : 'Start a private chat';
  showView('connect');
  setDot('connecting');
  return code;
}

async function inviteAnother() {
  if (!state.groupIdentity) throw new Error('there is no room to invite into');
  await createInvite({ reuseIdentity: state.groupIdentity });
}

async function handleIncomingCode(text) {
  const opened = await openInvite(text);

  if (!opened.verified) {
    throw new Error(
      'This code failed its signature check. It was altered or forged in transit — ask for a fresh one.',
    );
  }

  const age = inviteAgeSeconds(opened.invite);
  if (age > INVITE_STALE_SECONDS) {
    toast(`That invite is ${Math.round(age / 60)} minutes old. Ask for a fresh one if it fails.`, true);
  }

  if (opened.invite.kind === KIND.ANSWER) {
    if (!state.session || state.session.localInvite?.kind !== KIND.OFFER) {
      throw new Error(
        'That is a reply code, but this screen has no invite waiting for it. The invite and its reply must meet in the same place — reloading loses the connection state.',
      );
    }
    await state.session.acceptAnswer(text);
    el('paste-hint').textContent = 'Reply accepted. Finishing the handshake…';
    el('paste-hint').className = 'hint';
    setDot('connecting');
    return { kind: 'answer' };
  }

  // Only a handshake that is still in progress blocks a new one. A finished or
  // dropped session must not, or pairing again would need a page reload.
  const existing = state.session;
  const midHandshake =
    existing?.localInvite?.kind === KIND.OFFER &&
    !existing.peerInvite &&
    existing.state !== LINK_STATE.CLOSED &&
    existing.state !== LINK_STATE.FAILED;
  if (midHandshake) {
    throw new Error('This window is already waiting for a reply. Finish that one, or open a new tab.');
  }
  const identity = await signingIdentity();
  const session = new PairingSession({ identity });
  wireSession(session);
  state.session = session;
  const { code } = await session.acceptOffer(text);

  el('reply-code').value = code;
  renderQr(el('reply-qr'), code, null);
  showView('reply');
  setDot('connecting');
  return { kind: 'offer', code };
}

/* -------------------------------------------------------------------- groups */

function wireGroup(group) {
  // Mesh links live inside the group, so their application messages arrive here.
  group.addEventListener('peer-message', ({ detail }) => {
    routeMessage(detail.session, detail.message);
  });
  group.addEventListener('message', async ({ detail }) => {
    const chat = state.chats.get(chatIdForGroup(group));
    if (!chat || chat.kind !== 'room') return;
    const unread = !(state.activeChatId === chat.id && state.view === 'chat' && !document.hidden);
    await state.chats.append(
      chat.id,
      makeMessage({
        who: 'them',
        text: detail.text,
        from: detail.nick,
        ts: detail.ts,
        disappearingSeconds: chat.disappearing,
      }),
      { unread },
    );
    renderConversation();
    renderChatList();
  });
  group.addEventListener('members', () => {
    renderGroupPanel();
    renderChatHeader();
    updateComposerState();
  });
  group.addEventListener('warning', ({ detail }) => toast(detail.message));
}

function attachToGroup(chatId) {
  const local = state.session?.localInvite;
  const peer = state.peer;
  const roomId = [local?.roomId, peer?.roomId].find((id) => id && id !== '0');
  if (!roomId) return null;

  if (!state.group) {
    state.group = new GroupSession({
      identity: state.session.identity,
      roomId,
      label: local?.groupLabel || peer?.groupLabel || '',
      isHost: local?.kind === KIND.OFFER,
    });
    wireGroup(state.group);
  }
  try {
    state.group.attach(state.session);
  } catch (error) {
    toast(`Could not join the room: ${error.message}`, true);
  }
  const chat = state.chats.get(chatId);
  if (chat) {
    chat.nick = state.group.label || chat.nick || 'Room';
    chat.memberCount = state.group.memberCount;
  }
  renderGroupPanel();
  return state.group;
}

function renderGroupPanel() {
  const card = el('group-card');
  const chat = activeChat();
  if (!state.group || !chat || chat.kind !== 'room') {
    card.hidden = true;
    return;
  }
  card.hidden = false;
  card.innerHTML = '';

  const members = state.group.membersList();
  const online = members.filter((m) => m.online && !m.isSelf).length;
  const summary = document.createElement('span');
  summary.textContent = `${members.length} in room · ${online} online`;
  card.append(summary);

  if (state.group.isHost) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'secondary';
    button.id = 'btn-invite-another';
    button.style.flex = 'none';
    button.style.marginLeft = 'auto';
    button.textContent = '+ Invite';
    button.addEventListener('click', () => {
      inviteAnother().catch((error) => toast(error.message, true));
    });
    card.append(button);
  }
}


/* -------------------------------------------------------------------- media */

const mediaUrls = new Map();

/** A blob URL per stored file, created once and reused by every render. */
async function mediaUrl(fileId) {
  if (mediaUrls.has(fileId)) return mediaUrls.get(fileId);
  const record = await state.transfers.getMedia(fileId);
  if (!record?.blob) return null;
  const url = URL.createObjectURL(record.blob);
  mediaUrls.set(fileId, url);
  return url;
}

const sendControl = (session, message) => {
  try {
    if (session?.isOpen) session.sendJson(message);
  } catch {
    /* the link died; the transfer stays pending and resumes on reconnect */
  }
};

function findMessageByFileId(chatId, fileId) {
  const chat = state.chats.get(chatId);
  return chat?.messages.find((message) => message.attachment?.fileId === fileId) ?? null;
}

async function patchAttachment(chatId, messageId, patch, { persist = true } = {}) {
  const chat = state.chats.get(chatId);
  const message = chat?.messages.find((entry) => entry.id === messageId);
  if (!message?.attachment) return null;
  Object.assign(message.attachment, patch);
  if (persist) await state.chats.save(chat);
  if (state.activeChatId === chatId) renderConversation();
  return message;
}

const setProgress = (chatId, messageId, progress, status) =>
  patchAttachment(chatId, messageId, { progress, status }, { persist: false });

const failAttachment = (chatId, messageId, reason) =>
  patchAttachment(chatId, messageId, { status: 'failed', error: reason, progress: 0 });

/**
 * Hash and inspect a file before offering it.
 *
 * The digest is the file's identity, which is what makes resume possible: after
 * a dropped link both sides refer to the same file by the same name, and a file
 * the peer already has never travels twice.
 */
async function prepareAttachment(file, { onProgress } = {}) {
  if (file.size > MAX_FILE_BYTES) {
    throw new Error(`${formatBytes(file.size)} is larger than the ${formatBytes(MAX_FILE_BYTES)} limit`);
  }
  const kind = kindFor(file.type, file.name);
  // One read produces both the file's identity and the per-piece manifest that
  // lets a receiver verify chunks as they land.
  const { hex, pieceSize, pieceHashes } = await hashBlob(file, { onProgress });
  const preview = await makeThumbnail(file);

  return {
    fileId: hex,
    digest: hex,
    pieceSize,
    pieceHashes,
    kind,
    name: file.name || `attachment.${extensionFor(file.type, file.name)}`,
    mime: file.type || 'application/octet-stream',
    size: file.size,
    chunkSize: CHUNK_SIZE,
    chunks: chunkCount(file.size),
    thumb: preview?.thumb ?? null,
    width: preview?.width ?? null,
    height: preview?.height ?? null,
    duration: preview?.duration ?? null,
  };
}

async function sendAttachment(chatId, file, offer, caption = '') {
  const chat = state.chats.get(chatId);
  if (!chat) return null;

  // In a room the file is offered to every direct link. Members who already hold
  // it (from an earlier share) can then serve most of it to each other, so the
  // work is spread rather than all of it coming from one uplink.
  if (chat.kind === 'room') {
    const links = [...(state.group?.links ?? new Map())];
    if (!links.length) {
      toast('Nobody is connected to the room yet.', true);
      return null;
    }
    const message = makeMessage({
      who: 'me',
      text: caption,
      disappearingSeconds: chat.disappearing,
      attachment: { ...offer, direction: 'out', progress: 0, status: 'pending' },
    });
    await state.chats.append(chatId, message, { unread: false });

    for (const [peerKey, link] of links) {
      const transferId = makeTransferId();
      const record = {
        direction: 'out',
        fileId: offer.fileId,
        peerKey,
        chatId,
        messageId: message.id,
        offer,
        caption,
        file,
        transferId,
        startedAt: Date.now(),
      };
      await state.transfers.saveOutgoing(record);
      sendControl(link, { t: TRANSFER.OFFER, transferId, caption, ...offer });
    }
    // Everyone is offering us the same file back? No: we are the source here.
    state.holders.set(offer.fileId, new Set([myKeyHex()].filter(Boolean)));
    if (state.activeChatId === chatId) renderConversation();
    renderChatList();
    return message;
  }

  if (!state.session?.isOpen) {
    toast('This chat is not connected right now.', true);
    return null;
  }

  const message = makeMessage({
    who: 'me',
    text: caption,
    // The timer applies to files exactly as it does to text.
    disappearingSeconds: chat.disappearing,
    attachment: { ...offer, direction: 'out', progress: 0, status: 'pending' },
  });
  await state.chats.append(chatId, message, { unread: false });

  const record = {
    direction: 'out',
    fileId: offer.fileId,
    chatId,
    messageId: message.id,
    offer,
    caption,
    file,
    startedAt: Date.now(),
  };
  await state.transfers.saveOutgoing(record);

  const transferId = makeTransferId();
  record.transferId = transferId;
  await state.transfers.saveOutgoing(record);
  sendControl(state.session, { t: TRANSFER.OFFER, transferId, caption, ...offer });

  if (state.activeChatId === chatId) renderConversation();
  renderChatList();
  return message;
}

/** The peer told us what it already holds; send only the gaps. */
async function receiveFileHave(session, msg) {
  const chatId = chatIdForSession(session);
  const peerKey = session?.peerInvite ? hex(session.peerInvite.publicKey) : null;
  const record = state.transfers
    .outgoingFor(chatId)
    .find((entry) => entry.fileId === msg.fileId && (!entry.peerKey || entry.peerKey === peerKey));
  if (!record) return;

  const total = record.offer.chunks;
  const held = decodeBitmap(msg.bitmap ? b64urlDecode(msg.bitmap) : null, total);
  await pumpOutgoing(session, chatId, record, held, msg.transferId ?? record.transferId);
}

async function pumpOutgoing(session, chatId, record, held, transferId) {
  const channel = session.channel;
  if (!channel || channel.readyState !== 'open') return;

  const total = record.offer.chunks;
  await patchAttachment(
    chatId,
    record.messageId,
    { status: held.size ? 'sending' : 'sending', progress: held.size / total },
    { persist: false },
  );

  const transfer = new OutgoingTransfer({
    transferId,
    size: record.offer.size,
    chunkSize: record.offer.chunkSize,
    readChunk: async (offset, length) =>
      new Uint8Array(await record.file.slice(offset, offset + length).arrayBuffer()),
    send: (frame) => channel.send(frame),
    waitForDrain: channelDrain(channel),
    onProgress: (progress) => setProgress(chatId, record.messageId, progress, 'sending'),
    onError: (error) => failAttachment(chatId, record.messageId, error.message),
  });

  state.sending.set(record.fileId, transfer);
  state.stats.runs += 1;
  if (held.size) state.stats.resumed += 1;

  const finished = await transfer.run({ held });
  state.sending.delete(record.fileId);

  state.stats.sentBytes += transfer.sentBytes;
  state.stats.skippedBytes += transfer.skippedBytes;

  if (finished) {
    // All the bytes are out, but the file is not delivered until the other side
    // says it reassembled and verified them.
    await patchAttachment(chatId, record.messageId, { progress: 1, status: 'waiting' }, { persist: false });
  }
}

async function receiveFileOffer(session, msg) {
  const chatId = chatIdForSession(session);
  const chat = state.chats.get(chatId);
  if (!chat || !msg?.fileId || typeof msg.size !== 'number') return;

  const chunkSize = msg.chunkSize ?? CHUNK_SIZE;
  const offer = {
    fileId: msg.fileId,
    digest: msg.digest ?? msg.fileId,
    kind: msg.kind ?? kindFor(msg.mime, msg.name),
    name: msg.name ?? 'file',
    mime: msg.mime ?? 'application/octet-stream',
    size: msg.size,
    chunkSize,
    chunks: msg.chunks ?? chunkCount(msg.size, chunkSize),
    // The manifest travels with the offer: without it a chunk fetched from a
    // third peer could not be checked until the whole file was in.
    pieceSize: msg.pieceSize ?? null,
    pieceHashes: msg.pieceHashes ?? null,
    thumb: msg.thumb ?? null,
    width: msg.width ?? null,
    height: msg.height ?? null,
    duration: msg.duration ?? null,
  };

  let message = findMessageByFileId(chatId, offer.fileId);
  if (!message) {
    message = makeMessage({
      who: 'them',
      text: msg.caption ?? '',
      disappearingSeconds: chat.disappearing,
      attachment: { ...offer, direction: 'in', progress: 0, status: 'pending' },
    });
    const unread = !(state.activeChatId === chatId && state.view === 'chat' && !document.hidden);
    await state.chats.append(chatId, message, { unread });
  } else if (message.attachment.status !== 'complete') {
    await patchAttachment(chatId, message.id, { status: 'pending', progress: 0 });
  }

  await state.transfers.saveIncoming({
    direction: 'in',
    fileId: offer.fileId,
    chatId,
    messageId: message.id,
    offer,
    startedAt: Date.now(),
  });

  // Already have this exact file: nothing needs to move.
  if (await state.transfers.hasMedia(offer.fileId)) {
    sendControl(session, { t: TRANSFER.COMPLETE, fileId: offer.fileId });
    await completeIncoming(chatId, message.id, offer);
    return;
  }

  // In a room, other members may already hold this file: take shares from them
  // and tell the original sender to skip what they are covering.
  let held = await state.transfers.heldSequences(offer.fileId);
  let claimed = held;
  if (state.group && chat.kind === 'room') {
    claimed = await requestFromPeers(offer);
  }
  sendControl(session, {
    t: TRANSFER.HAVE,
    fileId: offer.fileId,
    transferId: msg.transferId,
    bitmap: b64urlEncode(encodeBitmap(claimed, offer.chunks)),
  });

  const transfer = new IncomingTransfer({
    offer,
    onProgress: (progress) => setProgress(chatId, message.id, progress, 'receiving'),
    onComplete: () => finishIncoming(session, chatId, message.id, offer),
    onError: (error) => failAttachment(chatId, message.id, error.message),
  });
  transfer.seed(held);

  state.receiving.set(msg.transferId, { transfer, chatId, messageId: message.id, offer });
  if (transfer.progress >= 1) await finishIncoming(session, chatId, message.id, offer);
  if (state.activeChatId === chatId) renderConversation();
}

function receiveFileChunk(session, data) {
  let frame;
  try {
    frame = readFrame(data);
  } catch {
    return;
  }
  const entry = state.receiving.get(frame.transferId);
  if (!entry) return;

  // The write is queued *before* the chunk is accepted: accepting the last chunk
  // fires completion, which reads the file back from storage, and it must not
  // run before the final write has been queued. Re-writing a duplicate is
  // harmless. Bytes are copied out of the frame buffer rather than pinning the
  // whole packet.
  const bytes = frame.payload.slice();
  entry.writes = (entry.writes ?? Promise.resolve()).then(() =>
    state.transfers.putChunk(entry.offer.fileId, frame.sequence, bytes),
  );

  entry.transfer.accept(frame.sequence, frame.payload);
}

/** Reassemble, verify against the digest, and only then call it delivered. */
async function finishIncoming(session, chatId, messageId, offer) {
  const entry = state.receiving.get(offer.transferId) ?? [...state.receiving.values()].find((e) => e.offer.fileId === offer.fileId);
  try {
    await entry?.writes;
    const blob = await state.transfers.assemble(offer.fileId, { total: offer.chunks, mime: offer.mime });
    const { hex } = await hashBlob(blob);

    if (hex !== offer.digest) {
      await state.transfers.dropChunks(offer.fileId);
      await failAttachment(chatId, messageId, 'the file did not arrive intact');
      sendControl(session, { t: TRANSFER.CANCEL, fileId: offer.fileId, reason: 'digest-mismatch' });
      return;
    }

    await state.transfers.putMedia(offer.fileId, blob, { mime: offer.mime, name: offer.name });
    await state.transfers.dropChunks(offer.fileId);
    await completeIncoming(chatId, messageId, offer);
    sendControl(session, { t: TRANSFER.COMPLETE, fileId: offer.fileId });
  } catch (error) {
    await failAttachment(chatId, messageId, error.message);
  } finally {
    for (const [id, value] of state.receiving) {
      if (value.offer.fileId === offer.fileId) state.receiving.delete(id);
    }
  }
}

async function completeIncoming(chatId, messageId, offer) {
  await patchAttachment(chatId, messageId, { status: 'complete', progress: 1 });
  await state.transfers.removeIncoming(offer.fileId);
  // Having the file makes us a source for it.
  announceAvailability(chatId, offer);
  renderChatList();
  if (state.activeChatId === chatId) renderConversation();
}

async function receiveFileComplete(session, msg) {
  const chatId = chatIdForSession(session);
  if (!chatId || !msg?.fileId) return;
  const peerKey = session?.peerInvite ? hex(session.peerInvite.publicKey) : null;
  const record = state.transfers
    .outgoingFor(chatId)
    .find((entry) => entry.fileId === msg.fileId && (!entry.peerKey || entry.peerKey === peerKey));
  if (!record) return;
  await patchAttachment(chatId, record.messageId, { status: 'complete', progress: 1 });
  await state.transfers.removeOutgoing(msg.fileId, record.peerKey ?? null);
  state.stats.completed += 1;
  renderChatList();
}

async function receiveFileCancel(session, msg) {
  const chatId = chatIdForSession(session);
  if (!chatId || !msg?.fileId) return;
  const record = state.transfers.outgoingFor(chatId).find((entry) => entry.fileId === msg.fileId);
  if (record) {
    await failAttachment(chatId, record.messageId, msg.reason === 'digest-mismatch' ? 'the file did not arrive intact' : 'the transfer was cancelled');
    await state.transfers.removeOutgoing(msg.fileId);
  }
}

/**
 * Re-offer anything unfinished for this conversation.
 *
 * The peer answers with what it holds, so a transfer that was half done before
 * the link dropped continues from there rather than starting again.
 */
async function resumeTransfers(chatId) {
  if (!chatId) return;
  for (const record of state.transfers.outgoingFor(chatId)) {
    // In a room each record belongs to one member's link; in a direct chat there
    // is only the one link.
    const link = record.peerKey && state.group
      ? state.group.links.get(record.peerKey)
      : state.session;
    if (!link?.isOpen) continue;
    const transferId = makeTransferId();
    record.transferId = transferId;
    await state.transfers.saveOutgoing(record);
    sendControl(link, { t: TRANSFER.OFFER, transferId, caption: record.caption, ...record.offer });
    await patchAttachment(chatId, record.messageId, { status: 'pending' }, { persist: false });
  }
}

/**
 * The link went away: stop live sends and leave received chunks on disk.
 *
 * The partial data is the whole point — it is what the peer will be told about
 * when the two reconnect, so the transfer continues instead of restarting.
 */
async function pauseTransfers() {
  for (const transfer of state.sending.values()) transfer.cancel();
  state.sending.clear();

  for (const [transferId, entry] of [...state.receiving]) {
    state.receiving.delete(transferId);
    await patchAttachment(entry.chatId, entry.messageId, { status: 'pending' }, { persist: false });
  }
  if (state.activeChatId) renderConversation();
}

/** Attachments that were mid-flight when the app closed. */
async function markInterruptedTransfers() {
  for (const chat of state.chats.list()) {
    for (const record of state.transfers.outgoingFor(chat.id)) {
      await patchAttachment(chat.id, record.messageId, { status: 'pending', progress: 0 });
    }
    for (const record of state.transfers.incomingFor(chat.id)) {
      await patchAttachment(chat.id, record.messageId, { status: 'pending' });
    }
  }
}


const FILE_ICONS = { image: '🖼', video: '🎬', audio: '🎵', file: '📄' };

/** One attachment inside a bubble: the media itself, or its progress. */
function renderAttachment(attachment, message) {
  const wrap = document.createElement('div');
  wrap.className = `media ${attachment.kind}`;

  const complete = attachment.status === 'complete';
  const shell = document.createElement('div');
  shell.className = 'media-shell';

  if (attachment.kind === 'image' && (complete || attachment.thumb)) {
    const img = document.createElement('img');
    img.alt = attachment.name || 'photo';
    img.loading = 'lazy';
    if (attachment.thumb) img.src = attachment.thumb;
    if (complete) {
      mediaUrl(attachment.fileId).then((url) => {
        if (url) img.src = url;
      });
      img.addEventListener('click', () => openLightbox(attachment.fileId, attachment.name));
    }
    shell.append(img);
  } else if (attachment.kind === 'video' && complete) {
    const video = document.createElement('video');
    video.controls = true;
    video.playsInline = true;
    video.preload = 'metadata';
    if (attachment.thumb) video.poster = attachment.thumb;
    mediaUrl(attachment.fileId).then((url) => {
      if (url) video.src = url;
    });
    shell.append(video);
  } else if (attachment.kind === 'audio' && complete) {
    const audio = document.createElement('audio');
    audio.controls = true;
    mediaUrl(attachment.fileId).then((url) => {
      if (url) audio.src = url;
    });
    shell.append(audio);
  } else {
    shell.append(fileCard(attachment));
  }

  if (!complete) shell.append(progressOverlay(attachment));
  wrap.append(shell);

  if (!complete && attachment.status === 'failed') {
    const note = document.createElement('span');
    note.className = 'media-note bad';
    note.textContent = attachment.error ? `Failed: ${attachment.error}` : 'Failed';
    wrap.append(note);
  } else if (attachment.status === 'waiting') {
    const note = document.createElement('span');
    note.className = 'media-note';
    note.textContent = 'Sent — waiting for confirmation';
    wrap.append(note);
  } else if (attachment.status === 'pending' && !attachment.progress) {
    const note = document.createElement('span');
    note.className = 'media-note';
    note.textContent = state.session?.isOpen ? 'Waiting…' : 'Paused — resumes when reconnected';
    wrap.append(note);
  }

  return wrap;
}

function fileCard(attachment) {
  const card = document.createElement('a');
  card.className = 'file-card';
  card.download = attachment.name || 'file';
  if (attachment.status === 'complete') {
    mediaUrl(attachment.fileId).then((url) => {
      if (url) card.href = url;
    });
  } else {
    card.removeAttribute('href');
  }

  const icon = document.createElement('span');
  icon.className = 'file-icon';
  icon.textContent = FILE_ICONS[attachment.kind] ?? FILE_ICONS.file;

  const meta = document.createElement('span');
  meta.className = 'file-meta';
  const name = document.createElement('span');
  name.className = 'file-name';
  name.textContent = attachment.name || 'file';
  const size = document.createElement('span');
  size.className = 'file-size';
  size.textContent = formatBytes(attachment.size);
  meta.append(name, size);

  card.append(icon, meta);
  return card;
}

function progressOverlay(attachment) {
  const overlay = document.createElement('div');
  overlay.className = `media-progress${attachment.progress ? '' : ' paused'}`;

  const bar = document.createElement('div');
  bar.className = 'bar';
  const fill = document.createElement('i');
  fill.style.width = `${Math.round((attachment.progress ?? 0) * 100)}%`;
  bar.append(fill);

  const pct = document.createElement('span');
  pct.className = 'pct';
  const percent = Math.round((attachment.progress ?? 0) * 100);
  pct.textContent =
    attachment.status === 'failed'
      ? '✕'
      : attachment.status === 'waiting'
        ? '✓'
        : percent > 0
          ? `${percent}%`
          : '⋯';

  overlay.append(bar, pct);
  return overlay;
}

function openLightbox(fileId, name) {
  mediaUrl(fileId).then((url) => {
    if (!url) return;
    el('lightbox-image').src = url;
    el('lightbox-image').alt = name || 'photo';
    el('lightbox').hidden = false;
  });
}


/* --------------------------------------------------------------- gestures */

/** Long press on touch, right click on a mouse: one action, two triggers. */
function onLongPress(element, handler, { delay = 480 } = {}) {
  let timer = null;
  let startX = 0;
  let startY = 0;
  const cancel = () => {
    clearTimeout(timer);
    timer = null;
  };

  element.addEventListener('pointerdown', (event) => {
    if (event.button !== undefined && event.button !== 0) return;
    startX = event.clientX;
    startY = event.clientY;
    cancel();
    timer = setTimeout(() => {
      timer = null;
      // A long press should not also register as a tap.
      element.dataset.suppressClick = '1';
      setTimeout(() => delete element.dataset.suppressClick, 600);
      handler(event);
    }, delay);
  });
  element.addEventListener('pointermove', (event) => {
    if (!timer) return;
    if (Math.abs(event.clientX - startX) > 8 || Math.abs(event.clientY - startY) > 8) cancel();
  });
  for (const type of ['pointerup', 'pointercancel', 'pointerleave', 'scroll']) {
    element.addEventListener(type, cancel, { passive: true });
  }
  element.addEventListener('contextmenu', (event) => {
    event.preventDefault();
    cancel();
    handler(event);
  });
  element.addEventListener(
    'click',
    (event) => {
      if (element.dataset.suppressClick) {
        event.preventDefault();
        event.stopPropagation();
      }
    },
    true,
  );
}

/* ------------------------------------------------------------ context menus */

function openSheet(id) {
  el(id).hidden = false;
}

function closeSheet(id) {
  el(id).hidden = true;
}

function openChatMenu(chatId) {
  const chat = state.chats.get(chatId);
  if (!chat) return;
  state.menuChatId = chatId;
  el('chat-menu-title').textContent = chat.nick || 'Chat';
  el('row-pin').textContent = chat.pinned ? 'Unpin' : 'Pin';
  el('row-read').hidden = chat.unread === 0;
  openSheet('chat-menu');
}

function openMessageMenu(messageId) {
  const chat = activeChat();
  const message = chat?.messages.find((entry) => entry.id === messageId);
  if (!message) return;
  state.menuMessageId = messageId;
  el('message-menu-title').textContent = message.who === 'me' ? 'You' : chat.nick || 'Message';
  el('msg-copy').hidden = !message.text;
  el('msg-star').textContent = message.starred ? 'Unstar' : 'Star';
  el('msg-reply').hidden = message.who === 'system';
  openSheet('message-menu');
}

/** One line describing a message, for quoting it. */
function quotePreview(message) {
  if (message.attachment) {
    const kind = message.attachment.kind;
    const label = kind === 'image' ? 'Photo' : kind === 'video' ? 'Video' : kind === 'audio' ? 'Voice message' : message.attachment.name || 'Document';
    const icon = kind === 'image' ? '📷' : kind === 'video' ? '🎬' : kind === 'audio' ? '🎵' : '📄';
    return message.text ? `${icon} ${message.text}` : `${icon} ${label}`;
  }
  const text = String(message.text ?? '');
  return text.length > 120 ? `${text.slice(0, 120)}…` : text;
}

function beginReply(messageId) {
  const chat = activeChat();
  const message = chat?.messages.find((entry) => entry.id === messageId);
  if (!message) return;
  state.replyingTo = {
    id: message.id,
    nick: message.who === 'me' ? 'You' : message.from || chat.nick || 'Them',
    preview: quotePreview(message),
  };
  el('reply-quote').innerHTML = '';
  const who = document.createElement('strong');
  who.textContent = state.replyingTo.nick;
  const text = document.createElement('span');
  text.textContent = state.replyingTo.preview;
  el('reply-quote').append(who, text);
  el('reply-bar').hidden = false;
  el('message-input').focus();
}

function cancelReply() {
  state.replyingTo = null;
  el('reply-bar').hidden = true;
}

/* ---------------------------------------------------------------- emoji */

const EMOJI = [
  '😀','😃','😄','😁','😆','😅','😂','🙂','🙃','😉','😊','😇',
  '🥰','😍','🤩','😘','😗','😚','😙','😋','😛','😜','🤪','🤨',
  '🧐','🤓','😎','🥳','😏','😒','😞','😔','😟','😕','🙁','😣',
  '😖','😫','😩','🥺','😢','😭','😤','😠','😡','🤯','😳','🥵',
  '😱','😨','😰','😥','😓','🤗','🤔','🤭','🤫','🤥','😶','😐',
  '👍','👎','👌','✌️','🤞','🤝','🙏','👏','🙌','💪','🫶','👋',
  '❤️','🧡','💛','💚','💙','💜','🖤','🤍','💔','❣️','💕','💯',
  '🔥','✨','🎉','🎊','🥂','🍕','☕','🌙','⭐','🌈','☀️','🌧️',
];

function renderEmojiPicker() {
  const picker = el('emoji-picker');
  if (picker.childElementCount) return;
  for (const emoji of EMOJI) {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = emoji;
    button.addEventListener('click', () => {
      const input = el('message-input');
      const start = input.selectionStart ?? input.value.length;
      input.value = `${input.value.slice(0, start)}${emoji}${input.value.slice(input.selectionEnd ?? start)}`;
      input.selectionStart = input.selectionEnd = start + emoji.length;
      input.focus();
      noteTyping();
    });
    picker.append(button);
  }
}

/* ------------------------------------------------------------- typing state */

let typingSentAt = 0;
let typingStopTimer = null;

function noteTyping() {
  const chat = activeChat();
  if (!chat || chat.kind === 'room') return;
  const now = Date.now();
  // One notice every couple of seconds is plenty; the peer only needs to know
  // that someone is there.
  if (now - typingSentAt > 2000) {
    typingSentAt = now;
    sendControl(state.session, { t: 'typing', on: true });
  }
  clearTimeout(typingStopTimer);
  typingStopTimer = setTimeout(() => {
    typingSentAt = 0;
    sendControl(state.session, { t: 'typing', on: false });
  }, 2500);
}

function receiveTyping(session, detail) {
  const chatId = chatIdForSession(session);
  if (!chatId) return;
  if (detail.on) state.typing.set(chatId, true);
  else state.typing.delete(chatId);
  if (state.activeChatId === chatId) renderChatHeader();
}


/* ------------------------------------------------------------------- swarm */

/**
 * Rooms are the only place with more than one source, so this is where fetching
 * from several peers at once applies. A one-to-one chat has one peer; there is
 * nothing to spread the work over, and the parallelism there lives inside the
 * link instead.
 */
const myKeyHex = () => (state.group ? state.group.myKey : null);

function noteHolder(fileId, peerKey) {
  if (!state.holders.has(fileId)) state.holders.set(fileId, new Set());
  state.holders.get(fileId).add(peerKey);
}

/** Tell the room we have the whole file, so others can fetch it from us. */
function announceAvailability(chatId, offer) {
  if (!state.group || chatId !== chatIdForGroup(state.group)) return;
  state.group.flood({
    t: TRANSFER.AVAILABLE,
    fileId: offer.fileId,
    size: offer.size,
    chunkSize: offer.chunkSize,
    pieceSize: offer.pieceSize ?? null,
    pieceHashes: offer.pieceHashes ?? null,
    name: offer.name,
    mime: offer.mime,
  });
  noteHolder(offer.fileId, myKeyHex());
}

function receiveAvailable(session, msg) {
  if (!msg?.fileId || !state.group) return;
  const from = state.group.members.get?.(session?.peerInvite && hex(session.peerInvite.publicKey));
  const key = session?.peerInvite ? hex(session.peerInvite.publicKey) : null;
  if (!key) return;
  void from;
  noteHolder(msg.fileId, key);
}

/** Somebody asked us for chunks: read them out of storage and send them. */
async function receiveServeRequest(session, msg) {
  if (!msg?.fileId || !Array.isArray(msg.sequences) || !msg.sequences.length) return;
  const record = await state.transfers.getMedia(msg.fileId);
  if (!record?.blob) return;

  const key = `${msg.fileId}:${msg.transferId}`;
  const controller = { cancelled: false };
  state.serving.set(key, controller);

  try {
    await serveChunks({
      blob: record.blob,
      fileId: msg.fileId,
      transferId: msg.transferId,
      sequences: msg.sequences,
      chunkSize: msg.chunkSize ?? CHUNK_SIZE,
      send: (frame) => session.channel?.send(frame),
      waitForDrain: session.channel ? channelDrain(session.channel) : async () => {},
      isCancelled: () => controller.cancelled || !session.isOpen,
    });
    state.stats.served += msg.sequences.length;
    sendControl(session, { t: TRANSFER.SERVED, fileId: msg.fileId, transferId: msg.transferId });
  } finally {
    state.serving.delete(key);
  }
}

/**
 * Ask other members for a share of the file, and report which sequences are
 * covered so the original sender can skip them.
 */
async function requestFromPeers(offer) {
  if (!state.group) return new Set();
  const holders = [...(state.holders.get(offer.fileId) ?? [])].filter(
    (key) => key !== myKeyHex() && state.group.links.has(key),
  );
  const covered = new Set(await state.transfers.heldSequences(offer.fileId));
  if (!holders.length) return covered;

  const missing = [];
  for (let sequence = 0; sequence < offer.chunks; sequence++) {
    if (!covered.has(sequence)) missing.push(sequence);
  }
  if (!missing.length) return covered;

  const entry = [...state.receiving.values()].find((value) => value.offer.fileId === offer.fileId);
  const plan = planSources(missing, holders);

  for (const [peerKey, sequences] of plan) {
    const link = state.group.links.get(peerKey);
    if (!link) continue;
    // The chunks we are about to fetch elsewhere are declared as "held" to the
    // original sender, so it does not send them as well.
    for (const sequence of sequences) covered.add(sequence);

    for (const batch of toBatches(sequences)) {
      const transferId = makeTransferId();
      if (entry) state.receiving.set(transferId, entry);
      sendControl(link, { t: TRANSFER.SERVE, fileId: offer.fileId, transferId, sequences: batch, chunkSize: offer.chunkSize });
    }
  }
  return covered;
}

/* ------------------------------------------------------- choosing and sending */

async function queueAttachments(files) {
  const list = [...files].filter(Boolean);
  if (!list.length) return;
  if (!activeChat()) {
    toast('Open a chat first.', true);
    return;
  }

  state.pendingAttachments = [];
  el('preview-list').innerHTML = '';
  el('preview-caption').value = '';
  el('preview-backdrop').hidden = false;

  for (const file of list) {
    const item = document.createElement('div');
    item.className = 'preview-item';
    const thumb = document.createElement('div');
    thumb.className = 'thumb';
    thumb.textContent = FILE_ICONS[kindFor(file.type, file.name)] ?? FILE_ICONS.file;
    const label = document.createElement('div');
    label.className = 'label';
    label.textContent = `${file.name || 'file'} · ${formatBytes(file.size)}`;
    item.append(thumb, label);
    el('preview-list').append(item);

    // Hashing is the slow part for a big file, so always show that it is
    // happening — and when it is done, which is what a caller waits for.
    const status = document.createElement('div');
    status.className = 'spinner';
    status.textContent = 'preparing…';
    item.append(status);

    try {
      const offer = await prepareAttachment(file, {
        onProgress: (progress) => {
          status.textContent = `preparing… ${Math.round(progress * 100)}%`;
        },
      });
      status.className = 'done';
      status.textContent = `${formatBytes(offer.size)} · ${offer.chunks} chunk${offer.chunks === 1 ? '' : 's'}`;
      if (offer.thumb) {
        thumb.textContent = '';
        const img = document.createElement('img');
        img.src = offer.thumb;
        img.alt = '';
        thumb.append(img);
      }
      state.pendingAttachments.push({ file, offer });
    } catch (error) {
      status.className = 'spinner';
      status.textContent = error.message;
    }
  }

  if (!state.pendingAttachments.length) {
    el('preview-backdrop').hidden = true;
    toast('Nothing could be prepared from that selection.', true);
  }
}

async function sendPendingAttachments() {
  const chat = activeChat();
  const caption = el('preview-caption').value.trim();
  const pending = state.pendingAttachments;
  state.pendingAttachments = [];
  el('preview-backdrop').hidden = true;
  if (!chat || !pending.length) return;

  for (const [index, item] of pending.entries()) {
    // The caption belongs to the first file, as it does in every chat app.
    await sendAttachment(chat.id, item.file, item.offer, index === 0 ? caption : '');
  }
}

/* ----------------------------------------------------------------- peer log */

async function rememberPeer() {
  const peer = state.peer;
  if (!peer) return;
  const id = hex(peer.publicKey);
  const existing = await idbGet('peers', id);
  await idbSet('peers', id, {
    nick: peer.nick,
    idMode: peer.idMode,
    firstSeen: existing?.firstSeen ?? Date.now(),
    lastSeen: Date.now(),
    previousNick: existing && existing.nick !== peer.nick ? existing.nick : existing?.previousNick,
    timesMet: (existing?.timesMet ?? 0) + 1,
  });
  if (existing && existing.nick !== peer.nick) {
    const chat = activeChat();
    if (chat) {
      await state.chats.append(
        chat.id,
        makeMessage({
          who: 'system',
          text: `Heads up: this key has been used before under the name “${existing.nick}”.`,
        }),
        { unread: false },
      );
      renderConversation();
    }
  }
}

/* ----------------------------------------------------------------- keepalive */

let keepAliveOn = false;

async function startKeepAlive() {
  if (keepAliveOn) return;
  const chat = activeChat();
  const description = chat?.kind === 'room' ? `In ${chat.nick}` : `Connected to ${chat?.nick ?? 'a peer'}`;
  await requestNotificationPermission();
  keepAliveOn = await keepAlive(true, description);
}

async function stopKeepAlive() {
  if (!keepAliveOn) return;
  keepAliveOn = false;
  await keepAlive(false);
}


/* ------------------------------------------------------------- settings page */

function renderSettings() {
  const profile = state.identity.profile;
  el('settings-nick').textContent = profile.nick || 'You';
  const avatar = el('settings-avatar');
  avatar.textContent = initialsFor(profile.nick || 'You');
  avatar.style.background = avatarColour(hex(state.identity.publicKey));
  state.identity.fingerprint().then((fingerprint) => {
    el('settings-fingerprint').textContent = `Key fingerprint ${fingerprint}`;
  });
}

/* --------------------------------------------------------- contact info page */

function renderInfoPage() {
  const chat = activeChat();
  if (!chat) return;
  el('info-nick').textContent = chat.nick || 'Unknown';
  const avatar = el('info-avatar');
  avatar.textContent = initialsFor(chat.nick || 'Room');
  avatar.style.background = avatarColour(chat.publicKey ?? chat.id);

  const bits = [];
  bits.push(chat.kind === 'room' ? 'Group room' : ['Nickname only', 'Contact shared', 'Throwaway'][chat.idMode] ?? 'Contact');
  if (chat.kind !== 'room') bits.push(chat.verified ? 'signed invite' : 'unverified invite');
  if (state.session?.isOpen) bits.push('online');
  el('info-subtitle').textContent = bits.join(' · ');

  renderPeerCard();
}

/* ------------------------------------------------------------------ badge */

function renderTabBadge() {
  const unread = state.chats.unreadCount();
  const badge = el('tab-badge');
  badge.hidden = unread === 0;
  badge.textContent = unread > 99 ? '99+' : String(unread);
}

/* ---------------------------------------------------------------- voice notes */

function pickRecorderMime() {
  const candidates = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg'];
  for (const type of candidates) {
    if (typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported?.(type)) return type;
  }
  return '';
}

async function startRecording() {
  const chat = activeChat();
  if (!chat) throw new Error('Open a chat first.');
  if (chat.kind === 'room') throw new Error('Voice messages in rooms are not supported yet.');
  if (!navigator.mediaDevices?.getUserMedia) throw new Error('This device cannot record audio.');

  const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  const mimeType = pickRecorderMime();
  const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
  const parts = [];
  recorder.addEventListener('dataavailable', (event) => {
    if (event.data?.size) parts.push(event.data);
  });

  state.recorder = { recorder, stream, parts, startedAt: Date.now(), timer: null };
  recorder.start();

  el('recording-bar').hidden = false;
  el('recording-time').textContent = '0:00';
  state.recorder.timer = setInterval(() => {
    const seconds = Math.floor((Date.now() - state.recorder.startedAt) / 1000);
    el('recording-time').textContent = `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
    // A minute is plenty for a voice note, and keeps the file small.
    if (seconds >= 60) stopRecording({ send: true });
  }, 250);
}

async function stopRecording({ send }) {
  const session = state.recorder;
  if (!session) return;
  state.recorder = null;
  clearInterval(session.timer);
  el('recording-bar').hidden = true;

  const finished = new Promise((resolve) => session.recorder.addEventListener('stop', resolve, { once: true }));
  try {
    session.recorder.stop();
  } catch {
    /* already stopped */
  }
  await finished;
  for (const track of session.stream.getTracks()) track.stop();

  if (!send) return;
  const seconds = Math.round((Date.now() - session.startedAt) / 1000);
  const blob = new Blob(session.parts, { type: session.recorder.mimeType || 'audio/webm' });
  if (blob.size < 1200 || seconds < 1) {
    toast('That was too short to send.', true);
    return;
  }

  const name = `voice-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.${extensionFor(blob.type, 'voice.webm')}`;
  const file = new File([blob], name, { type: blob.type });
  try {
    const offer = await prepareAttachment(file);
    await sendAttachment(activeChat().id, file, offer, '');
  } catch (error) {
    toast(error.message, true);
  }
}

/** The send button becomes a microphone when there is nothing to send. */
function updateSendButton() {
  const hasText = Boolean(el('message-input').value.trim());
  const canRecord = Boolean(navigator.mediaDevices?.getUserMedia) && typeof MediaRecorder !== 'undefined';
  el('btn-mic').hidden = hasText || !canRecord || Boolean(state.recorder);
  el('btn-send').hidden = !hasText && canRecord;
  if (!canRecord) {
    el('btn-send').hidden = false;
    el('btn-mic').hidden = true;
  }
}

/* ------------------------------------------------------------------------ UI */

function wireUi() {
  el('app-name').textContent = APP_NAME;
  document.title = APP_NAME;

  el('btn-settings').addEventListener('click', () => {
    const panel = el('identity-panel');
    panel.hidden = !panel.hidden;
    el('btn-settings').setAttribute('aria-expanded', String(!panel.hidden));
  });

  const openNewChat = () => {
    el('invite-result').hidden = true;
    el('connect-heading').textContent = 'Start a private chat';
    showView('connect');
  };
  el('btn-new-chat').addEventListener('click', openNewChat);
  el('fab-new').addEventListener('click', openNewChat);

  el('btn-back').addEventListener('click', () => goHome());
  el('btn-chat-menu').addEventListener('click', () => {
    renderDisappearingOptions();
    el('sheet-backdrop').hidden = false;
  });
  el('btn-menu-close').addEventListener('click', () => {
    el('sheet-backdrop').hidden = true;
  });
  el('sheet-backdrop').addEventListener('click', (event) => {
    if (event.target === el('sheet-backdrop')) el('sheet-backdrop').hidden = true;
  });

  // The security code lives on the contact info page now.
  el('menu-verify').addEventListener('click', () => {
    el('sheet-backdrop').hidden = true;
    renderInfoPage();
    showView('info');
    toast('Compare the emoji and digits with them out loud.');
  });

  el('menu-clear').addEventListener('click', async () => {
    const chat = activeChat();
    el('sheet-backdrop').hidden = true;
    if (!chat) return;
    await state.chats.clearMessages(chat.id);
    renderConversation();
    renderChatList();
    toast('Messages cleared from this device.');
  });

  el('menu-close').addEventListener('click', async () => {
    const chat = activeChat();
    el('sheet-backdrop').hidden = true;
    if (!chat) return;
    await state.chats.remove(chat.id);
    state.session?.close();
    state.group?.close();
    state.group = null;
    state.groupIdentity = null;
    goHome();
    toast('Chat closed and removed from this device.');
  });

  for (const radio of document.querySelectorAll('input[name="id-mode"]')) {
    radio.addEventListener('change', () => {
      el('contact-block').hidden = selectedMode() !== ID_MODE.CONTACT;
    });
  }

  el('group-mode').addEventListener('change', () => {
    el('group-label-field').hidden = !el('group-mode').checked;
  });

  el('btn-create').addEventListener('click', async () => {
    el('btn-create').disabled = true;
    try {
      await createInvite({
        group: el('group-mode').checked,
        label: el('group-label').value.trim(),
      });
    } catch (error) {
      toast(error.message, true);
    } finally {
      el('btn-create').disabled = false;
    }
  });

  el('btn-paste').addEventListener('click', async () => {
    const value = el('paste-input').value;
    if (!value.trim()) {
      toast('Paste an invite or reply code first.', true);
      return;
    }
    el('btn-paste').disabled = true;
    try {
      await handleIncomingCode(value);
      el('paste-input').value = '';
    } catch (error) {
      el('paste-hint').textContent = error.message;
      el('paste-hint').className = 'hint bad';
      toast(error.message, true);
    } finally {
      el('btn-paste').disabled = false;
    }
  });

  const copy = async (text, label) => {
    try {
      await navigator.clipboard.writeText(text);
      toast(`${label} copied`);
    } catch {
      toast('Copy failed — select the text and copy manually.', true);
    }
  };

  el('btn-copy-invite').addEventListener('click', () => copy(el('invite-code').value, 'Invite code'));
  el('btn-copy-link').addEventListener('click', () =>
    copy(buildInviteLink(location.href.split('#')[0], el('invite-code').value), 'Invite link'),
  );
  el('btn-copy-reply').addEventListener('click', () => copy(el('reply-code').value, 'Reply code'));
  el('btn-copy-reply-link').addEventListener('click', () =>
    copy(buildInviteLink(location.href.split('#')[0], el('reply-code').value), 'Reply link'),
  );


  /* ---------------------------------------------------- WhatsApp-style shell */

  const openSettings = () => {
    renderSettings();
    showView('settings');
  };
  el('tab-chats').addEventListener('click', () => goHome());
  el('tab-settings').addEventListener('click', openSettings);
  el('btn-settings').addEventListener('click', openSettings);

  el('btn-search').addEventListener('click', () => {
    state.searching = !state.searching;
    if (state.view !== 'home') showView('home');
    else el('search-bar').hidden = !state.searching;
    if (state.searching) {
      el('chat-search').focus();
    } else {
      el('chat-search').value = '';
      renderChatList();
    }
  });
  el('btn-search-close').addEventListener('click', () => {
    state.searching = false;
    el('chat-search').value = '';
    el('search-bar').hidden = true;
    renderChatList();
  });
  el('chat-search').addEventListener('input', () => renderChatList());

  // Contact info, opened from the chat header.
  el('chat-title').addEventListener('click', () => {
    renderInfoPage();
    showView('info');
  });
  el('btn-info-back').addEventListener('click', () => {
    showView('chat');
    renderChatHeader();
    renderConversation();
  });
  el('info-ttl').addEventListener('click', () => {
    renderDisappearingOptions();
    openSheet('sheet-backdrop');
  });
  el('info-verify').addEventListener('click', () => {
    el('info-verify').textContent = 'Read these aloud on a call you already trust';
    toast('Compare the emoji and digits with them out loud.');
  });

  // Chat row actions.
  el('btn-chat-menu-close').addEventListener('click', () => closeSheet('chat-menu'));
  el('chat-menu').addEventListener('click', (event) => {
    if (event.target === el('chat-menu')) closeSheet('chat-menu');
  });
  el('row-pin').addEventListener('click', async () => {
    const chatId = state.menuChatId;
    closeSheet('chat-menu');
    if (!chatId) return;
    const chat = await state.chats.togglePin(chatId);
    renderChatList();
    toast(chat?.pinned ? 'Chat pinned' : 'Chat unpinned');
  });
  el('row-read').addEventListener('click', async () => {
    const chatId = state.menuChatId;
    closeSheet('chat-menu');
    if (!chatId) return;
    await state.chats.markRead(chatId);
    renderChatList();
    renderTabBadge();
  });
  el('row-disappearing').addEventListener('click', () => {
    const chatId = state.menuChatId;
    closeSheet('chat-menu');
    if (!chatId) return;
    openChat(chatId);
    renderDisappearingOptions();
    openSheet('sheet-backdrop');
  });
  el('row-delete').addEventListener('click', async () => {
    const chatId = state.menuChatId;
    closeSheet('chat-menu');
    if (!chatId) return;
    if (state.activeChatId === chatId) state.activeChatId = null;
    await state.chats.remove(chatId);
    renderChatList();
    renderTabBadge();
    toast('Chat deleted from this device.');
  });

  // Message actions.
  el('btn-message-menu-close').addEventListener('click', () => closeSheet('message-menu'));
  el('message-menu').addEventListener('click', (event) => {
    if (event.target === el('message-menu')) closeSheet('message-menu');
  });
  el('msg-reply').addEventListener('click', () => {
    const id = state.menuMessageId;
    closeSheet('message-menu');
    if (id) beginReply(id);
  });
  el('msg-copy').addEventListener('click', async () => {
    const id = state.menuMessageId;
    closeSheet('message-menu');
    const message = activeChat()?.messages.find((entry) => entry.id === id);
    if (!message) return;
    try {
      await navigator.clipboard.writeText(message.text);
      toast('Copied');
    } catch {
      toast('Copy failed — select the text manually.', true);
    }
  });
  el('msg-star').addEventListener('click', async () => {
    const id = state.menuMessageId;
    closeSheet('message-menu');
    const chat = activeChat();
    if (!chat || !id) return;
    const message = await state.chats.toggleStar(chat.id, id);
    renderConversation();
    toast(message?.starred ? 'Starred' : 'Unstarred');
  });
  el('msg-info').addEventListener('click', () => {
    const id = state.menuMessageId;
    closeSheet('message-menu');
    const message = activeChat()?.messages.find((entry) => entry.id === id);
    if (!message) return;
    const when = new Date(message.ts).toLocaleString();
    const state_ = message.who === 'me'
      ? message.state === 'delivered' ? 'Delivered' : message.state === 'failed' ? 'Not sent' : 'Sent'
      : 'Received';
    toast(`${state_} · ${when}`);
  });
  el('msg-delete').addEventListener('click', async () => {
    const id = state.menuMessageId;
    closeSheet('message-menu');
    const chat = activeChat();
    if (!chat || !id) return;
    await state.chats.deleteMessage(chat.id, id);
    renderConversation();
    renderChatList();
    toast('Message deleted from this device.');
  });

  el('btn-reply-cancel').addEventListener('click', cancelReply);

  // Emoji
  el('btn-emoji').addEventListener('click', () => {
    renderEmojiPicker();
    const picker = el('emoji-picker');
    picker.hidden = !picker.hidden;
  });
  el('message-input').addEventListener('input', () => {
    updateSendButton();
    noteTyping();
  });
  el('message-input').addEventListener('focus', () => {
    el('emoji-picker').hidden = true;
  });

  // Voice notes
  el('btn-mic').addEventListener('click', () => {
    if (state.recorder) stopRecording({ send: true });
    else startRecording().catch((error) => toast(error.message, true));
  });
  el('btn-record-cancel').addEventListener('click', () => stopRecording({ send: false }));

  // Attachments: two pickers, because a phone distinguishes the camera roll
  // from documents and the capture attribute only makes sense for the first.
  el('btn-attach').addEventListener('click', () => {
    el('attach-backdrop').hidden = false;
  });
  el('btn-attach-close').addEventListener('click', () => {
    el('attach-backdrop').hidden = true;
  });
  el('attach-backdrop').addEventListener('click', (event) => {
    if (event.target === el('attach-backdrop')) el('attach-backdrop').hidden = true;
  });
  el('attach-photos').addEventListener('click', () => {
    el('attach-backdrop').hidden = true;
    el('input-photos').click();
  });
  el('attach-file').addEventListener('click', () => {
    el('attach-backdrop').hidden = true;
    el('input-files').click();
  });

  for (const id of ['input-photos', 'input-files']) {
    el(id).addEventListener('change', (event) => {
      // Copy first: clearing the input empties the live FileList, so reading it
      // afterwards would silently send nothing.
      const files = [...event.target.files];
      event.target.value = '';
      queueAttachments(files).catch((error) => toast(error.message, true));
    });
  }

  el('btn-preview-send').addEventListener('click', () => {
    sendPendingAttachments().catch((error) => toast(error.message, true));
  });
  for (const id of ['btn-preview-close', 'btn-preview-cancel']) {
    el(id).addEventListener('click', () => {
      state.pendingAttachments = [];
      el('preview-backdrop').hidden = true;
    });
  }

  el('btn-lightbox-close').addEventListener('click', () => {
    el('lightbox').hidden = true;
    el('lightbox-image').src = '';
  });
  el('lightbox').addEventListener('click', (event) => {
    if (event.target === el('lightbox')) el('lightbox').hidden = true;
  });

  // Drag and drop, and paste, both land in the same place.
  const chatView = el('view-chat');
  for (const type of ['dragenter', 'dragover']) {
    chatView.addEventListener(type, (event) => {
      if (!event.dataTransfer?.types?.includes('Files')) return;
      event.preventDefault();
      chatView.classList.add('drop-target');
    });
  }
  chatView.addEventListener('dragleave', () => chatView.classList.remove('drop-target'));
  chatView.addEventListener('drop', (event) => {
    if (!event.dataTransfer?.files?.length) return;
    event.preventDefault();
    chatView.classList.remove('drop-target');
    queueAttachments(event.dataTransfer.files).catch((error) => toast(error.message, true));
  });
  el('message-input').addEventListener('paste', (event) => {
    const files = [...(event.clipboardData?.files ?? [])];
    if (!files.length) return;
    event.preventDefault();
    queueAttachments(files).catch((error) => toast(error.message, true));
  });

  el('btn-scan-qr').addEventListener('click', () => {
    beginQrScan().catch((error) => toast(error.message, true));
  });
  el('btn-scan-cancel').addEventListener('click', () => stopScanning());
  el('btn-tap-nfc').addEventListener('click', () => {
    beginNfcScan().catch((error) => toast(error.message, true));
  });
  el('btn-write-nfc').addEventListener('click', () => {
    writeNfcTag(el('invite-code').value).catch((error) => toast(error.message, true));
  });

  el('composer').addEventListener('submit', (event) => {
    event.preventDefault();
    const input = el('message-input');
    const value = input.value;
    input.value = '';
    sendMessage(value).catch((error) => toast(error.message, true));
  });

  window.addEventListener('hashchange', () => {
    const code = codeFromHash(location.hash);
    if (code) el('paste-input').value = code;
  });

  // A message that expired while the app was hidden should not linger on screen.
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) {
      sweepExpired().catch(() => {});
      renderChatHeader();
      updateComposerState();
    }
  });
}

/* ---------------------------------------------------------------------- boot */

const ready = (async () => {
  const fromUrl = iceServersFromParams(new URLSearchParams(location.search));
  if (fromUrl) configureIceServers(fromUrl);

  state.identity = await Identity.load();
  state.chats = await ChatStore.load();
  state.transfers = await TransferStore.load();
  await state.chats.sweep();
  // Anything that was mid-flight when the app closed is pending again, not lost.
  await markInterruptedTransfers();

  hydrateIdentityForm();
  wireUi();
  await probeNativeSupport();
  applyPairingCapabilities();

  setInterval(() => sweepExpired().catch(() => {}), SWEEP_INTERVAL_MS);
  updateSendButton();
  goHome();
  renderTabBadge();

  const code = codeFromHash(location.hash);
  if (code) {
    el('paste-input').value = code;
    try {
      const opened = await openInvite(code);
      if (opened.invite.kind === KIND.OFFER) {
        await handleIncomingCode(code);
      } else {
        toast('That is a reply code. Paste it into the window that created the invite.');
      }
    } catch (error) {
      toast(error.message, true);
    }
  }

  subscribeToAppUrls((inviteCode) => {
    el('paste-input').value = inviteCode;
    showView('connect');
    handleIncomingCode(inviteCode).catch((error) => toast(error.message, true));
  }).catch(() => {});

  // Inside the native app the assets ship in the APK already, so a service
  // worker adds nothing and actively hurts: it keeps serving the previous build
  // from its cache after an app update. Register it for the web only, and clean
  // up any registration left behind by an earlier build of the app.
  const inNativeApp = globalThis.Capacitor?.isNativePlatform?.() === true;
  if (inNativeApp) {
    navigator.serviceWorker
      ?.getRegistrations?.()
      .then((registrations) => registrations.forEach((registration) => registration.unregister()))
      .catch(() => {});
  } else if ('serviceWorker' in navigator && location.protocol.startsWith('http')) {
    navigator.serviceWorker.register('./sw.js').catch(() => {});
  }
})();

/**
 * Testing seam. The suites drive the real modules through this, so the tests
 * exercise the same code path the buttons do.
 */
window.__p2p = {
  ready,
  idMode: ID_MODE,
  createInvite,
  handleIncomingCode,
  sendMessage,
  openChat,
  goHome,
  setDisappearing,
  sweepExpired,
  activeChat: () => state.activeChatId,
  chatList: () =>
    state.chats.list().map((chat) => ({
      id: chat.id,
      nick: chat.nick,
      kind: chat.kind,
      unread: chat.unread,
      disappearing: chat.disappearing,
      messages: chat.messages.length,
      preview: previewOf(chat),
    })),
  getState: () => {
    const chat = state.chats.get(state.activeChatId);
    return {
      view: state.view,
      chatId: state.activeChatId,
      messages: (chat?.messages ?? []).map((message) => ({ ...message })),
      peerNick: state.peer?.nick ?? chat?.nick ?? null,
      peerVerified: state.peerVerified,
      sas: state.sas ? { digits: state.sas.digits, emoji: state.sas.emoji } : null,
      open: Boolean(state.session?.isOpen),
      error: state.lastError,
      fingerprint: state.session?.fingerprint ?? null,
      localInviteKind: state.session?.localInvite?.kind ?? null,
      roomId: state.session?.localInvite?.roomId ?? state.peer?.roomId ?? null,
      disappearing: chat?.disappearing ?? 0,
      unread: state.chats.unreadCount(),
      qr: { invite: el('qr-canvas').width > 0, reply: el('reply-qr').width > 0 },
      capabilities: { scanner: scannerCapability(), nfc: nfcCapability() },
      group: state.group
        ? {
            roomId: state.group.roomId,
            label: state.group.label,
            isHost: state.group.isHost,
            count: state.group.memberCount,
            members: state.group.membersList(),
            links: [...state.group.links.keys()],
          }
        : null,
    };
  },
  session: () => state.session,
  group: () => state.group,
  setIceServers: (servers) => configureIceServers(servers),
  getIceServers: () => currentIceServers(),
  transferStats: () => ({ ...state.stats }),
  holders: () => Object.fromEntries([...state.holders].map(([file, keys]) => [file.slice(0, 8), [...keys].map((k) => k.slice(0, 8))])),
  /** How many files are prepared and waiting in the preview sheet. */
  pendingAttachments: () => state.pendingAttachments.length,
  /** Chunks of a file sitting on disk from an interrupted transfer. */
  heldChunks: (fileId) => state.transfers.heldCount(fileId),
  pendingTransfers: () => ({
    outgoing: [...state.chats.list()].flatMap((chat) => state.transfers.outgoingFor(chat.id)).length,
    incoming: [...state.chats.list()].flatMap((chat) => state.transfers.incomingFor(chat.id)).length,
    live: state.receiving.size,
  }),
  /** Read a stored blob back, for verifying a transfer arrived intact. */
  readMedia: async (fileId) => {
    const record = await state.transfers.getMedia(fileId);
    if (!record?.blob) return null;
    return { size: record.blob.size, mime: record.blob.type };
  },
};
