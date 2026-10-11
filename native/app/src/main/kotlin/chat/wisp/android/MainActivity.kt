package chat.wisp.android

import android.content.Intent
import android.os.Bundle
import android.util.Log
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.unit.dp

import chat.wisp.protocol.Identity
import chat.wisp.protocol.Invite
import chat.wisp.protocol.InviteKind
import chat.wisp.protocol.SdpCandidate
import chat.wisp.protocol.SdpFields
import chat.wisp.protocol.extractCode
import chat.wisp.protocol.openInvite
import chat.wisp.protocol.publicKeyFromRaw
import chat.wisp.protocol.sealInvite
import chat.wisp.transport.WispTransport

/**
 * The smallest thing that can prove the native client pairs with the desktop one.
 *
 * Not the app: no chat list, no storage, no design. It creates an invite, takes
 * a reply, and reports whether a data channel came up — which is exactly the
 * acceptance test for the transport stage, and nothing more.
 */
class MainActivity : ComponentActivity() {

    private var transport: WispTransport? = null
    private val identity: Identity by lazy { Identity.generate() }

    /** State the UI reads, hoisted so an intent arriving later can change it. */
    private var statusState = mutableStateOf("Ready")
    private var inviteState = mutableStateOf("")
    private var replyState = mutableStateOf("")
    private var logState = mutableStateOf(listOf<String>())

    /** Relay and nickname, taken from the launching intent. */
    private var iceExtra: String? = null
    private var iceUser: String? = null
    private var icePass: String? = null

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        handleIntent(intent)
        setContent { MaterialTheme { Surface(Modifier.fillMaxSize()) { PairingScreen() } } }
        // An invite link that arrived before the UI existed still has to be used.
        pendingLink?.let { accept(it) }
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        handleIntent(intent)
        pendingLink?.let { accept(it) }
    }

    override fun onDestroy() {
        transport?.dispose()
        super.onDestroy()
    }

    private fun log(line: String) {
        // A stable prefix so a test harness can read the flow out of logcat
        // without a UI automation framework in the way.
        Log.i(TAG, line)
        logState.value = logState.value + line
    }

    private var pendingLink: String? = null

    /**
     * `wisp://pair#i=<code>` is what a QR code or an NFC tag carries, so opening
     * one has to work whether the app was running or not.
     */
    private fun handleIntent(intent: Intent?) {
        iceExtra = intent?.getStringExtra("ice") ?: iceExtra
        iceUser = intent?.getStringExtra("iceUser") ?: iceUser
        icePass = intent?.getStringExtra("icePass") ?: icePass

        val data = intent?.data ?: return
        val code = extractCode(data.toString()) ?: extractCode(data.fragment) ?: return
        log("link: ${code.length} characters")
        replyState.value = code
        pendingLink = code
    }

    private fun iceServers(): List<org.webrtc.PeerConnection.IceServer> {
        val raw = iceExtra ?: return WispTransport.DEFAULT_ICE_SERVERS
        val builder = org.webrtc.PeerConnection.IceServer.builder(raw)
        iceUser?.let { builder.setUsername(it) }
        icePass?.let { builder.setPassword(it) }
        // A relay is the only way some pairs connect at all, so a configured one
        // replaces the default STUN list rather than joining it.
        return listOf(builder.createIceServer())
    }

    /** Take a reply code and bring the link up. */
    private fun accept(code: String) {
        val opened = runCatching { openInvite(code) }
        val reply = opened.getOrNull()
        if (reply == null || !reply.verified) {
            statusState.value = "That reply did not verify"
            log("reply rejected")
            return
        }
        pendingLink = null
        statusState.value = "Reply accepted, connecting…"
        log("reply verified, connecting")

        val remote = SdpFields(
            sessionId = reply.invite.sessionId.toString(),
            ufrag = reply.invite.ufrag,
            pwd = reply.invite.pwd,
            fingerprint = chat.wisp.protocol.Fingerprint("sha-256", reply.invite.fingerprint),
            setup = reply.invite.setup,
            candidates = reply.invite.candidates.map {
                SdpCandidate("", it.component, it.transport, 0, it.address, it.port, it.type)
            },
        )
        transport?.acceptAnswer(remote) { message ->
            statusState.value = "Could not accept the reply: $message"
            log("accept failed: $message")
        }
    }

    companion object {
        const val TAG = "Wisp"
    }

    private fun buildInvite(skeleton: String, fields: SdpFields): Invite = Invite(
        kind = InviteKind.OFFER,
        sessionId = System.nanoTime(),
        ufrag = fields.ufrag ?: "",
        pwd = fields.pwd ?: "",
        fingerprint = fields.fingerprint?.value ?: "",
        setup = fields.setup ?: "actpass",
        candidates = fields.candidates.map {
            chat.wisp.protocol.Candidate(it.type, it.component, it.address, it.port, it.transport)
        },
        nick = "android",
        publicKey = identity.publicKey,
    )

    @Composable
    private fun PairingScreen() {
        val status by statusState
        val inviteCode by inviteState
        val replyInput by replyState
        val log by logState

        Column(
            Modifier.fillMaxSize().padding(16.dp).verticalScroll(rememberScrollState()),
            verticalArrangement = Arrangement.spacedBy(10.dp),
        ) {
            Text("Wisp", style = MaterialTheme.typography.headlineSmall)
            Text(status, style = MaterialTheme.typography.bodyMedium)

            Button(onClick = {
                statusState.value = "Creating an invite…"
                val created = WispTransport(iceServers()).also { transport = it }
                created.onStateChange = { state ->
                    log("state: $state")
                    if (state == org.webrtc.PeerConnection.PeerConnectionState.CONNECTED) statusState.value = "Connected"
                    if (state == org.webrtc.PeerConnection.PeerConnectionState.FAILED) statusState.value = "Failed"
                }
                created.onOpen = {
                    statusState.value = "Channel open"
                    log("open")
                    created.send("""{"t":"msg","text":"hello from android"}""")
                }
                created.onMessage = { text -> log("received: ${text.take(120)}") }

                created.createOffer(
                    onReady = { skeleton, fields ->
                        // Capturing the skeleton is what lets the reply be a
                        // handful of values rather than a whole description.
                        created.skeleton = skeleton
                        val invite = buildInvite(skeleton, fields)
                        val code = sealInvite(invite, identity)
                        inviteState.value = code
                        statusState.value = "Invite ready — ${code.length} characters"
                        log("candidates: ${fields.candidates.size}")
                        log("invite: $code")
                    },
                    onError = { statusState.value = "Could not create an invite: $it" },
                )
            }) { Text("Create an invite") }

            if (inviteCode.isNotEmpty()) {
                Text("Invite code", style = MaterialTheme.typography.labelLarge)
                Text(inviteCode, fontFamily = FontFamily.Monospace, style = MaterialTheme.typography.bodySmall)
            }

            OutlinedTextField(
                value = replyInput,
                onValueChange = { replyState.value = it },
                label = { Text("Paste the reply code") },
                modifier = Modifier.fillMaxWidth(),
            )

            Button(
                enabled = inviteCode.isNotEmpty() && replyInput.isNotBlank(),
                onClick = { accept(replyInput) },
            ) { Text("Accept the reply") }

            if (log.isNotEmpty()) {
                Text("Log", style = MaterialTheme.typography.labelLarge)
                Text(log.joinToString("\n"), fontFamily = FontFamily.Monospace, style = MaterialTheme.typography.bodySmall)
            }
        }
    }
}
