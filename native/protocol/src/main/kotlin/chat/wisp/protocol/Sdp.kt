package chat.wisp.protocol

/**
 * Session descriptions, in the same shape the web client uses.
 *
 * The trick the whole pairing design rests on: two peers agree on a *skeleton*
 * — a session description one of them captured from its own browser — and then
 * exchange only the handful of values that actually differ. Everything else,
 * the codecs, the extensions, the SCTP parameters, is already known to both
 * sides and never travels.
 *
 * That means the Kotlin side has to rebuild a description exactly the way the
 * JavaScript side does, byte for byte, or the browser will refuse it. The
 * vectors in src/test/resources/sdp-vectors.json are generated from the web
 * client for precisely that reason.
 */

object CandidateKind {
    private val names = listOf("host", "srflx", "prflx", "relay")
    fun idOf(name: String): Int = names.indexOf(name).takeIf { it >= 0 } ?: 0
    fun nameOf(id: Int): String = names.getOrElse(id) { "host" }
}

data class SdpCandidate(
    val foundation: String,
    val component: Int,
    val transport: String,
    val priority: Long,
    val address: String,
    val port: Int,
    val type: String,
    val addressKind: Int = classifyAddress(address),
)

data class Fingerprint(val algorithm: String, val value: String)

data class SdpFields(
    val sessionId: String? = null,
    val ufrag: String? = null,
    val pwd: String? = null,
    val fingerprint: Fingerprint? = null,
    val setup: String? = null,
    val candidates: List<SdpCandidate> = emptyList(),
)

/**
 * Candidate priority, from RFC 8445 §5.1.2.1.
 *
 * The wire format does not carry priorities: they are recomputed on the far
 * side from the type and component, which saves four bytes a candidate and,
 * more usefully, means a peer cannot claim a priority its candidate type does
 * not deserve.
 */
fun computePriority(type: String, component: Int = 1): Long {
    val typePreference = when (type) {
        "host" -> 126L
        "prflx" -> 110L
        "srflx" -> 100L
        else -> 0L
    }
    val localPreference = 65535L
    return (typePreference shl 24) + (localPreference shl 8) + (256 - component)
}

private val CANDIDATE_LINE = Regex(
    "^a=candidate:(\\S+)\\s+(\\d+)\\s+(\\S+)\\s+(\\d+)\\s+(\\S+)\\s+(\\d+)\\s+typ\\s+(\\S+)",
)

/** Parse one `a=candidate:` line. Returns null for anything that is not one. */
fun parseCandidateLine(line: String): SdpCandidate? {
    val match = CANDIDATE_LINE.find(line.trim()) ?: return null
    val (foundation, component, transport, priority, address, port, type) = match.destructured
    if (type !in listOf("host", "srflx", "prflx", "relay")) return null
    return SdpCandidate(
        foundation = foundation,
        component = component.toInt(),
        transport = transport.lowercase(),
        priority = priority.toLong(),
        address = address,
        port = port.toInt(),
        type = type,
    )
}

fun formatCandidateLine(candidate: SdpCandidate): String {
    val transport = candidate.transport.ifEmpty { "udp" }
    val foundation = candidate.foundation.ifEmpty {
        computePriority(candidate.type, candidate.component).toString()
    }
    return "a=candidate:$foundation ${candidate.component} $transport ${candidate.priority} " +
        "${candidate.address} ${candidate.port} typ ${candidate.type}"
}

