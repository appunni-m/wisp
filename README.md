# Wisp — private, serverless P2P chat

Peer-to-peer chat over WebRTC data channels with **no signaling server, no accounts, and no message store**. Two people connect by exchanging a short code; the code *is* the connection setup.

```
        Alice                                    Bob
   ┌──────────────┐                        ┌──────────────┐
   │ Create invite│──── 1. code (410 ch) ──▶│ paste → reply│
   │              │◀─── 2. reply code ─────│              │
   └──────┬───────┘                        └──────┬───────┘
          │        DTLS-encrypted data channel    │
          └───────────────────────────────────────┘
              no server in the middle, ever
```

---

## Quick start

```bash
node serve.mjs        # then open http://127.0.0.1:8080 in two windows
```

Set a nickname under **Settings** first. Then, in **Chats**, tap **+** → *Create an
invite* → let the other person scan the QR (or copy the code). They reply, you
scan or paste that back, and you are talking.

You now have a live encrypted channel between two browser profiles. The static
server only serves the app shell — it never sees a code, because codes travel in
the URL *fragment*, which browsers do not transmit.

### On a phone

```bash
node serve.mjs --lan --https      # prints a QR for the URL — scan it with the phone
```

Plain `http://` on a LAN address is **not a secure context**, so `crypto.subtle`
does not exist there and the app cannot create an identity key at all. `--https`
generates a self-signed certificate (accept the warning once) and the terminal
prints a scannable QR for the address. On Android, `adb reverse tcp:8080 tcp:8080`
avoids certificates entirely: the origin becomes `localhost` on the phone, which
is a genuine secure context.

```bash
npm test              # 157 unit tests
npm run test:e2e      #  82 in real Chrome: pairing, groups, chat list, transfer, swarm
npm run test:android  #  7 against the real APK on a real Android runtime
npm run test:all      # all 246
```

---

## How the code stays short

A raw WebRTC offer is 1.5–3 KB of SDP — unusable in a chat message. But both
peers run the same app, so the *structure* of the session description is already
known to both sides. The wire format carries only what actually differs:

| Field | Raw SDP | On the wire |
|---|---|---|
| ICE ufrag / pwd | ~35 chars | as-is |
| DTLS fingerprint | 95 chars of hex | 32 raw bytes |
| Candidates | ~80 chars each | 8–27 bytes each, binary |
| ICE priorities | 10 digits each | recomputed, not sent |
| Codecs, m-line, BUNDLE, SCTP port | ~1.5 KB | not sent (from a local skeleton) |

Everything is then signed and deflated, and rendered as
`P2P1z-<base64url>`. A realistic invite with four candidates (srflx + host +
mDNS + IPv6) is **~410 characters** — comfortable in WhatsApp, SMS and QR codes.

Each side captures a real, browser-generated SDP skeleton once at startup
(`src/sdp.js`), so the reassembled description is genuine WebRTC rather than
hand-written SDP that might drift from what a browser accepts.

---

## Pairing: QR codes and NFC

Copy-paste works, but it is not how anyone wants to pair a phone. There are three
ways to move a code, and they degrade into each other cleanly.

### QR codes

The app draws its own QR codes — no library, no CDN, no network. That matters:
a dependency-free encoder is the difference between "works on a plane" and
"works if the CDN is up".

`src/qr.js` implements the full ISO/IEC 18004 encoder: byte mode, versions 1–40,
all four error-correction levels, Reed–Solomon over GF(256), all eight masks with
penalty scoring. A 392-character invite lands on **version 15 (77×77 modules)**,
which a phone camera reads comfortably from a screen.

It is verified two ways, because a QR encoder is exactly the kind of code that
looks right and scans wrong:

- **Bit-identical to an independent implementation** (`qrcode`) for all 160
  version/level combinations filled to capacity, plus all 8 masks across 5
  versions. The capacity cross-check caught four real typos in the standard
  tables during development.
- **Decoded back from the rendered image** by `jsQR`, 159 of 160 combinations.
  The exception is version 23-L, where jsQR returns null *even for the reference
  implementation's own output* — a decoder bug, pinned by a test so it cannot be
  mistaken for ours later.

