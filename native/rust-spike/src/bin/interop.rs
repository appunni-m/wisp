//! Can a Rust peer talk to a real browser?
//!
//! Size and buildability are settled; this is the question that decides the
//! architecture. The harness spawns this binary, relays its offer to Chrome,
//! feeds the answer back, and checks that a message crosses both ways.
//!
//! SDP goes out on stdout, one line, and the answer comes back on stdin. Crude,
//! but it keeps the experiment to the part under test.

use std::io::{BufRead, Write};
use std::sync::Arc;
use std::time::Duration;

use webrtc::data_channel::DataChannelEvent;
use webrtc::peer_connection::{
    MediaEngine, PeerConnection, PeerConnectionBuilder, PeerConnectionEventHandler, RTCConfigurationBuilder,
    RTCIceGatheringState, RTCPeerConnectionState, RTCSessionDescription, Registry,
    register_default_interceptors,
};

fn line(text: &str) {
    println!("{text}");
    std::io::stdout().flush().ok();
}

#[derive(Clone)]
struct Handler {
    gathered: tokio::sync::mpsc::Sender<()>,
    state: tokio::sync::mpsc::Sender<RTCPeerConnectionState>,
}

#[async_trait::async_trait]
impl PeerConnectionEventHandler for Handler {
    async fn on_ice_gathering_state_change(&self, state: RTCIceGatheringState) {
        if state == RTCIceGatheringState::Complete {
            let _ = self.gathered.try_send(());
        }
    }

    async fn on_connection_state_change(&self, state: RTCPeerConnectionState) {
        let _ = self.state.try_send(state);
    }
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let mut media_engine = MediaEngine::default();
    media_engine.register_default_codecs()?;
    let registry = register_default_interceptors(Registry::new(), &mut media_engine)?;

    let (gathered_tx, mut gathered_rx) = tokio::sync::mpsc::channel::<()>(4);
    let (state_tx, mut state_rx) = tokio::sync::mpsc::channel::<RTCPeerConnectionState>(16);

    let peer = PeerConnectionBuilder::new()
        .with_configuration(RTCConfigurationBuilder::new().build())
        .with_media_engine(media_engine)
        .with_interceptor_registry(registry)
        .with_handler(Arc::new(Handler { gathered: gathered_tx, state: state_tx }))
        .with_udp_addrs(vec!["127.0.0.1:0"])
        .build()
        .await?;

    let channel = peer.create_data_channel("chat", None).await?;

    // The channel reports everything through one poll loop.
    let (event_tx, mut event_rx) = tokio::sync::mpsc::channel::<String>(16);
    {
        let channel = channel.clone();
        tokio::spawn(async move {
            while let Some(event) = channel.poll().await {
                match event {
                    DataChannelEvent::OnOpen => {
                        let _ = event_tx.send("open".to_owned()).await;
                    }
                    DataChannelEvent::OnMessage(message) => {
                        let text = String::from_utf8_lossy(&message.data).to_string();
                        let _ = event_tx.send(format!("message:{text}")).await;
                        if text.starts_with("hello from browser") {
                            let _ = channel.send_text("hello from rust").await;
                        }
                    }
                    DataChannelEvent::OnClose => {
                        let _ = event_tx.send("closed".to_owned()).await;
                        break;
                    }
                    _ => {}
                }
            }
        });
    }

    let offer = peer.create_offer(None).await?;
    peer.set_local_description(offer).await?;
    let _ = tokio::time::timeout(Duration::from_secs(5), gathered_rx.recv()).await;

    let local = peer.local_description().await.ok_or("no local description")?;
    // One line, so a CRLF pair cannot become two separators and reopen the
    // blank line it came from.
    let flattened = local.sdp.replace("\r\n", "\n").replace('\n', "|");
    line(&format!("OFFER\t{flattened}"));

    let mut input = String::new();
    std::io::stdin().lock().read_line(&mut input)?;
    let sdp = input
        .trim()
        .strip_prefix("ANSWER\t")
        .ok_or("expected an ANSWER line")?
        .replace('|', "\r\n");
    peer.set_remote_description(RTCSessionDescription::answer(sdp)?).await?;

    let mut connected = false;
    let deadline = tokio::time::Instant::now() + Duration::from_secs(25);
    while tokio::time::Instant::now() < deadline {
        if let Ok(Some(state)) = tokio::time::timeout(Duration::from_millis(200), state_rx.recv()).await {
            line(&format!("STATE {state:?}"));
            if state == RTCPeerConnectionState::Connected {
                connected = true;
                break;
            }
            if state == RTCPeerConnectionState::Failed {
                break;
            }
        }
    }
    line(&format!("CONNECTED {connected}"));
    if !connected {
        return Ok(());
    }

    // The connection being up is not the channel being open: DCEP still has to
    // run over the fresh SCTP association, and sending before that fails.
    let mut open = false;
    let deadline = tokio::time::Instant::now() + Duration::from_secs(15);
    while tokio::time::Instant::now() < deadline {
        match tokio::time::timeout(Duration::from_millis(500), event_rx.recv()).await {
            Ok(Some(event)) if event == "open" => {
                open = true;
                break;
            }
            Ok(Some(event)) if event.starts_with("message:") => {
                line(&format!("EARLY {}", &event["message:".len()..]));
            }
            Ok(None) => break,
            _ => {}
        }
    }
    line(&format!("OPEN {open}"));
    if !open {
        return Ok(());
    }

    channel.send_text("hello from rust").await?;
    line("SENT hello from rust");

    let deadline = tokio::time::Instant::now() + Duration::from_secs(20);
    loop {
        let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
        if remaining.is_zero() {
            line("RECEIVED nothing");
            break;
        }
        match tokio::time::timeout(remaining, event_rx.recv()).await {
            Ok(Some(event)) if event.starts_with("message:") => {
                line(&format!("RECEIVED {}", &event["message:".len()..]));
                break;
            }
            Ok(Some(other)) => line(&format!("EVENT {other}")),
            _ => {
                line("RECEIVED nothing");
                break;
            }
        }
    }

    line("DONE");
    tokio::time::sleep(Duration::from_millis(300)).await;
    peer.close().await.ok();
    Ok(())
}
