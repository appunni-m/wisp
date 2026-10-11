package chat.wisp.protocol

import java.io.ByteArrayOutputStream
import java.util.zip.Deflater
import java.util.zip.Inflater

/**
 * The invite payload, in Kotlin.
 *
 * Field for field the same as the JavaScript implementation, because an Android
 * phone and a browser have to be able to pair with each other. Nothing here is
 * described in prose in two places: the layout is frozen in
 * src/test/resources/vectors.json, generated from the web client, and the tests
 * below decode those bytes and produce them again.
 */

const val PAYLOAD_VERSION = 1
const val CODE_PREFIX = "P2P1"

object InviteKind {
    const val OFFER = 1
    const val ANSWER = 2
}

object IdMode {
    const val PSEUDONYM = 0
    const val CONTACT = 1
    const val BURNER = 2
}

object Setup {
    const val ACTPASS = 0
    const val ACTIVE = 1
    const val PASSIVE = 2

    private val names = listOf("actpass", "active", "passive")

    fun idOf(name: String?): Int = names.indexOf(name ?: "actpass").takeIf { it >= 0 } ?: ACTPASS
    fun nameOf(id: Int): String = names.getOrElse(id) { "actpass" }
}

object AddressKind {
    const val IPV4 = 0
    const val IPV6 = 1
    const val HOSTNAME = 2
}

object CandidateType {
    private val names = listOf("host", "srflx", "prflx", "relay")

    fun idOf(name: String): Int = names.indexOf(name).takeIf { it >= 0 } ?: 0
    fun nameOf(id: Int): String = names.getOrElse(id) { "host" }
}

data class Candidate(
    val type: String,
    val component: Int,
    val address: String,
    val port: Int,
    val transport: String = "udp",
)

data class Contact(
    val name: String? = null,
    val phone: String? = null,
    val email: String? = null,
    val note: String? = null,
    val organisation: String? = null,
    val url: String? = null,
)

data class Invite(
    val kind: Int,
    val idMode: Int = IdMode.PSEUDONYM,
    val createdAtSec: Long = System.currentTimeMillis() / 1000,
    val roomId: Long = 0,
    val sessionId: Long = 0,
    val ufrag: String,
    val pwd: String,
    val fingerprint: String,
    val setup: String = "actpass",
    val candidates: List<Candidate> = emptyList(),
    val nick: String = "",
    val contact: Contact? = null,
    val keyAlgorithm: Int = KeyAlgorithm.DEFAULT,
    val publicKey: ByteArray,
    val groupLabel: String = "",
) {
    override fun equals(other: Any?): Boolean = other is Invite && other.sessionId == sessionId && other.kind == kind
    override fun hashCode(): Int = sessionId.hashCode()
}

class InviteException(message: String) : Exception(message)

private const val FLAG_HAS_CONTACT = 0b0001
private const val FP_ALGO_SHA256 = 1

fun fingerprintToBytes(fingerprint: String): ByteArray {
    val bytes = Hex.decode(fingerprint.replace(":", ""))
    if (bytes.size != 32) throw InviteException("only sha-256 DTLS fingerprints are supported")
    return bytes
}

fun bytesToFingerprint(bytes: ByteArray): String {
    val hex = Hex.encode(bytes).uppercase()
    return hex.chunked(2).joinToString(":")
}

private fun ipv4ToBytes(address: String): ByteArray {
    val parts = address.split(".")
    if (parts.size != 4) throw InviteException("not an IPv4 address: $address")
    return ByteArray(4) { index ->
        val value = parts[index].toIntOrNull() ?: throw InviteException("not an IPv4 address: $address")
        value.toByte()
    }
}

private fun bytesToIpv4(bytes: ByteArray): String = bytes.joinToString(".") { (it.toInt() and 0xff).toString() }

/** Which of the three address forms a candidate holds. */
internal fun classifyAddress(address: String): Int = when {
    Regex("^\\d{1,3}(\\.\\d{1,3}){3}$").matches(address) -> AddressKind.IPV4
    address.contains(':') -> AddressKind.IPV6
    else -> AddressKind.HOSTNAME
}