**Scanning** uses the browser's own `BarcodeDetector` — no decoder library
either. It is present in Chrome on Android and desktop, Samsung Internet and
Opera. **Safari ships it disabled by default**, so on iPhone the app says so and
points at the system camera app, which reads QR codes natively and opens the
link. That path needs no support from us at all, which is why the app always
renders the QR even on a phone that cannot scan one.

### NFC

What gets written to a tag is a **URL record**, not a text blob. That choice is
what makes tags work for everyone:

| Phone | What happens on tap |
|---|---|
| iPhone 7+ | the OS reads the tag in the background and offers a notification — **no app required** |
| Android | the URL is handed to the browser |
| Either, app installed | the invite opens with the code already filled in |

`NDEFReader` (Web NFC) exists **only in Chrome on Android**, and only there for
*writing* and in-app *reading*. Receiving works everywhere because the operating
system handles it.

Two honest limits:

- **Phone-to-phone tapping is not possible from a browser.** It needs host card
  emulation or NDEF push, which no browser exposes on either platform. A
  physical tag (NTAG215 or larger — 504 bytes; NTAG213 only holds 144) is
  required.
- **Web NFC does not exist inside an Android WebView**, so the Capacitor app
  described below needs a native NFC plugin instead of this code.

Tag errors are translated rather than dumped: a tag that is too small, not
NDEF-formatted, or pulled away too early each get a specific explanation.

---

## Identity: what the other person learns about you

Every device generates a long-lived **ECDSA P-256** key pair on first run. The
private key is created non-extractable and stored in IndexedDB as a `CryptoKey`
object, so its bytes never exist in a form any script — including this app — can
read back.

Three sharing modes, chosen per invite:

| Mode | Shares | Property |
|---|---|---|
| **Nickname** | a nickname | signatures bind the nickname to a stable key, so the same person is recognisable next time |
| **Share my details** | nickname + name/phone/email/note | the contact card travels inside the signed payload |
| **Throwaway** | a nickname | a fresh key per invite, so nothing links this chat to you |

The whole payload is signed. Edit one character and verification fails — and the
app **refuses to continue** rather than warning and proceeding:

> This code failed its signature check. It was altered or forged in transit — ask for a fresh one.

### Defeating a man in the middle

There is no server to trust, but whoever carries your code could be an impostor.
Both sides therefore derive a **short authentication string** from both DTLS
fingerprints and both identity keys, and display it:

```
🦏 🐳 🐻 🐈   973310
```

Read it aloud on a call you already trust. If it matches, nobody is in the
middle. This is the only identity check that survives an untrusted channel, and
it is why the app never asks you to trust a nickname on its own.

---

## The chat itself

Pairing was the hard part; this is the part people actually live in, so it looks
like the chat app everyone already knows: a list of conversations, tap one, and
messages in bubbles with ticks.

**The list** keeps one row per conversation — avatar coloured from the peer's key,
name, last message, the time, an unread count, and a badge when the invite was
signed. Compose is a floating button, not a form.

**A conversation** is dense: a compact header (back, avatar, name, online state),
day separators, bubbles with tails on the first of a run, inline timestamps, and a
single tick that becomes two when the peer's device acknowledges delivery. Acknowledgements are a real round trip over the data
channel (`{t:'ack', id}`), not a lie drawn on the screen.

**History is local.** Conversations are stored in IndexedDB on this device —
there is no server to sync with and no account to sync through, so "backup" means
whatever the operating system does with app data. A reload brings the list and
the history back, and the chat says plainly that it is *not connected* rather
than pretending a message might get through.

### Disappearing messages

Per conversation: **off, 1 hour, 24 hours, 7 days or 90 days**, from the chat
menu. Turning it on tells the other side, so both devices agree and both show it
in the header.

The rule that matters is *when* the clock starts. Each message records the expiry
that applied at the moment it was sent or received — exactly as WhatsApp does —
so changing the setting never retroactively deletes old messages or resurrects
expired ones:

```js
makeMessage({ who: 'me', text, ts, disappearingSeconds: chat.disappearing })
// -> { ..., expiresAt: ts + seconds * 1000 }
```