/** Pull the per-session values out of a real description produced locally. */
fun extractSdpFields(sdp: String): SdpFields {
    var sessionId: String? = null
    var ufrag: String? = null
    var pwd: String? = null
    var fingerprint: Fingerprint? = null
    var setup: String? = null
    val candidates = mutableListOf<SdpCandidate>()

    for (line in sdp.split("\r\n", "\n")) {
        when {
            line.startsWith("o=") -> {
                val parts = line.substring(2).split(Regex("\\s+"))
                if (parts.size > 1) sessionId = parts[1]
            }
            line.startsWith("a=ice-ufrag:") -> if (ufrag == null) ufrag = line.substring(12).trim()
            line.startsWith("a=ice-pwd:") -> if (pwd == null) pwd = line.substring(10).trim()
            line.startsWith("a=fingerprint:") -> if (fingerprint == null) {
                val rest = line.substring(14).trim()
                val space = rest.indexOf(' ')
                fingerprint = if (space < 0) {
                    Fingerprint("sha-256", rest)
                } else {
                    Fingerprint(rest.substring(0, space), rest.substring(space + 1).trim())
                }
            }
            line.startsWith("a=setup:") -> if (setup == null) setup = line.substring(8).trim()
            line.startsWith("a=candidate:") -> parseCandidateLine(line)?.let { candidates.add(it) }
        }
    }

    return SdpFields(sessionId, ufrag, pwd, fingerprint, setup, candidates)
}

/** Remove candidate lines so a skeleton can be populated again. */
fun stripCandidates(sdp: String): String = sdp
    .split("\r\n", "\n")
    .filter { !it.startsWith("a=candidate:") && it.trim() != "a=end-of-candidates" }
    .joinToString("\r\n")

/**
 * Rebuild a full session description from a skeleton plus the values that came
 * over the wire.
 *
 * The origin line's session id is replaced and its version bumped, which is what
 * tells the far side this is a new description rather than the one it already
 * has. Everything else is copied through untouched.
 */
fun buildSdpFromSkeleton(skeleton: String, fields: SdpFields): String {
    val lines = stripCandidates(skeleton)
        .split("\r\n", "\n")
        .filter { it.isNotEmpty() }

    val out = mutableListOf<String>()
    var originDone = false
    for (line in lines) {
        when {
            line.startsWith("o=") && !originDone -> {
                val parts = line.substring(2).split(Regex("\\s+")).toMutableList()
                if (parts.size > 2) {
                    fields.sessionId?.let { parts[1] = it }
                    parts[2] = "2"
                }
                out.add("o=" + parts.joinToString(" "))
                originDone = true
            }
            line.startsWith("a=ice-ufrag:") -> out.add("a=ice-ufrag:${fields.ufrag}")
            line.startsWith("a=ice-pwd:") -> out.add("a=ice-pwd:${fields.pwd}")
            line.startsWith("a=fingerprint:") ->
                out.add("a=fingerprint:${fields.fingerprint?.algorithm ?: "sha-256"} ${fields.fingerprint?.value ?: ""}")
            line.startsWith("a=setup:") -> out.add("a=setup:${fields.setup ?: "actpass"}")
            else -> out.add(line)
        }
    }

    for (candidate in fields.candidates) out.add(formatCandidateLine(candidate))
    return out.joinToString("\r\n") + "\r\n"
}

/** Drop candidates that differ only in how they were gathered. */
fun dedupeCandidates(candidates: List<SdpCandidate>): List<SdpCandidate> {
    val seen = mutableSetOf<String>()
    val out = mutableListOf<SdpCandidate>()
    for (candidate in candidates) {
        val key = "${candidate.type}|${candidate.component}|${candidate.address}|${candidate.port}"
        if (!seen.add(key)) continue
        out.add(candidate)
    }
    return out
}

private val IPV4 = Regex("^\\d{1,3}(\\.\\d{1,3}){3}$")

/**
 * Whether an address is only reachable on the local link.
 *
 * Used to tell a person what their invite actually offers: a code whose
 * candidates are all private will only work on the same network, and saying so
 * is better than letting them wonder why nothing connects.
 */
fun isPrivateAddress(address: String): Boolean {
    if (IPV4.matches(address)) {
        val parts = address.split(".").map { it.toInt() }
        val (a, b) = parts
        return a == 10 || a == 127 || (a == 192 && b == 168) ||
            (a == 172 && b in 16..31) || (a == 169 && b == 254)
    }
    if (address.contains(':')) {
        return address.startsWith("fe80") || address == "::1" ||
            address.startsWith("fc") || address.startsWith("fd")
    }
    // An mDNS hostname, which resolves only on the local link.
    return true
}
