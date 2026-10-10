import test from 'node:test';
import assert from 'node:assert/strict';

import {
  pruneExpired,
  makeMessage,
  emptyChat,
  previewOf,
  conversationIdForPeer,
  conversationIdForRoom,
  isRoomConversation,
} from '../../src/chats.js';

import {
  APP_NAME,
  DISAPPEARING_OPTIONS,
  disappearingLabel,
  formatListTime,
  formatDaySeparator,
  avatarColour,
  initialsFor,
} from '../../src/config.js';

/* ------------------------------------------------- disappearing semantics */

test('pruneExpired keeps messages with no timer', () => {
  const messages = [{ id: 'a', ts: 1 }, { id: 'b', ts: 2 }];
  assert.deepEqual(pruneExpired(messages, 10_000), messages);
});

test('pruneExpired drops only what has actually expired', () => {
  const now = 1_000_000;
  const messages = [
    { id: 'gone', expiresAt: now - 1 },
    { id: 'edge', expiresAt: now },
    { id: 'alive', expiresAt: now + 1 },
    { id: 'forever', ts: 1 },
  ];
  assert.deepEqual(
    pruneExpired(messages, now).map((m) => m.id),
    ['alive', 'forever'],
  );
});

test('pruneExpired survives rubbish input', () => {
  assert.deepEqual(pruneExpired(undefined), []);
  assert.deepEqual(pruneExpired(null), []);
});

test('makeMessage stamps an expiry only when a timer is running', () => {
  const timed = makeMessage({ who: 'me', text: 'hi', ts: 1000, disappearingSeconds: 60 });
  assert.equal(timed.expiresAt, 61_000);

  const untimed = makeMessage({ who: 'me', text: 'hi', ts: 1000 });
  assert.equal(untimed.expiresAt, undefined);
});

test('system notices never expire, so the setting stays visible', () => {
  const note = makeMessage({ who: 'system', text: 'timer on', ts: 1000, disappearingSeconds: 60 });
  assert.equal(note.expiresAt, undefined);
});

test('the timer applies at send time, not retroactively', () => {
  // Two messages sent under different settings keep their own deadlines.
  const early = makeMessage({ who: 'me', text: 'before', ts: 1000 });
  const late = makeMessage({ who: 'me', text: 'after', ts: 2000, disappearingSeconds: 10 });
  assert.equal(early.expiresAt, undefined);
  assert.equal(late.expiresAt, 12_000);
});

/* ------------------------------------------------------------- previews */

test('previews read like a chat list', () => {
  const chat = emptyChat({ id: 'x', nick: 'bob' });
  assert.equal(previewOf(chat), 'No messages yet');

  chat.messages = [makeMessage({ who: 'them', text: 'hello there' })];
  assert.equal(previewOf(chat), 'hello there');

  chat.messages = [makeMessage({ who: 'me', text: 'hello there' })];
  assert.equal(previewOf(chat), 'You: hello there');

  chat.messages = [makeMessage({ who: 'system', text: 'You turned off disappearing messages.' })];
  assert.equal(previewOf(chat), 'You turned off disappearing messages.');
});

test('room previews name the speaker', () => {
  const room = emptyChat({ id: 'room:1', kind: 'room', nick: 'Trip' });
  room.messages = [makeMessage({ who: 'them', text: 'here', from: 'ana' })];
  assert.equal(previewOf(room), 'ana: here');

  room.messages = [makeMessage({ who: 'me', text: 'coming', from: 'me' })];
  assert.equal(previewOf(room), 'You: coming');
});

test('long previews are truncated', () => {
  const chat = emptyChat({ id: 'x' });
  chat.messages = [makeMessage({ who: 'them', text: 'y'.repeat(200) })];
  const preview = previewOf(chat);
  assert.ok(preview.length <= 91, `preview was ${preview.length} characters`);
  assert.ok(preview.endsWith('…'));
});

test('an empty room says so', () => {
  assert.match(previewOf(emptyChat({ id: 'room:1', kind: 'room' })), /nobody has spoken yet/i);
});

/* ------------------------------------------------------------ identifiers */

test('conversation ids are derived, not random', () => {
  assert.equal(conversationIdForPeer('abc123'), 'peer:abc123');
  assert.equal(conversationIdForRoom('42'), 'room:42');
  assert.ok(isRoomConversation('room:42'));
  assert.ok(!isRoomConversation('peer:abc'));
});

/* ----------------------------------------------------------------- format */

test('disappearing labels cover the menu and anything else', () => {
  assert.equal(disappearingLabel(0), 'Off');
  assert.equal(disappearingLabel(3600), '1 hour');
  assert.equal(disappearingLabel(7776000), '90 days');
  assert.equal(disappearingLabel(1), '1 second');
  assert.equal(disappearingLabel(45), '45 seconds');
  assert.equal(disappearingLabel(120), '2 minutes');
  assert.equal(disappearingLabel(7200), '2 hours');
  assert.equal(DISAPPEARING_OPTIONS[0].seconds, 0);
});

test('list timestamps switch from clock to weekday to date', () => {
  const now = new Date('2026-05-14T15:00:00').getTime();
  const at = (iso) => new Date(iso).getTime();

  assert.match(formatListTime(at('2026-05-14T09:30:00'), now), /\d/);
  assert.match(formatListTime(at('2026-05-12T09:30:00'), now), /^(Mon|Tue|Wed|Thu|Fri|Sat|Sun)/);
  assert.match(formatListTime(at('2026-04-02T09:30:00'), now), /\d{2}\/\d{2}\/\d{2}|\d{1,2}\/\d{1,2}\/\d{2}/);
});

test('day separators say today, yesterday, then a date', () => {
  const now = new Date('2026-05-14T15:00:00').getTime();
  assert.equal(formatDaySeparator(new Date('2026-05-14T09:00:00').getTime(), now), 'Today');
  assert.equal(formatDaySeparator(new Date('2026-05-13T23:00:00').getTime(), now), 'Yesterday');
  assert.match(formatDaySeparator(new Date('2026-05-11T09:00:00').getTime(), now), /^(Mon|Tue|Wed|Thu|Fri|Sat|Sun)day$/);
  assert.match(formatDaySeparator(new Date('2026-03-01T09:00:00').getTime(), now), /2026/);
});

test('avatars are stable and readable', () => {
  assert.equal(initialsFor('bob-amber'), 'BA');
  assert.equal(initialsFor('alice'), 'AL');
  assert.equal(initialsFor(''), '?');
  assert.equal(initialsFor('Trip to Rome'), 'TT');

  const colour = avatarColour('deadbeef');
  assert.match(colour, /^#[0-9a-f]{6}$/i);
  assert.equal(avatarColour('deadbeef'), colour, 'same seed, same colour');
});

test('the product name lives in exactly one place', () => {
  assert.equal(APP_NAME, 'Wisp');
});