private fun ipv6ToBytes(address: String): ByteArray {
    val out = ByteArray(16)
    val halves = address.split("::", limit = 2)
    val head = halves[0].split(":").filter { it.isNotEmpty() }
    val tail = if (halves.size > 1) halves[1].split(":").filter { it.isNotEmpty() } else emptyList()
    head.forEachIndexed { index, group ->
        val value = group.toIntOrNull(16) ?: throw InviteException("not an IPv6 address: $address")
        out[index * 2] = (value shr 8).toByte()
        out[index * 2 + 1] = value.toByte()
    }
    tail.reversed().forEachIndexed { index, group ->
        val value = group.toIntOrNull(16) ?: throw InviteException("not an IPv6 address: $address")
        val at = 14 - index * 2
        out[at] = (value shr 8).toByte()
        out[at + 1] = value.toByte()
    }
    return out
}

private fun bytesToIpv6(bytes: ByteArray): String {
    val groups = (0 until 8).map { index ->
        (((bytes[index * 2].toInt() and 0xff) shl 8) or (bytes[index * 2 + 1].toInt() and 0xff))
    }
    // Compress the longest run of zeroes, the way an address is normally written.
    var bestStart = -1
    var bestLength = 0
    var start = -1
    groups.forEachIndexed { index, value ->
        if (value == 0) {
            if (start == -1) start = index
            val length = index - start + 1
            if (length > bestLength) {
                bestLength = length
                bestStart = start
            }
        } else {
            start = -1
        }
    }
    if (bestLength < 2) return groups.joinToString(":") { it.toString(16) }
    val head = groups.take(bestStart).joinToString(":") { it.toString(16) }
    val tail = groups.drop(bestStart + bestLength).joinToString(":") { it.toString(16) }
    return "$head::$tail"
}

private fun writeCandidate(writer: ByteWriter, candidate: Candidate) {
    writer.u8(CandidateType.idOf(candidate.type))
    writer.u8(candidate.component)
    val kind = classifyAddress(candidate.address)
    writer.u8(kind)
    when (kind) {
        AddressKind.IPV4 -> writer.bytes(ipv4ToBytes(candidate.address))
        AddressKind.IPV6 -> writer.bytes(ipv6ToBytes(candidate.address))
        else -> writer.str(candidate.address)
    }
    writer.u16(candidate.port)
}

private fun readCandidate(reader: ByteReader): Candidate {
    val type = reader.u8()
    val component = reader.u8()
    val kind = reader.u8()
    val address = when (kind) {
        AddressKind.IPV4 -> bytesToIpv4(reader.bytes(4))
        AddressKind.IPV6 -> bytesToIpv6(reader.bytes(16))
        AddressKind.HOSTNAME -> reader.str()
        else -> throw InviteException("unknown candidate address kind: $kind")
    }
    val port = reader.u16()
    return Candidate(CandidateType.nameOf(type), component, address, port)
}

/** Contact details as the compact JSON the web client writes, with its key names. */
private fun contactToJson(contact: Contact): String {
    val fields = mutableListOf<String>()
    contact.name?.let { fields.add("\"name\":${jsonString(it)}") }
    contact.phone?.let { fields.add("\"phone\":${jsonString(it)}") }
    contact.email?.let { fields.add("\"email\":${jsonString(it)}") }
    contact.note?.let { fields.add("\"note\":${jsonString(it)}") }
    contact.organisation?.let { fields.add("\"org\":${jsonString(it)}") }
    contact.url?.let { fields.add("\"url\":${jsonString(it)}") }
    return "{${fields.joinToString(",")}}"
}

private fun jsonString(value: String): String {
    val out = StringBuilder("\"")
    for (char in value) {
        when (char) {
            '"' -> out.append("\\\"")
            '\\' -> out.append("\\\\")
            '\n' -> out.append("\\n")
            '\r' -> out.append("\\r")
            '\t' -> out.append("\\t")
            else -> if (char < ' ') out.append("\\u%04x".format(char.code)) else out.append(char)
        }
    }
    return out.append("\"").toString()
}

