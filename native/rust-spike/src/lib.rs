//! A WebRTC data channel, in Rust, for Android.
//!
//! This exists to answer two questions with numbers rather than opinions: does it
//! build for Android without a prebuilt binary, and how big is the result?

use std::sync::Arc;

use webrtc::data_channel::DataChannel;
use webrtc::error::Result;
use webrtc::peer_connection::{
    MediaEngine, PeerConnection, PeerConnectionBuilder, RTCConfigurationBuilder, RTCIceServer, Registry,
    register_default_interceptors,
};

/// The ICE configuration the web client uses by default.
pub fn configuration() -> webrtc::peer_connection::RTCConfiguration {
    RTCConfigurationBuilder::new()
        .with_ice_servers(vec![RTCIceServer {
            urls: vec!["stun:stun.l.google.com:19302".to_owned()],
            ..Default::default()
        }])
        .build()
}

pub async fn new_peer() -> Result<impl PeerConnection> {
    let mut media_engine = MediaEngine::default();
    media_engine.register_default_codecs()?;
    let registry = register_default_interceptors(Registry::new(), &mut media_engine)?;

    PeerConnectionBuilder::new()
        .with_configuration(configuration())
        .with_media_engine(media_engine)
        .with_interceptor_registry(registry)
        .with_udp_addrs(vec!["0.0.0.0:0"])
        .build()
        .await
}

/// The channel that chat, pairing and file transfers would all ride on.
pub async fn open_channel(peer: &impl PeerConnection) -> Result<Arc<dyn DataChannel>> {
    peer.create_data_channel("chat", None).await
}

pub fn version() -> &'static str {
    env!("CARGO_PKG_VERSION")
}

/// The audio pipeline a call needs, in pure Rust.
///
/// This is the part I assumed would force a dependency on libwebrtc: echo
/// cancellation is the difference between a call and an unusable racket, and it
/// is why the C++ library is enormous. Referencing the real types here makes the
/// linker include them, so the size below is the honest one.
pub mod audio {
    pub use sonora::{AudioProcessing, AudioProcessingBuilder, Config, StreamConfig};

    pub fn processor() -> AudioProcessing {
        AudioProcessing::builder()
            .config(Config::default())
            .capture_config(StreamConfig::new(16000, 1))
            .render_config(StreamConfig::new(16000, 1))
            .build()
    }
}

/// Exported entry points, which is what a JNI surface would look like.
///
/// These matter for the measurement: an unreferenced `pub fn` in a shared
/// library is dropped by the linker, so without these the size below would be
/// the size of nothing at all.
#[no_mangle]
pub extern "C" fn wisp_spike_build_peer() -> u32 {
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .expect("runtime");
    runtime.block_on(async {
        match new_peer().await {
            Ok(_peer) => 1,
            Err(_) => 0,
        }
    })
}

#[no_mangle]
pub extern "C" fn wisp_spike_audio_new() -> *mut std::ffi::c_void {
    Box::into_raw(Box::new(audio::processor())) as *mut std::ffi::c_void
}

#[no_mangle]
pub extern "C" fn wisp_spike_version() -> *const std::ffi::c_char {
    static VERSION: &[u8] = b"0.1.0\0";
    VERSION.as_ptr() as *const std::ffi::c_char
}
