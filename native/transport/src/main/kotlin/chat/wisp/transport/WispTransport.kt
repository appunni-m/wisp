package chat.wisp.transport

import org.webrtc.DataChannel
import org.webrtc.IceCandidate
import org.webrtc.MediaConstraints
import org.webrtc.MediaStream
import org.webrtc.PeerConnection
import org.webrtc.PeerConnectionFactory
import org.webrtc.SdpObserver
import org.webrtc.SessionDescription
import org.webrtc.SoftwareVideoDecoderFactory
import org.webrtc.SoftwareVideoEncoderFactory

import chat.wisp.protocol.SdpCandidate
import chat.wisp.protocol.SdpFields
import chat.wisp.protocol.buildSdpFromSkeleton
import chat.wisp.protocol.extractSdpFields

/**
 * The peer connection, wrapped so the app never touches org.webrtc directly.
 *
 * The pairing design rests on a skeleton: a session description captured once
 * from this device, against which only the handful of values that actually
 * differ are exchanged. libwebrtc produces those descriptions, so this class is
 * the thing that captures one and rebuilds the other side's.
 *
 * Everything here is callback-shaped because that is what libwebrtc is;
 * [awaitConnected] and friends turn it back into something sequential at the
 * edges rather than pretending the callbacks are not there.
 */