Expiry is a pure function (`pruneExpired(messages, now)`), swept every 15 seconds
and on returning to the app, which is why the rule can be tested directly instead
of being inferred from the UI. System notices — "you set messages to disappear
after 24 hours" — deliberately never expire, or the setting would quietly become
invisible.

Two honest limits: a message already delivered to the other device has been
delivered, so disappearing removes it from both *apps* but cannot reach into a
screenshot, a notification, or a modified client. And a device that is switched
off simply deletes on next launch, so the timing is "after it is seen by the
app", not "after a guaranteed instant".

---

## Sending files

A photo goes down the same pipe as the messages. There is no upload endpoint, so
the constraints are the data channel's, and they shape everything:

- **A data channel is not a socket.** One `send()` call takes one message, and a
  message has a size limit (256 KB in Chrome; the spec only guarantees 64 KB). A
  photo is split into 16 KB chunks.
- **`send()` is fire-and-forget.** Hand it megabytes faster than the link drains
  and `bufferedAmount` grows until the tab dies. The sender watches the buffer
  and waits for it to fall before pushing more.
- **Media travels as binary, not base64 in JSON.** A third fewer bytes, and two
  fewer encode/decode passes. Control messages stay text, so the two are told
  apart by `typeof data === 'string'`.

Attachments can be picked, dragged in, pasted, or taken with the camera, and a
caption goes with the first file. Images render inline and open full screen;
video and audio get a player; anything else becomes a download card. Long-press
or tap a photo to view it.

### Resumable, because a link will drop

A 100 MB video over a link that can vanish is useless if a drop means starting
again, so a transfer is four steps instead of two:

```
sender   ->  file-offer   (digest, size, chunk size, piece manifest, thumbnail, caption)
receiver ->  file-have    (bitmap of the chunks it already holds)
sender   ->  chunks       (only the gaps)
receiver ->  file-complete
```

The `have` step is what makes it work. The receiver keeps every chunk under its
own key in IndexedDB, so "what do I hold" is just the keys that exist — the
bitmap can never drift out of sync with the data. After a drop, both sides keep
what they had, and the next connection re-offers automatically.

### Parallel, because a link is idle while the disk is read

Chunks are not read and sent one at a time. Reading a chunk means a slice off the
disk, and doing that serially leaves the link doing nothing for a moment between
every 16 KB. A pool of eight workers overlaps the reads, keeps the send buffer
fed, and lets chunks go out **in whatever order they finish** — the receiver
files every chunk by its sequence number, so waiting to send them in order would
only cost time.

Flow control is a sliding window rather than a stop-and-wait: the sender watches
`bufferedAmount` and only pauses when it crosses a high-water mark, then waits for
the buffer to fall back. Chunks a resumed transfer already has are counted as
progress, so the bar starts where it stopped rather than jumping backwards.

### Torrent-like: several peers serving one file

A one-to-one chat has exactly one source, so there is nothing to swarm there —
the parallelism lives inside the link. **Rooms are where it pays**: a video one
person shared can be pulled from everyone who already has it, in parallel, which
is the difference between waiting for one phone's uplink and using all of them.

Each member that finishes a file announces it holds that file. When a transfer
starts, the receiver splits the missing chunks across every holder — round-robin,
not contiguous blocks, so a slow peer delays only its own share rather than
leaving one long tail — and tells the original sender to **skip** what the others
are covering. If a peer disappears or serves bad data, only its unfinished chunks
are re-queued; everything already verified is kept.

Verified by a test with three peers in a room: one member serves chunks of a file
it never authored, and the author is told to skip what the peer is covering.

### Trusting the bytes

- **The file id is its SHA-256.** Identical files deduplicate, and a resumed
  transfer is provably the same file rather than one that merely shares a name.
  If the receiver already has it, nothing is sent at all.
- **A piece manifest travels with the offer.** The file is hashed once, into both
  a whole-file digest and a hash per 256 KB piece, so a chunk can be checked the
  moment its piece completes instead of after the whole download. That is what
  makes pulling from several peers safe: a peer that serves rubbish is caught
  while the transfer is running.
- **Hashing streams.** Web Crypto can only digest a buffer it holds entirely in
  memory, which on a phone means a second copy of a 100 MB video.
  `src/sha256.js` is an incremental implementation — checked against the NIST
  vectors and cross-checked against Node's own `crypto` at every awkward length
  and split — so hashing any size costs nothing extra and reports progress.
