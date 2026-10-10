/**
 * Product identity, in one place.
 *
 * The name appears in the window title, the manifest, the app label and the
 * docs, so it lives here rather than being scattered: changing it is a one-line
 * edit plus `npm run build:android`.
 */

export const APP_NAME = 'Wisp';
export const APP_TAGLINE = 'Chats that leave no trace';
export const APP_DESCRIPTION =
  'Peer-to-peer chat over WebRTC. No accounts, no signaling server, no message store — and conversations you can set to fade away.';

/** How long messages survive after they are read or sent. */
export const DISAPPEARING_OPTIONS = [
  { seconds: 0, label: 'Off', short: 'off' },
  { seconds: 3600, label: '1 hour', short: '1h' },
  { seconds: 86400, label: '24 hours', short: '24h' },
  { seconds: 604800, label: '7 days', short: '7d' },
  { seconds: 7776000, label: '90 days', short: '90d' },
];

export function disappearingLabel(seconds) {
  const known = DISAPPEARING_OPTIONS.find((option) => option.seconds === seconds);
  if (known) return known.label;
  // Values that are not offered in the UI (tests use one second) still deserve a
  // readable label rather than "Off".
  if (!seconds || seconds <= 0) return 'Off';
  if (seconds < 60) return `${seconds} second${seconds === 1 ? '' : 's'}`;
  if (seconds < 3600) return `${Math.round(seconds / 60)} minutes`;
  if (seconds < 86400) return `${Math.round(seconds / 3600)} hours`;
  return `${Math.round(seconds / 86400)} days`;
}

export function disappearingShort(seconds) {
  return DISAPPEARING_OPTIONS.find((option) => option.seconds === seconds)?.short ?? 'off';
}

/** Compact timestamps, WhatsApp style: time today, weekday this week, else a date. */
export function formatListTime(ts, now = Date.now()) {
  const date = new Date(ts);
  const today = new Date(now);
  const startOfToday = new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime();
  if (ts >= startOfToday) return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  if (ts >= startOfToday - 6 * 86400000) return date.toLocaleDateString([], { weekday: 'short' });
  return date.toLocaleDateString([], { day: '2-digit', month: '2-digit', year: '2-digit' });
}

/** "last seen today at 14:32", the way a chat app says it. */
export function formatLastSeen(ts, now = Date.now()) {
  if (!ts) return 'offline';
  const clock = formatClock(ts);
  const today = new Date(now);
  const startOfToday = new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime();
  if (ts >= startOfToday) return `last seen today at ${clock}`;
  if (ts >= startOfToday - 86400000) return `last seen yesterday at ${clock}`;
  return `last seen ${new Date(ts).toLocaleDateString([], { day: 'numeric', month: 'short' })} at ${clock}`;
}

export function formatClock(ts) {
  return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

export function formatDaySeparator(ts, now = Date.now()) {
  const date = new Date(ts);
  const today = new Date(now);
  const startOfToday = new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime();
  const startOfDay = new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
  const days = Math.round((startOfToday - startOfDay) / 86400000);
  if (days === 0) return 'Today';
  if (days === 1) return 'Yesterday';
  if (days < 7) return date.toLocaleDateString([], { weekday: 'long' });
  return date.toLocaleDateString([], { day: 'numeric', month: 'short', year: 'numeric' });
}

/** A stable colour per peer, so an avatar looks the same every time. */
const AVATAR_COLOURS = [
  '#e57373', '#f06292', '#ba68c8', '#9575cd', '#7986cb', '#64b5f6',
  '#4fc3f7', '#4dd0e1', '#4db6ac', '#81c784', '#aed581', '#ffb74d',
  '#ff8a65', '#a1887f', '#90a4ae',
];

export function avatarColour(seed) {
  let hash = 0;
  for (let i = 0; i < seed.length; i++) hash = (hash * 31 + seed.charCodeAt(i)) >>> 0;
  return AVATAR_COLOURS[hash % AVATAR_COLOURS.length];
}

export function initialsFor(name) {
  const parts = String(name || '?').trim().split(/[\s_-]+/).filter(Boolean);
  if (!parts.length) return '?';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[1][0]).toUpperCase();
}