class WispTransport(
    private val iceServers: List<PeerConnection.IceServer> = DEFAULT_ICE_SERVERS,
) {

    companion object {
        /**
         * STUN only. Roughly one pair in ten is behind a NAT that needs a relay,
         * which is what configureIceServers() exists for.
         */
        val DEFAULT_ICE_SERVERS: List<PeerConnection.IceServer> = listOf(
            PeerConnection.IceServer.builder("stun:stun.l.google.com:19302").createIceServer(),
            PeerConnection.IceServer.builder("stun:cloudflare.com:3478").createIceServer(),
        )

        /** How long to wait for candidates before sealing an invite anyway. */
        const val GATHERING_TIMEOUT_MS = 4000L

        private var initialized = false

        /** libwebrtc wants a context and a set of codec factories, once per process. */
        @Synchronized
        fun initialize() {
            if (initialized) return
            PeerConnectionFactory.initialize(
                PeerConnectionFactory.InitializationOptions.builder(AndroidContext.get())
                    .createInitializationOptions(),
            )
            initialized = true
        }
    }

    private var factory: PeerConnectionFactory? = null
    private var peer: PeerConnection? = null
    private var channel: DataChannel? = null

    /** The skeleton this device offers against: captured once, reused for every invite. */
    var skeleton: String? = null

    var onMessage: ((String) -> Unit)? = null
    var onBinary: ((ByteArray) -> Unit)? = null
    var onOpen: (() -> Unit)? = null
    var onClosed: (() -> Unit)? = null
    var onStateChange: ((PeerConnection.PeerConnectionState) -> Unit)? = null
    var onIceCandidate: ((IceCandidate) -> Unit)? = null

    private fun factory(): PeerConnectionFactory {
        factory?.let { return it }
        initialize()
        val built = PeerConnectionFactory.builder()
            // Software codecs only for now: hardware ones need a surface and a
            // capture session, which belong with the call screens rather than here.
            .setVideoDecoderFactory(SoftwareVideoDecoderFactory())
            .setVideoEncoderFactory(SoftwareVideoEncoderFactory())
            .createPeerConnectionFactory()
        factory = built
        return built
    }

    /**
     * Wait for candidate gathering to finish, then hand back the description.
     *
     * This is not an optimisation. Gathering is asynchronous, so reading the
     * local description the moment it is set produces a description with no
     * candidates in it at all — which is an invite nobody can connect to, and
     * which looks perfectly valid.
     *
     * The wait is bounded because a STUN server that never answers must not hang
     * the button; whatever was gathered by then is still usable, and two peers on
     * the same network need nothing but their host candidates.
     */
    private fun awaitGathering(
        connection: PeerConnection,
        // The callback is last so a trailing lambda binds to it rather than to
        // the timeout.
        timeoutMs: Long = GATHERING_TIMEOUT_MS,
        onReady: (String) -> Unit,
    ) {
        val started = android.os.SystemClock.elapsedRealtime()
        val handler = android.os.Handler(android.os.Looper.getMainLooper())
        val poll = object : Runnable {
            override fun run() {
                val complete = connection.iceGatheringState() == PeerConnection.IceGatheringState.COMPLETE
                val expired = android.os.SystemClock.elapsedRealtime() - started > timeoutMs
                if (complete || expired) {
                    onReady(connection.localDescription?.description ?: "")
                } else {
                    handler.postDelayed(this, 50)
                }
            }
        }
        handler.post(poll)
    }

    private fun configuration(): PeerConnection.RTCConfiguration =
        PeerConnection.RTCConfiguration(iceServers).apply {
            sdpSemantics = PeerConnection.SdpSemantics.UNIFIED_PLAN
            // A data-channel-only connection does not need a bundle policy, but
            // this matches what the browsers do and keeps the SDP shapes close.
            bundlePolicy = PeerConnection.BundlePolicy.MAXBUNDLE
            rtcpMuxPolicy = PeerConnection.RtcpMuxPolicy.REQUIRE
            continualGatheringPolicy = PeerConnection.ContinualGatheringPolicy.GATHER_CONTINUALLY
        }

    private fun attach(connection: PeerConnection, existing: DataChannel? = null) {
        peer = connection
        if (existing != null) {
            bind(existing)
        } else {
            val init = DataChannel.Init().apply { ordered = true }
            bind(connection.createDataChannel("chat", init))
        }
    }

    private fun bind(dataChannel: DataChannel) {
        channel = dataChannel
        dataChannel.registerObserver(object : DataChannel.Observer {
            override fun onBufferedAmountChange(previousAmount: Long) = Unit

            override fun onStateChange() {
                when (dataChannel.state()) {
                    DataChannel.State.OPEN -> onOpen?.invoke()
                    DataChannel.State.CLOSED -> onClosed?.invoke()
                    else -> Unit
                }
            }

            override fun onMessage(buffer: DataChannel.Buffer) {
                val bytes = ByteArray(buffer.data.remaining())
                buffer.data.get(bytes)
                // Binary frames carry file chunks; text carries control. The
                // distinction is the type of the frame, not a flag inside it.
                if (buffer.binary) onBinary?.invoke(bytes)
                else onMessage?.invoke(String(bytes, Charsets.UTF_8))
            }
        })
    }

    /** Capture a skeleton by offering once and keeping the shape of the result. */
    fun captureSkeleton(onReady: (String) -> Unit, onError: (String) -> Unit) {
        skeleton?.let { return onReady(it) }
        val connection = factory().createPeerConnection(configuration(), observer())
        if (connection == null) {
            onError("could not create a peer connection")
            return
        }
        connection.createDataChannel("chat", DataChannel.Init().apply { ordered = true })
        connection.createOffer(object : SdpObserverAdapter() {
            override fun onCreateSuccess(description: SessionDescription) {
                connection.setLocalDescription(SdpObserverAdapter(), description)
                // The shape is what matters here, and the shape does not depend
                // on gathering having finished: candidates are added later and
                // stripped again before this description is ever used.
                onReady(description.description)
            }

            override fun onCreateFailure(message: String) = onError(message)
        }, offerConstraints())
    }

    /** Step 1: produce an invite, and keep the connection that goes with it. */
    fun createOffer(
        onReady: (skeleton: String, fields: SdpFields) -> Unit,
        onError: (String) -> Unit,
    ) {
        val connection = factory().createPeerConnection(configuration(), observer())
        if (connection == null) {
            onError("could not create a peer connection")
            return
        }
        attach(connection)

        connection.createOffer(object : SdpObserverAdapter() {
            override fun onCreateSuccess(description: SessionDescription) {
                // The local description is set first: it is what gathering runs
                // against, and therefore what the candidates belong to.
                connection.setLocalDescription(object : SdpObserverAdapter() {
                    override fun onSetSuccess() {
                        awaitGathering(connection) { gathered ->
                            skeleton = gathered
                            onReady(gathered, extractSdpFields(gathered))
                        }
                    }

                    override fun onSetFailure(message: String) = onError(message)
                }, description)
            }

            override fun onCreateFailure(message: String) = onError(message)
        }, offerConstraints())
    }

    /**
     * Step 2: take the other person's invite and produce a reply.
     *
     * The remote description is rebuilt from our own skeleton, because only the
     * values that differ travelled.
     */
    fun acceptOfferAndAnswer(
        remote: SdpFields,
        skeletonForReply: String,
        onReady: (skeleton: String, fields: SdpFields) -> Unit,
        onError: (String) -> Unit,
    ) {
        val connection = factory().createPeerConnection(
            configuration(),
            observer(onDataChannel = { bind(it) }),
        )
        if (connection == null) {
            onError("could not create a peer connection")
            return
        }
        peer = connection

        val description = SessionDescription(
            SessionDescription.Type.OFFER,
            buildSdpFromSkeleton(skeletonForReply, remote),
        )
        connection.setRemoteDescription(object : SdpObserverAdapter() {
            override fun onSetSuccess() {
                connection.createAnswer(object : SdpObserverAdapter() {
                    override fun onCreateSuccess(answer: SessionDescription) {
                        connection.setLocalDescription(object : SdpObserverAdapter() {
                            override fun onSetSuccess() {
                                awaitGathering(connection) { gathered ->
                                    skeleton = gathered
                                    onReady(gathered, extractSdpFields(gathered))
                                }
                            }

                            override fun onSetFailure(message: String) = onError(message)
                        }, answer)
                    }

                    override fun onCreateFailure(message: String) = onError(message)
                }, offerConstraints())
            }

            override fun onSetFailure(message: String) = onError(message)
        }, description)
    }

    /** Step 3: the initiator takes the reply and the link comes up. */
    fun acceptAnswer(remote: SdpFields, onError: (String) -> Unit) {
        val connection = peer ?: return onError("no connection to answer")
        val description = SessionDescription(
            SessionDescription.Type.ANSWER,
            buildSdpFromSkeleton(skeleton ?: "", remote),
        )
        connection.setRemoteDescription(object : SdpObserverAdapter() {
            override fun onSetFailure(message: String) = onError(message)
        }, description)
    }

    fun send(text: String) {
        val data = DataChannel.Buffer(java.nio.ByteBuffer.wrap(text.toByteArray(Charsets.UTF_8)), false)
        channel?.send(data)
    }

    fun send(bytes: ByteArray) {
        val data = DataChannel.Buffer(java.nio.ByteBuffer.wrap(bytes), true)
        channel?.send(data)
    }

    val isOpen: Boolean get() = channel?.state() == DataChannel.State.OPEN

    fun close() {
        channel?.close()
        peer?.close()
        channel = null
        peer = null
    }

    fun dispose() {
        close()
        factory?.dispose()
        factory = null
    }

    private fun offerConstraints(): MediaConstraints = MediaConstraints().apply {
        // The data channel is the point; no audio or video is offered here.
        mandatory.add(MediaConstraints.KeyValuePair("OfferToReceiveAudio", "false"))
        mandatory.add(MediaConstraints.KeyValuePair("OfferToReceiveVideo", "false"))
    }

    private fun observer(onDataChannel: ((DataChannel) -> Unit)? = null) =
        object : PeerConnection.Observer {
            override fun onSignalingChange(state: PeerConnection.SignalingState) = Unit
            override fun onIceConnectionChange(state: PeerConnection.IceConnectionState) = Unit
            override fun onIceConnectionReceivingChange(receiving: Boolean) = Unit
            override fun onIceGatheringChange(state: PeerConnection.IceGatheringState) = Unit

            override fun onIceCandidate(candidate: IceCandidate) {
                // Trickle: candidates go out as they are found, which is what the
                // web client does too, so neither side waits for a complete set.
                onIceCandidate?.invoke(candidate)
            }

            override fun onIceCandidatesRemoved(candidates: Array<out IceCandidate>) = Unit

            override fun onAddStream(stream: MediaStream) = Unit
            override fun onRemoveStream(stream: MediaStream) = Unit

            override fun onDataChannel(dataChannel: DataChannel) {
                bind(dataChannel)
                onDataChannel?.invoke(dataChannel)
            }

            override fun onRenegotiationNeeded() = Unit

            override fun onConnectionChange(newState: PeerConnection.PeerConnectionState) {
                onStateChange?.invoke(newState)
            }
        }
}

/** libwebrtc's observer interface has no default methods; this is the boilerplate. */
internal open class SdpObserverAdapter : SdpObserver {
    override fun onCreateSuccess(description: SessionDescription) = Unit
    override fun onSetSuccess() = Unit
    override fun onCreateFailure(message: String) = Unit
    override fun onSetFailure(message: String) = Unit
}

/**
 * libwebrtc needs an Android Context to initialise, and this module has no
 * Activity to take one from. The app sets it once at startup.
 */
internal object AndroidContext {
    private var value: android.content.Context? = null

    fun set(context: android.content.Context) {
        value = context.applicationContext
    }

    fun get(): android.content.Context =
        value ?: error("WispTransport.install(context) must be called before any transport is created")
}

/** Call once, from Application.onCreate. */
fun installTransport(context: android.content.Context) {
    AndroidContext.set(context)
    WispTransport.initialize()
}