- **The bitmap stays small.** One bit per chunk: a 100 MB file is 800 bytes, so
  it fits in the control message sent on every reconnect.

Disappearing messages apply to files too, and take the bytes with them: when a
message expires, the sweeper drops any stored blob nothing points at any more.

### What this cannot do

- **A transfer needs both people online.** There is nowhere to park a file and
  nothing to resume against while the other side is away.
- **Media in rooms goes over direct links only**, never through the hub relay.
  The hub would have to see the bytes, and the group text path is sealed per
  recipient precisely so that it cannot. If a member has no direct link to
  anybody holding the file, they do not get it.
- **Storage is your device's.** Received files live in IndexedDB until the
  message is cleared or expires, and count against the browser's quota.

---

## Continuous integration

Two workflows in `.github/workflows`:

| Workflow | Trigger | What it does |
|---|---|---|
| **CI** | every push to `main` and every pull request | unit tests, the browser suite on the runner's own Chrome, and a debug APK uploaded as an artifact |
| **Release** | a `v*` tag, or manually | a release APK, signed if the keystore secrets are set, attached to the GitHub release |

A third job, **Android end-to-end**, installs the APK on an emulator and runs the
`test:android` suite. It only runs on `workflow_dispatch`, because an emulator
takes minutes and should verify a release rather than block a merge. Trigger it
by hand from the Actions tab when you want it.

### What CI needs

Nothing but the repository. GitHub's Ubuntu runners already have Google Chrome
and the Android SDK, and a **debug APK is signed with an automatically generated
debug keystore**, so no secrets are involved. The workflow installs
`platforms;android-36` and `build-tools;36.0.0` because the Capacitor project
targets API 36 and the preinstalled image may lag behind.

The order matters: `dist/` and the Capacitor asset directory are build outputs
and are not committed, so the APK job runs `npm run build:web` and `npx cap sync
android` before Gradle.

### Optional: a signed release APK

Debug APKs are fine for testing and cannot be published. To produce an installable
release build, add four repository secrets under **Settings → Secrets and
variables → Actions**:

| Secret | What it is |
|---|---|
| `ANDROID_KEYSTORE_BASE64` | your `.jks` file, base64 encoded: `base64 -i release.jks \| pbcopy` |
| `ANDROID_KEYSTORE_PASSWORD` | the store password |
| `ANDROID_KEY_ALIAS` | the key alias |
| `ANDROID_KEY_PASSWORD` | the key password |

Create the keystore once, and keep it somewhere you will not lose it — Android
will not accept an update signed with a different key:

```bash
keytool -genkeypair -v -keystore release.jks -alias wisp \
  -keyalg RSA -keysize 2048 -validity 10000
```

Without those secrets the Release workflow still succeeds: it builds an unsigned
APK, names it `-UNSIGNED` so nobody tries to install it, and says so in the log.
The signing config only engages when `WISP_KEYSTORE` is set, so a fork builds
with no secrets at all.

---

## The shell

The whole app follows the layout people already know, rather than inventing one:
a bottom tab bar, a chat list, and a conversation you tap into.

| Where | What it does |
|---|---|
| **Chats tab** | the list, with a badge for unread, a search box, and a floating compose button |
| **Settings tab** | your nickname, how much you share, and your key fingerprint |
| **Conversation** | compact header, bubbles with tails, ticks, day separators, call buttons |
| **Call** | full-screen video, self view, mute, camera, speaker, end |
| **Contact info** | tap the name in the header: identity, security code, disappearing messages, clear and delete |

**Long press** is the main gesture, as it is everywhere else. On a chat row it
offers pin, mark as read, disappearing messages and delete — pinned chats sort to
the top. On a message it offers reply, copy, star, message info and delete.

**Reply** quotes the original inside your bubble, and the quote travels with the
message so the other side sees the same thing. **Typing…** appears in their header
while they type — a real signal over the data channel, throttled to one notice
every couple of seconds so it costs nothing. When a link drops the header falls
back to **last seen today at 14:32** rather than a bare "offline".