/**
 * Parse the contact object the web client writes.
 *
 * Deliberately not a general JSON parser: the shape is fixed and small, and a
 * hand-rolled reader here is less code than a dependency, and cannot be talked
 * into allocating by a hostile payload.
 */
internal fun parseContactJson(text: String): Contact {
    val values = mutableMapOf<String, String>()
    var index = 0
    while (index < text.length) {
        val keyStart = text.indexOf('"', index)
        if (keyStart < 0) break
        val keyEnd = text.indexOf('"', keyStart + 1)
        if (keyEnd < 0) break
        val key = text.substring(keyStart + 1, keyEnd)
        val colon = text.indexOf(':', keyEnd)
        if (colon < 0) break
        val valueStart = text.indexOf('"', colon)
        if (valueStart < 0) break
        val out = StringBuilder()
        var i = valueStart + 1
        while (i < text.length) {
            val char = text[i]
            if (char == '\\' && i + 1 < text.length) {
                when (val next = text[i + 1]) {
                    'n' -> out.append('\n')
                    'r' -> out.append('\r')
                    't' -> out.append('\t')
                    'u' -> {
                        out.append(text.substring(i + 2, i + 6).toInt(16).toChar())
                        i += 4
                    }
                    else -> out.append(next)
                }
                i += 2
                continue
            }
            if (char == '"') break
            out.append(char)
            i++
        }
        values[key] = out.toString()
        index = i + 1
    }
    return Contact(
        name = values["name"],
        phone = values["phone"],
        email = values["email"],
        note = values["note"],
        organisation = values["org"],
        url = values["url"],
    )
}

/** Serialize the signed region: everything except the signature. */
fun encodeInviteBody(invite: Invite): ByteArray {
    val candidates = invite.candidates.filter { it.transport == "udp" }
    val hasContact = invite.idMode == IdMode.CONTACT && invite.contact != null

    val writer = ByteWriter()
    writer.u8(PAYLOAD_VERSION)
    writer.u8(invite.kind)
    writer.u8(invite.idMode)
    writer.u8(if (hasContact) FLAG_HAS_CONTACT else 0)
    writer.u32(invite.createdAtSec)
    writer.u64(invite.roomId)
    writer.u64(invite.sessionId)
    writer.str(invite.ufrag)
    writer.str(invite.pwd)
    writer.u8(FP_ALGO_SHA256)
    writer.bytes(fingerprintToBytes(invite.fingerprint))
    writer.u8(Setup.idOf(invite.setup))
    writer.u8(candidates.size)
    for (candidate in candidates) writeCandidate(writer, candidate)
    writer.str(invite.nick)
    if (hasContact) writer.str16(contactToJson(invite.contact!!))
    writer.u8(invite.keyAlgorithm)
    writer.bytes(invite.publicKey)
    writer.str(invite.groupLabel)
    return writer.build()
}

class DecodedInvite(val invite: Invite, val bodyLength: Int)

fun decodeInviteBody(bytes: ByteArray): DecodedInvite {
    val reader = ByteReader(bytes)
    val version = reader.u8()
    if (version != PAYLOAD_VERSION) throw InviteException("unsupported payload version $version; update the app")
    val kind = reader.u8()
    val idMode = reader.u8()
    val flags = reader.u8()
    val createdAtSec = reader.u32()
    val roomId = reader.u64()
    val sessionId = reader.u64()
    val ufrag = reader.str()
    val pwd = reader.str()
    val fingerprintAlgorithm = reader.u8()
    if (fingerprintAlgorithm != FP_ALGO_SHA256) throw InviteException("unsupported fingerprint algorithm")
    val fingerprint = bytesToFingerprint(reader.bytes(32))
    val setup = Setup.nameOf(reader.u8())
    val candidateCount = reader.u8()
    val candidates = (0 until candidateCount).map { readCandidate(reader) }
    val nick = reader.str()
    val contact = if (flags and FLAG_HAS_CONTACT != 0) parseContactJson(reader.str16()) else null
    val keyAlgorithm = reader.u8()
    val expectedKeyBytes = if (keyAlgorithm == KeyAlgorithm.ED25519) 32 else 65
    val publicKey = reader.bytes(expectedKeyBytes)
    val groupLabel = reader.str()

    return DecodedInvite(
        Invite(
            kind = kind,
            idMode = idMode,
            createdAtSec = createdAtSec,
            roomId = roomId,
            sessionId = sessionId,
            ufrag = ufrag,
            pwd = pwd,
            fingerprint = fingerprint,
            setup = setup,
            candidates = candidates,
            nick = nick,
            contact = contact,
            keyAlgorithm = keyAlgorithm,
            publicKey = publicKey,
            groupLabel = groupLabel,
        ),
        reader.offset,
    )
}

