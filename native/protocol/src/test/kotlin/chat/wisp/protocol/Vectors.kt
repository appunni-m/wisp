package chat.wisp.protocol

import java.io.File

/**
 * The vectors, as written by tools/make-vectors.mjs from the JavaScript client.
 *
 * Read with a small hand-written reader rather than a JSON dependency, for the
 * same reason the contact block is parsed by hand: the shape is fixed, and it
 * keeps the protocol module free of dependencies.
 */
class Vectors(
    val publicKeyHex: String,
    val pkcs8Hex: String,
    val vectors: List<Vector>,
) {
    class Vector(
        val name: String,
        val bodyHex: String,
        val bodyLength: Int,
        val code: String,
        val expected: Expected,
    ) {
        fun invite(): Invite = openInvite(code).invite
    }

    class Expected(
        val kind: Int,
        val idMode: Int,
        val createdAtSec: Long,
        val roomId: String,
        val sessionId: String,
        val ufrag: String,
        val pwd: String,
        val fingerprint: String,
        val setup: String,
        val nick: String,
        val groupLabel: String,
        val keyAlgo: Int,
        val publicKeyHex: String,
        val contact: Contact?,
        val candidates: List<Candidate>,
    )

    companion object {
        fun load(): Vectors {
            val file = locate()
            val text = file.readText()
            return parse(text)
        }

        private fun locate(): File {
            // Tests run from the module directory, but be forgiving about it.
            val candidates = listOf(
                File("src/test/resources/vectors.json"),
                File("protocol/src/test/resources/vectors.json"),
                File("../protocol/src/test/resources/vectors.json"),
            )
            return candidates.firstOrNull { it.exists() }
                ?: error(
                    "vectors.json not found. Generate it with: node tools/make-vectors.mjs (looked in ${candidates.joinToString { it.path }})",
                )
        }

        /** Just enough JSON for this one file. */
        fun parse(text: String): Vectors {
            val root = MiniJson.parse(text) as Map<*, *>
            val vectors = (root["vectors"] as List<*>).map { entry ->
                val map = entry as Map<*, *>
                val expected = map["expected"] as Map<*, *>
                val contact = (expected["contact"] as? Map<*, *>)?.let {
                    Contact(
                        name = it["name"] as? String,
                        phone = it["phone"] as? String,
                        email = it["email"] as? String,
                        note = it["note"] as? String,
                        organisation = it["org"] as? String,
                        url = it["url"] as? String,
                    )
                }
                val candidates = (expected["candidates"] as List<*>).map { raw ->
                    val candidate = raw as Map<*, *>
                    Candidate(
                        type = candidate["type"] as String,
                        component = (candidate["component"] as Number).toInt(),
                        address = candidate["address"] as String,
                        port = (candidate["port"] as Number).toInt(),
                        transport = candidate["transport"] as? String ?: "udp",
                    )
                }
                Vector(
                    name = map["name"] as String,
                    bodyHex = map["bodyHex"] as String,
                    bodyLength = (map["bodyLength"] as Number).toInt(),
                    code = map["code"] as String,
                    expected = Expected(
                        kind = (expected["kind"] as Number).toInt(),
                        idMode = (expected["idMode"] as Number).toInt(),
                        createdAtSec = (expected["createdAtSec"] as Number).toLong(),
                        roomId = expected["roomId"] as String,
                        sessionId = expected["sessionId"] as String,
                        ufrag = expected["ufrag"] as String,
                        pwd = expected["pwd"] as String,
                        fingerprint = expected["fingerprint"] as String,
                        setup = expected["setup"] as String,
                        nick = expected["nick"] as String,
                        groupLabel = expected["groupLabel"] as String,
                        keyAlgo = (expected["keyAlgo"] as Number).toInt(),
                        publicKeyHex = expected["publicKeyHex"] as String,
                        contact = contact,
                        candidates = candidates,
                    ),
                )
            }
            return Vectors(
                publicKeyHex = root["publicKeyHex"] as String,
                pkcs8Hex = root["pkcs8Hex"] as String,
                vectors = vectors,
            )
        }
    }
}

/** Minimal JSON reader: objects, arrays, strings, numbers, booleans, null. */
object MiniJson {
    fun parse(text: String): Any? {
        val parser = Parser(text)
        val value = parser.readValue()
        parser.skipWhitespace()
        return value
    }

    private class Parser(private val text: String) {
        private var index = 0

        fun skipWhitespace() {
            while (index < text.length && text[index].isWhitespace()) index++
        }

        fun readValue(): Any? {
            skipWhitespace()
            if (index >= text.length) error("unexpected end of JSON")
            return when (text[index]) {
                '{' -> readObject()
                '[' -> readArray()
                '"' -> readString()
                't' -> readLiteral("true", true)
                'f' -> readLiteral("false", false)
                'n' -> readLiteral("null", null)
                else -> readNumber()
            }
        }

        private fun readLiteral(literal: String, value: Any?): Any? {
            if (!text.startsWith(literal, index)) error("expected $literal at $index")
            index += literal.length
            return value
        }

        private fun readObject(): Map<String, Any?> {
            val out = LinkedHashMap<String, Any?>()
            index++ // {
            skipWhitespace()
            if (index < text.length && text[index] == '}') {
                index++
                return out
            }
            while (true) {
                skipWhitespace()
                val key = readString()
                skipWhitespace()
                if (text[index] != ':') error("expected : at $index")
                index++
                out[key] = readValue()
                skipWhitespace()
                when (text[index]) {
                    ',' -> index++
                    '}' -> {
                        index++
                        return out
                    }
                    else -> error("expected , or } at $index")
                }
            }
        }

        private fun readArray(): List<Any?> {
            val out = mutableListOf<Any?>()
            index++ // [
            skipWhitespace()
            if (index < text.length && text[index] == ']') {
                index++
                return out
            }
            while (true) {
                out.add(readValue())
                skipWhitespace()
                when (text[index]) {
                    ',' -> index++
                    ']' -> {
                        index++
                        return out
                    }
                    else -> error("expected , or ] at $index")
                }
            }
        }

        private fun readString(): String {
            if (text[index] != '"') error("expected a string at $index")
            index++
            val out = StringBuilder()
            while (index < text.length) {
                val char = text[index]
                if (char == '"') {
                    index++
                    return out.toString()
                }
                if (char == '\\') {
                    when (val next = text[index + 1]) {
                        'n' -> out.append('\n')
                        'r' -> out.append('\r')
                        't' -> out.append('\t')
                        'b' -> out.append('\b')
                        'f' -> out.append('\u000c')
                        'u' -> {
                            out.append(text.substring(index + 2, index + 6).toInt(16).toChar())
                            index += 4
                        }
                        else -> out.append(next)
                    }
                    index += 2
                    continue
                }
                out.append(char)
                index++
            }
            error("unterminated string")
        }

        private fun readNumber(): Any {
            val start = index
            while (index < text.length && (text[index].isDigit() || text[index] in "-+.eE")) index++
            val raw = text.substring(start, index)
            return raw.toLongOrNull() ?: raw.toDouble()
        }
    }
}

/**
 * Codes this suite produced, written out so the web client can verify them.
 *
 * The interop test in the other direction is only meaningful against codes the
 * browser did not make, and a test process cannot reach into JavaScript. So it
 * leaves them here, and tools/verify-native-codes.mjs picks them up.
 */
object NativeCodes {
    private val written = mutableListOf<String>()

    fun record(code: String) {
        written.add(code)
        val target = File("build/native-codes.txt")
        target.parentFile?.mkdirs()
        target.writeText(written.joinToString("\n") + "\n")
    }
}