**Voice notes** come from the microphone button, which replaces send whenever the
composer is empty. Recording shows a timer, caps at a minute, and goes out down
the same resumable path as any other file.

Deliberately absent: Status and Communities tabs. They would be decoration
— there is no audience to broadcast to and no directory to build a community
from. Two tabs that work beat five that do not.

---

## Calls

A call renegotiates the connection the chat is already using, and the SDP for
that travels over the data channel. There is no signalling server to add and none
is needed — the link that carries the messages carries the call setup too. Only
the caller ever offers, so there is no glare to resolve.

Tap the phone or camera in a conversation. The other side gets a full-screen
invitation to accept or decline; accepting connects in well under a second on a
local link.

### Compression, and deciding what the network can take

| Where | What is done, and why |
|---|---|
| **Opus** | In-band FEC so a lost packet is reconstructed rather than heard as a click, and DTX so nothing is sent while nobody is speaking — on a phone that is most of the time. |
| **Video codec** | VP9 first, then AV1, VP8 and H.264. Better compression at the same bitrate is free quality. |
| **Capture** | 640×480 at 24 fps. Asking a phone for more is what makes it hot and saturates an uplink that was never going to carry 1080p. |
| **Every two seconds** | The call reads its own stats and picks a profile. |

Four profiles, and the call moves between them on its own:

| Tier | Video | Bitrate | Scale | Frames |
|---|---|---|---|---|
| Good | on | 1.5 Mbps | full | 30 |
| Fair | on | 700 kbps | ½ | 24 |
| Poor | on | 220 kbps | ¼ | 15 |
| Audio only | **off** | — | ¼ | 10 |

Three decisions worth stating:

- **Symptoms decide the tier, not predictions.** Loss, round-trip time and jitter
  move it. An earlier version also trusted the browser's estimate of available
  bandwidth and duly pronounced a flawless loopback call "audio only", because
  that estimate starts near zero and climbs. The estimate is still used, but only
  to cap the bitrate *within* the current tier, halved — aiming at it exactly is
  how a call ends up oscillating.
- **Dropping is immediate; recovering takes three calm samples.** A stuttering
  call is worse than a soft one, and flapping between tiers is worse than waiting.
- **The last resort is a real switch.** Dropping to audio-only stops the camera
  track rather than setting a bitrate of zero.

### Testing a call without a microphone

A headless browser has no camera and no microphone, and asks the operating system
for one in vain — on this machine `getUserMedia` never resolves at all. Rather
than skip the test, the suite installs a canvas and an oscillator: real tracks
that really encode and really travel, so the whole path is exercised without
depending on hardware.

Twelve end-to-end tests cover a call being offered, accepted, declined and ended;
audio and video bytes actually arriving rather than merely being negotiated; mute
reaching the other side; the self view; and the chat link still working
afterwards.

---

## Groups

A room is one manual code exchange **per member**, all with whoever created the
room — not one per pair. Those first links are then used as signaling channels:
members tunnel WebRTC offers and answers through them and build a direct mesh
between every pair.

```
        host ──────── member one
          │  ╲           │
          │   ╲          │      solid = direct data channel
          │    ╲         │      the host relays signaling, not plaintext
          │     ╲        │
        member two ──────┘
```

Because one code carries exactly one answer, the host taps **+ Invite someone**
to mint a fresh code for each additional member. Every code in a room shares the
same room ID and the same identity, which is how members recognise one another.

**The relay cannot read what it relays.** Group messages are sealed separately
for each recipient with a key derived from the two long-term identity keys
(ECDH over P-256), and forwarded verbatim. If a direct link between two members
fails — common on hostile NATs — the message still arrives through the room,
still as ciphertext only the recipient can open. The test suite asserts exactly
this by tapping the hub's data channel and checking that a forwarded frame does
not contain the plaintext.

---

## Hard limits (by construction, not by oversight)

