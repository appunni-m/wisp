package chat.wisp.protocol

/**
 * The byte primitives the invite format is built from.
 *
 * Big-endian, and deliberately the same shapes as the JavaScript implementation
 * down to the error cases: an invite written by one client has to be readable by
 * the other, and a disagreement about how a length is encoded is not the kind of
 * bug that shows up in a unit test you forgot to write.
 */

class CodecException(message: String) : Exception(message)

class ByteWriter(initialCapacity: Int = 256) {
    private val out = java.io.ByteArrayOutputStream(initialCapacity)

    fun u8(value: Int): ByteWriter {
        require(value in 0..0xff) { "u8 out of range: $value" }
        out.write(value)
        return this
    }

    fun u16(value: Int): ByteWriter {
        require(value in 0..0xffff) { "u16 out of range: $value" }
        out.write(value ushr 8)
        out.write(value and 0xff)
        return this
    }

    fun u32(value: Long): ByteWriter {
        require(value in 0..0xffffffffL) { "u32 out of range: $value" }
        for (shift in intArrayOf(24, 16, 8, 0)) out.write(((value shr shift) and 0xff).toInt())
        return this
    }

    /** Unsigned 64-bit. Kotlin has no unsigned long in the wire format's terms. */
    fun u64(value: Long): ByteWriter {
        for (shift in intArrayOf(56, 48, 40, 32, 24, 16, 8, 0)) {
            out.write(((value ushr shift) and 0xff).toInt())
        }
        return this
    }

    fun bytes(value: ByteArray): ByteWriter {
        out.write(value, 0, value.size)
        return this
    }

    /** Length-prefixed (u8) UTF-8 string; max 255 bytes. */
    fun str(value: String?): ByteWriter {
        val encoded = (value ?: "").toByteArray(Charsets.UTF_8)
        if (encoded.size > 255) throw CodecException("string too long for u8 prefix")
        u8(encoded.size)
        return bytes(encoded)
    }

    /** Length-prefixed (u16) UTF-8 string; max 65535 bytes. */
    fun str16(value: String?): ByteWriter {
        val encoded = (value ?: "").toByteArray(Charsets.UTF_8)
        if (encoded.size > 0xffff) throw CodecException("string too long for u16 prefix")
        u16(encoded.size)
        return bytes(encoded)
    }

    fun build(): ByteArray = out.toByteArray()
}

class ByteReader(private val bytes: ByteArray) {
    var offset = 0
        private set

    private fun need(count: Int) {
        if (offset + count > bytes.size) {
            throw CodecException("truncated payload: need $count byte(s) at offset $offset")
        }
    }

    fun u8(): Int {
        need(1)
        return bytes[offset++].toInt() and 0xff
    }

    fun u16(): Int {
        need(2)
        val value = ((bytes[offset].toInt() and 0xff) shl 8) or (bytes[offset + 1].toInt() and 0xff)
        offset += 2
        return value
    }

    fun u32(): Long {
        need(4)
        var value = 0L
        for (i in 0 until 4) value = (value shl 8) or (bytes[offset + i].toLong() and 0xff)
        offset += 4
        return value
    }

    fun u64(): Long {
        need(8)
        var value = 0L
        for (i in 0 until 8) value = (value shl 8) or (bytes[offset + i].toLong() and 0xff)
        offset += 8
        return value
    }

    fun bytes(count: Int): ByteArray {
        need(count)
        val slice = bytes.copyOfRange(offset, offset + count)
        offset += count
        return slice
    }

    fun str(): String = String(bytes(u8()), Charsets.UTF_8)

    fun str16(): String = String(bytes(u16()), Charsets.UTF_8)

    val remaining: Int get() = bytes.size - offset

    val eof: Boolean get() = remaining == 0
}

private const val B64_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_"

private val B64_LOOKUP = IntArray(128) { -1 }.also { table ->
    B64_ALPHABET.forEachIndexed { index, char -> table[char.code] = index }
}

/**
 * base64url without padding, as the invite codes use.
 *
 * Lenient on the way in, because a code that has travelled through a chat app
 * may have picked up whitespace or a stray character, and a person pasting it
 * should not have to care.
 */
object Base64Url {
    fun encode(bytes: ByteArray): String {
        val out = StringBuilder((bytes.size * 4 + 2) / 3)
        var i = 0
        while (i + 2 < bytes.size) {
            val chunk = ((bytes[i].toInt() and 0xff) shl 16) or
                ((bytes[i + 1].toInt() and 0xff) shl 8) or
                (bytes[i + 2].toInt() and 0xff)
            out.append(B64_ALPHABET[(chunk ushr 18) and 63])
            out.append(B64_ALPHABET[(chunk ushr 12) and 63])
            out.append(B64_ALPHABET[(chunk ushr 6) and 63])
            out.append(B64_ALPHABET[chunk and 63])
            i += 3
        }
        when (bytes.size - i) {
            1 -> {
                val chunk = (bytes[i].toInt() and 0xff) shl 16
                out.append(B64_ALPHABET[(chunk ushr 18) and 63])
                out.append(B64_ALPHABET[(chunk ushr 12) and 63])
            }
            2 -> {
                val chunk = ((bytes[i].toInt() and 0xff) shl 16) or ((bytes[i + 1].toInt() and 0xff) shl 8)
                out.append(B64_ALPHABET[(chunk ushr 18) and 63])
                out.append(B64_ALPHABET[(chunk ushr 12) and 63])
                out.append(B64_ALPHABET[(chunk ushr 6) and 63])
            }
        }
        return out.toString()
    }

    fun decode(text: String): ByteArray {
        val cleaned = text.filter { it.code < 128 && B64_LOOKUP[it.code] >= 0 }
        val out = java.io.ByteArrayOutputStream((cleaned.length * 3) / 4)
        var buffer = 0
        var bits = 0
        for (char in cleaned) {
            buffer = (buffer shl 6) or B64_LOOKUP[char.code]
            bits += 6
            if (bits >= 8) {
                bits -= 8
                out.write((buffer ushr bits) and 0xff)
            }
        }
        return out.toByteArray()
    }
}

object Hex {
    fun encode(bytes: ByteArray): String =
        bytes.joinToString("") { (it.toInt() and 0xff).toString(16).padStart(2, '0') }

    fun decode(text: String): ByteArray {
        val trimmed = text.trim()
        require(trimmed.length % 2 == 0) { "hex string must have an even length" }
        return ByteArray(trimmed.length / 2) { index ->
            trimmed.substring(index * 2, index * 2 + 2).toInt(16).toByte()
        }
    }
}
