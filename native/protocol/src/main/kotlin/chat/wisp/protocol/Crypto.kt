package chat.wisp.protocol

import java.security.KeyFactory
import java.security.KeyPair
import java.security.KeyPairGenerator
import java.security.Signature
import java.security.spec.ECGenParameterSpec
import java.security.spec.X509EncodedKeySpec

/**
 * Identity, in the same shape the web client uses.
 *
 * A P-256 key pair. The public key travels as the uncompressed point — 65 bytes,
 * `04 || X || Y` — because that is what WebCrypto exports as "raw", and the
 * invite signature is checked against exactly those bytes. Android's own
 * encoding for a public key is X.509, so it is converted rather than assumed.
 */
object KeyAlgorithm {
    const val ED25519 = 1
    const val P256 = 2
    const val DEFAULT = P256
    const val SIGNATURE_BYTES = 64
}

class Identity(val keyPair: KeyPair, val keyAlgorithm: Int = KeyAlgorithm.DEFAULT) {

    /** Uncompressed EC point, the form the wire format carries. */
    val publicKey: ByteArray by lazy { rawPublicKey(keyPair) }

    fun sign(bytes: ByteArray): ByteArray {
        val signature = Signature.getInstance("SHA256withECDSA")
        signature.initSign(keyPair.private)
        signature.update(bytes)
        val der = signature.sign()
        // WebCrypto emits the fixed-width r||s form, and the invite reserves
        // exactly 64 bytes for it; Java emits DER, so it has to be repacked.
        return derToRaw(der)
    }

    companion object {
        fun generate(): Identity {
            val generator = KeyPairGenerator.getInstance("EC")
            generator.initialize(ECGenParameterSpec("secp256r1"))
            return Identity(generator.generateKeyPair())
        }

    }
}

/**
 * Check a signature made by either client.
 *
 * `rawSignature` is 64 bytes, r||s, as WebCrypto produces; Java wants DER. The
 * conversion is the whole reason this function exists.
 */
fun verifySignature(publicKeyRaw: ByteArray, keyAlgorithm: Int, bytes: ByteArray, rawSignature: ByteArray): Boolean {
    if (keyAlgorithm != KeyAlgorithm.P256) return false
    if (rawSignature.size != KeyAlgorithm.SIGNATURE_BYTES) return false
    return try {
        val signature = Signature.getInstance("SHA256withECDSA")
        signature.initVerify(publicKeyFromRaw(publicKeyRaw))
        signature.update(bytes)
        signature.verify(rawToDer(rawSignature))
    } catch (error: Exception) {
        false
    }
}

fun rawPublicKey(pair: KeyPair): ByteArray {
    val encoded = pair.public.encoded
    // X.509 SubjectPublicKeyInfo ends with the uncompressed point; for P-256 that
    // is exactly the last 65 bytes, and checking the marker beats trusting an
    // offset that differs between providers.
    if (encoded.size >= 65 && encoded[encoded.size - 65] == 0x04.toByte()) {
        return encoded.copyOfRange(encoded.size - 65, encoded.size)
    }
    throw CodecException("cannot extract a raw P-256 public key from ${encoded.size} bytes")
}

fun publicKeyFromRaw(raw: ByteArray): java.security.PublicKey {
    // Rebuild the SubjectPublicKeyInfo wrapper around the raw point. The prefix
    // is fixed for prime256v1, so it is written out rather than computed.
    val prefix = byteArrayOf(
        0x30, 0x59, 0x30, 0x13, 0x06, 0x07, 0x2a, 0x86.toByte(), 0x48, 0xce.toByte(), 0x3d, 0x02, 0x01,
        0x06, 0x08, 0x2a, 0x86.toByte(), 0x48, 0xce.toByte(), 0x3d, 0x03, 0x01, 0x07, 0x03, 0x42, 0x00,
    )
    val factory = KeyFactory.getInstance("EC")
    return factory.generatePublic(X509EncodedKeySpec(prefix + raw))
}

private const val DER_INTEGER = 0x02
private const val DER_SEQUENCE = 0x30

/** r||s (64 bytes) to the DER sequence Java insists on. */
fun rawToDer(raw: ByteArray): ByteArray {
    require(raw.size == 64) { "expected a 64-byte raw signature, got ${raw.size}" }
    fun integer(offset: Int): ByteArray {
        var start = offset
        var length = 32
        while (length > 1 && raw[start] == 0.toByte()) {
            start++
            length--
        }
        // A leading bit of 1 would read as negative, so DER pads it.
        val pad = if (raw[start] < 0) 1 else 0
        val out = ByteArray(1 + 1 + pad + length)
        out[0] = DER_INTEGER.toByte()
        out[1] = (pad + length).toByte()
        if (pad == 1) out[2] = 0
        raw.copyInto(out, 2 + pad, start, start + length)
        return out
    }

    val r = integer(0)
    val s = integer(32)
    val body = r + s
    return byteArrayOf(DER_SEQUENCE.toByte(), body.size.toByte()) + body
}

/** The DER sequence Java produces back to the fixed 64 bytes the format uses. */
fun derToRaw(der: ByteArray): ByteArray {
    if (der.size < 8 || der[0] != DER_SEQUENCE.toByte()) throw CodecException("not a DER signature")
    var offset = 2
    if (der[1].toInt() and 0x80 != 0) {
        // Long form length: the low bits say how many bytes it occupies.
        offset = 2 + (der[1].toInt() and 0x7f) + 1
    }
    fun readInteger(): ByteArray {
        if (der[offset] != DER_INTEGER.toByte()) throw CodecException("expected a DER integer")
        val length = der[offset + 1].toInt()
        var start = offset + 2
        var count = length
        while (count > 32) {
            start++
            count--
        }
        val out = ByteArray(32)
        der.copyInto(out, 32 - count, start, start + count)
        offset = offset + 2 + length
        return out
    }

    val r = readInteger()
    val s = readInteger()
    return r + s
}