| Limit | Why |
|---|---|
| **No offline messages** | There is nowhere to queue them. Both people must be online at the same time. |
| **No push notifications** | APNs and FCM are servers. This is a live-session app, not a WhatsApp replacement. |
| **iOS suspends backgrounded tabs** | The data channel dies seconds after backgrounding. |
| **Android needs a foreground service** | For any background behaviour at all. |
| **~10–20% of mobile pairs cannot connect** | Both sides behind symmetric NAT or carrier-grade NAT need a TURN relay. This build is STUN-only (`stun.l.google.com`, `stun.cloudflare.com`). |
| **A reload loses the connection** | ICE/DTLS state lives in the page. The invite must be created and completed in the same tab. |
| **One-shot invites** | Links are bearer tokens: anyone holding one can attempt to connect. They carry a timestamp and the UI warns after 15 minutes. |

### Adding TURN

Change `DEFAULT_ICE_SERVERS` in `src/sdp.js` to include a relay, and supply
short-lived credentials from a tiny endpoint (Cloudflare's TURN has a 1 TB free
tier at $0.05/GB after that). DTLS still provides end-to-end encryption, so the
relay forwards ciphertext it cannot read.

---

## Layout

```
index.html styles.css sw.js manifest.webmanifest   app shell + offline cache
serve.mjs                                          static server; --lan --https prints a pairing QR
src/
  codec.js      byte packing, base64url, deflate-raw
  sdp.js        SDP skeleton capture, field extraction, candidate packing
  crypto.js     P-256 identity, signatures, ECDH, short auth string
  payload.js    signed invite encode/decode, code and link parsing
  qr.js         QR encoder (ISO/IEC 18004) + canvas/terminal rendering
  scan.js       camera scanning via BarcodeDetector
  nfc.js        NDEF write/read, error translation
  session.js    one direct link: non-trickle ICE, data channel, states
  group.js      rooms: mesh bootstrap over data channels, sealed messages
  identity.js   sharing modes, contact cards, key storage
  config.js     the product name, and every date/number format
  chats.js      conversations, history, disappearing-message rules
  sha256.js     streaming SHA-256: the file identity and the integrity check
  media.js      chunking, back-pressure, bitmaps, transfer protocol
  transfers.js  durable chunks and transfer records, so a drop is survivable
  swarm.js      who fetches which chunk from which peer, and what to do when one leaves
  call.js       calls: media, renegotiation, and the policy for a changing network
  store.js      IndexedDB
  app.js        UI state machine
test/
  unit/        157 tests: codec, SDP templating, signatures, SAS, QR, chat rules,
               SHA-256 (against NIST vectors), chunking, resume, swarm scheduling
  e2e/          real Chrome: handshake, forged codes, QR/NFC pairing, groups, phones
                plus android.test.mjs, which drives the installed APK over CDP
tools/
  build-web.mjs     collects the static app into dist/ for the APK
  android-cdp.mjs   minimal DevTools client (Playwright refuses a WebView endpoint)
  turn-server.mjs   local relay, for the pairs STUN cannot connect
  demo.mjs          screenshots and a manual playground
android/            Capacitor project, native plugin, foreground service
```

## The name

It lives in exactly one place — `src/config.js`:

```js
export const APP_NAME = 'Wisp';
export const APP_TAGLINE = 'Chats that leave no trace';
```

The app bar, the window title, the manifest and the docs read from it. Renaming
is that one line plus `npm run build:android`; the Android label and package id
(`chat.wisp.app`) are the only things that need editing separately.

The name is meant to fit the product: a wisp is a thin curl of smoke — private,
soft, and gone the moment you look away, which is what a disappearing message is.
Worth knowing before shipping: no trademark search has been done, and that is a
per-market question.

## Testing notes

The end-to-end suite drives the **real UI** in real Chrome with isolated browser
profiles per peer, so the code path under test is the one a person takes. It
proves a live `RTCDataChannel` opens and messages round-trip, that a
single-character corruption is refused, that a reply code pasted into a fresh tab
is rejected with guidance, and that a three-member room forms a mesh in which the
hub only ever handles ciphertext.

Two tests are worth calling out:

- **QR pairing is a real screen-to-sensor path.** The app draws the code on a
  canvas and the *browser's own* `BarcodeDetector` reads it back; the decoded
  text then drives the other peer. Nothing is mocked.
- **The chat suite reloads the page mid-test** to prove history really is on
  disk, and sets a one-second timer to watch a message expire on both devices
  rather than trusting that it would.