class OpenedInvite(val invite: Invite, val verified: Boolean, val code: String, val byteLength: Int)

/** Sign the body and render the code, compressing it only if that helps. */
fun sealInvite(invite: Invite, identity: Identity): String {
    val body = encodeInviteBody(invite)
    val signature = identity.sign(body)
    if (signature.size != KeyAlgorithm.SIGNATURE_BYTES) {
        throw InviteException("unexpected signature length ${signature.size}")
    }
    val packed = body + signature
    val compressed = deflateRaw(packed)
    return if (compressed.size < packed.size) {
        "$CODE_PREFIX" + "z-" + Base64Url.encode(compressed)
    } else {
        "$CODE_PREFIX" + "r-" + Base64Url.encode(packed)
    }
}

fun openInvite(code: String): OpenedInvite {
    val cleaned = extractCode(code) ?: throw InviteException("no invite code found in the pasted text")
    val match = Regex("^P2P1([zr])-([A-Za-z0-9_-]+)$").find(cleaned)
        ?: throw InviteException("malformed invite code")
    val mode = match.groupValues[1]
    val raw = Base64Url.decode(match.groupValues[2])
    val packed = if (mode == "z") inflateRaw(raw) else raw
    val decoded = decodeInviteBody(packed)
    if (packed.size != decoded.bodyLength + KeyAlgorithm.SIGNATURE_BYTES) {
        throw InviteException("invite payload has trailing or missing bytes")
    }
    val body = packed.copyOfRange(0, decoded.bodyLength)
    val signature = packed.copyOfRange(decoded.bodyLength, decoded.bodyLength + KeyAlgorithm.SIGNATURE_BYTES)
    val verified = verifySignature(decoded.invite.publicKey, decoded.invite.keyAlgorithm, body, signature)
    return OpenedInvite(decoded.invite, verified, cleaned, packed.size)
}

/** Pull a code out of a link, a fragment, or a paste that has other text around it. */
fun extractCode(text: String?): String? {
    if (text == null) return null
    val match = Regex("P2P1[zr]-[A-Za-z0-9_-]+").find(text)
    return match?.value
}

fun buildInviteLink(baseUrl: String, code: String): String = "${baseUrl.substringBefore('#')}#i=$code"

/** Raw deflate, matching the `deflate-raw` the browser provides. */
fun deflateRaw(bytes: ByteArray): ByteArray {
    val deflater = Deflater(Deflater.BEST_COMPRESSION, true)
    deflater.setInput(bytes)
    deflater.finish()
    val out = ByteArrayOutputStream(bytes.size)
    val buffer = ByteArray(8192)
    while (!deflater.finished()) {
        val written = deflater.deflate(buffer)
        out.write(buffer, 0, written)
    }
    deflater.end()
    return out.toByteArray()
}

fun inflateRaw(bytes: ByteArray): ByteArray {
    val inflater = Inflater(true)
    inflater.setInput(bytes)
    val out = ByteArrayOutputStream(bytes.size * 4)
    val buffer = ByteArray(8192)
    try {
        while (!inflater.finished()) {
            val written = inflater.inflate(buffer)
            if (written == 0 && inflater.needsInput()) break
            out.write(buffer, 0, written)
        }
    } finally {
        inflater.end()
    }
    return out.toByteArray()
}
