# Rust spike

Two questions, answered with measurements rather than opinions:

1. **How big is libwebrtc, really?** The claim that started this was "~100 MB".
2. **Can a Rust peer talk to a browser?** Size is irrelevant if it cannot.

Neither answer is a guess. Both can be re-run.

## The dependency, measured

```
io.github.webrtc-sdk:android:125.6422.07     41.7 MB   (the whole AAR)
  classes.jar                                 0.9 MB
  jni/armeabi-v7a/libjingle_peerconnection.so 6.2 MB
  jni/arm64-v8a/libjingle_peerconnection.so  10.9 MB
  jni/x86/libjingle_peerconnection.so        12.1 MB
  jni/x86_64/libjingle_peerconnection.so     12.7 MB
```

The 41.7 MB is a **build-time** figure. An installed app carries one ABI, so a
phone downloads about 11 MB of native code, and Play Store app bundles split by
ABI automatically. "~100 MB" was wrong; the honest number is 41.7 MB in the
build, 10.9 MB on an arm64 device.

For completeness: Google no longer publishes `org.webrtc:google-webrtc` — it has
**zero artifacts on Maven Central**. The maintained build is a community mirror,
which is its own reason to prefer compiling from source.

## The Rust build, measured

`src/lib.rs` links the real stack — `webrtc` for ICE/DTLS/SCTP, `sonora` for
echo cancellation, noise suppression and gain control, and a Tokio runtime — and
exports entry points, because an unreferenced `pub fn` in a shared library is
dropped by the linker and would have measured the size of nothing.

```
arm64, stripped:

  Rust (webrtc + sonora + tokio)   4.86 MB
  libwebrtc (C++)                 10.85 MB
```

Built for `aarch64-linux-android` with nothing but the NDK. No prebuilt binary
is downloaded at any point.

## The interop, proven

Compiling is not connecting. `src/bin/interop.rs` is a Rust peer that offers a
data channel, and `interop.mjs` drives a real headless Chrome to answer it:

```
  ICE + DTLS between Rust and Chrome : yes
  Rust -> browser                    : "hello from rust"
  browser -> Rust                    : RECEIVED hello from browser
```

Run it yourself:

```bash
cd native/rust-spike
cargo build --release --bin interop
node interop.mjs            # CHROME_PATH=... if Chrome is somewhere unusual
```

To build for Android you also need the NDK, and the compilers on `PATH` so that
C dependencies can find them:

```bash
export NDK=$ANDROID_HOME/ndk/<version>/toolchains/llvm/prebuilt/<host>/bin
PATH="$NDK:$PATH" \
CC_aarch64_linux_android="$NDK/aarch64-linux-android24-clang" \
AR_aarch64_linux_android="$NDK/llvm-ar" \
cargo build --release --target aarch64-linux-android
```

## What this does and does not settle

**Settled.** The Rust stack builds for Android from source, is less than half
the size of libwebrtc, includes the audio processing a call needs, and
interoperates with Chrome over a data channel.

**Not settled.** Three things, in order of how much they worry me:

- **Video.** Nothing here encodes or decodes a picture. On Android the right
  answer is MediaCodec — the hardware codec the phone already has — reached over
  JNI, which costs no binary size at all. But that is integration work, and
  libwebrtc bundles software codecs as a fallback that Rust would not have.
- **Audio quality.** `sonora` is a pure-Rust port of WebRTC's audio processing
  and is at 0.2.0. It is the difference between a call and an unusable racket,
  and the C++ original has fifteen years of tuning behind it. This is the place
  I would expect a Rust client to sound worse, and the place worth testing on a
  real phone before committing.
- **Congestion control.** libwebrtc's bandwidth estimation and jitter buffer are
  mature and heavily deployed. `webrtc` has equivalents; they are younger.

## The decision

**libwebrtc was chosen.** 10.85 MB per ABI is acceptable for what it brings —
software codecs as well as hardware ones, mature congestion control, and audio
processing with fifteen years of tuning. The measurement above is why the
question could be settled in a minute rather than an argument: the number was
41.7 MB in the build and 10.9 MB on a device, not the ~100 MB that started this.

This directory stays as the record of the evaluation, and `interop.rs` still runs
if the question is ever reopened. It is no longer part of CI, because it guards
nothing that ships.

## What the spike established either way

The size argument for Rust is real but smaller than it first appears: 4.86 MB
against 10.85 MB, not 5 MB against 100 MB. The stronger arguments are that the
binary is compiled from source in CI with no third-party blob, and that one Rust
core could serve the Android client and the desktop one, replacing two
implementations of the wire format with one.

The remaining risk is concentrated in media, not transport. A sensible order is
therefore: build the **connection and file transfer** on Rust, where it is
already proven, and decide about **calls** after testing `sonora` against
libwebrtc's audio processing on a real phone.