- **The file suite kills the link mid-transfer.** It sends 4 MB, pulls the
  connection out part-way, checks the partial chunks are still on disk and the
  sender says nothing was lost, then pairs again and asserts the second attempt
  *skipped* bytes it knew were already there — finishing with the digest the
  sender promised. Resume is measured, not assumed.
- **The mobile suite runs phone viewports with touch input** and checks that
  nothing overflows and the QR stays scannable. It also runs a profile with
  `BarcodeDetector` and `NDEFReader` deleted — that is iOS Safari — and asserts
  the app hides the buttons that cannot work, explains the system camera path,
  and still pairs by typing.

NFC has no hardware here, so a stand-in `NDEFReader` verifies the records we
write, the parsing we do, and the error messages; the real tag interaction is the
one thing you have to try on a device.

Screenshots and a manual demo: `node tools/demo.mjs`.

## Android app

The APK is built, installed and verified on a real Android runtime. Everything
below was exercised by `npm run test:android`, which drives the actual app over
the Chrome DevTools Protocol rather than a desktop imitation of one:

| Checked | Result |
|---|---|
| App boots from bundled assets on `https://localhost` | secure context, `crypto.subtle` available — no certificate handling anywhere |
| Invite arrives as an Android intent (`wisp://pair#i=…`) | parsed, signature verified, nickname shown |
| Handshake across phone and desktop | connects; **short auth strings match** on both ends |
| Messages both directions | delivered |
| App hidden with the Home button | **link stays open and a message sent meanwhile still arrives** |
| Foreground service | running, reported by `dumpsys` |
| NFC on a device with no NFC radio | buttons hidden, clear explanation, everything else still works |

### What the native app adds

| What | Why the PWA cannot do it |
|---|---|
| **Foreground service** | A backgrounded browser tab loses the data channel within seconds. Verified above: a message sent while the app was hidden still arrived. The price is a permanent notification — Android offers no way to hold a connection open without telling the user. |
| **NFC via a native plugin** | Web NFC is a Chrome-*browser* API and is absent inside a WebView. `WispPlugin.java` implements NDEF read/write against the platform API instead. |
| **Invite links as intents** | `wisp://pair#i=CODE` opens the app with the code. A verified https App Link is stronger but needs a domain serving `/.well-known/assetlinks.json`; the custom scheme works without one and is treated as untrusted — the code is signature-checked on arrival like any other. |

`BarcodeDetector` *is* present in this WebView, so in-app QR scanning works
unchanged inside the app. On WebViews that lack it, the UI already falls back to
the system camera app.

### Build and run

```bash
source .android-env.sh                      # JDK 21 + SDK paths, all inside the project
npm run build:android                       # dist/ -> cap sync -> gradle assembleDebug
adb install -r android/app/build/outputs/apk/debug/app-debug.apk
```

Emulator, without a physical phone:

```bash
npm run emulator &                          # headless AVD
npm run test:android                        # drives the installed app over CDP
```

The test skips cleanly when no emulator is present, so the suite stays green on a
machine without the toolchain.

### Two findings worth knowing

**An emulator cannot reach a browser on the host directly.** It sits behind
QEMU's NAT, which is exactly the symmetric-NAT case STUN cannot traverse — the
first attempt failed with the app's own "this needs a TURN relay" message. The
test therefore starts a local TURN server (`npm run turn`) and points both sides
at it, which both fixes the test and exercises the relay path recommended for the
~10–20% of real mobile pairs. Add your own relay at runtime with
`?ice=turn:host:3478&iceUser=u&icePass=p`, or in `DEFAULT_ICE_SERVERS`.

**The emulator image has no NFC radio**, and the emulator console has no NFC
command, so a tag tap cannot be simulated here: the NDEF write/read path is the
one thing that needs a physical tag and a phone that has the hardware. What *is*
verified is that the app detects the missing radio (the plugin reports `nfc:
false` even though the WebView happily exposes `NDEFReader` — that combination is
why the hardware answer has to win) and hides the controls instead of offering a
button that cannot work.

### Not fixed by packaging

No offline messages (there is nowhere to queue them), no push without a server,
and the ~10–20% of mobile pairs that need TURN. Those are properties of the
architecture, not of the wrapper.
