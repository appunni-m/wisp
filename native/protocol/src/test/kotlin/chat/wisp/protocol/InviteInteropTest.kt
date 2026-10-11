package chat.wisp.protocol

import kotlin.test.Test
import kotlin.test.assertContentEquals
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNotNull
import kotlin.test.assertTrue

/**
 * The Kotlin implementation, held to the JavaScript one.
 *
 * The vectors in src/test/resources/vectors.json are produced by the web client
 * itself (tools/make-vectors.mjs), so these tests are not checking the Kotlin
 * code against a description of the format — they are checking it against the
 * bytes another implementation actually produced, and against codes it actually
 * signed. Regenerate them with:
 *
 *   node tools/make-vectors.mjs
 */
class InviteInteropTest {

    private val vectors: Vectors by lazy { Vectors.load() }

    @Test
    fun `every vector's body is encoded byte for byte`() {
        for (vector in vectors.vectors) {
            val body = encodeInviteBody(vector.invite())
            assertContentEquals(
                Hex.decode(vector.bodyHex),
                body,
                "${vector.name}: the Kotlin encoder wrote different bytes",
            )
            assertEquals(vector.bodyLength, body.size, "${vector.name}: wrong body length")
        }
    }

    @Test
    fun `a code signed by the web client opens, verifies, and decodes to the same fields`() {
        for (vector in vectors.vectors) {
            val opened = openInvite(vector.code)
            assertTrue(opened.verified, "${vector.name}: the web client's signature did not verify")

            val invite = opened.invite
            val expected = vector.expected
            assertEquals(expected.kind, invite.kind, "${vector.name}: kind")
            assertEquals(expected.idMode, invite.idMode, "${vector.name}: id mode")
            assertEquals(expected.createdAtSec, invite.createdAtSec, "${vector.name}: timestamp")
            // The wire format is unsigned 64-bit, and a session id can set the
            // top bit, so these are parsed as unsigned: a plain toLong() throws
            // on anything above Long.MAX_VALUE, which is half the range.
            assertEquals(
                java.lang.Long.parseUnsignedLong(expected.roomId),
                invite.roomId,
                "${vector.name}: room id",
            )
            assertEquals(
                java.lang.Long.parseUnsignedLong(expected.sessionId),
                invite.sessionId,
                "${vector.name}: session id",
            )
            assertEquals(expected.ufrag, invite.ufrag, "${vector.name}: ufrag")
            assertEquals(expected.pwd, invite.pwd, "${vector.name}: password")
            assertEquals(expected.fingerprint, invite.fingerprint, "${vector.name}: fingerprint")
            assertEquals(expected.setup, invite.setup, "${vector.name}: setup role")
            assertEquals(expected.nick, invite.nick, "${vector.name}: nickname")
            assertEquals(expected.groupLabel, invite.groupLabel, "${vector.name}: group label")
            assertEquals(expected.keyAlgo, invite.keyAlgorithm, "${vector.name}: key algorithm")
            assertEquals(expected.publicKeyHex, Hex.encode(invite.publicKey), "${vector.name}: public key")
        }
    }

    @Test
    fun `candidates survive the round trip, including every address kind`() {
        for (vector in vectors.vectors) {
            val invite = openInvite(vector.code).invite
            assertEquals(vector.expected.candidates.size, invite.candidates.size, "${vector.name}: candidate count")
            vector.expected.candidates.forEachIndexed { index, expected ->
                val actual = invite.candidates[index]
                assertEquals(expected.type, actual.type, "${vector.name}: candidate $index type")
                assertEquals(expected.component, actual.component, "${vector.name}: candidate $index component")
                assertEquals(expected.address, actual.address, "${vector.name}: candidate $index address")
                assertEquals(expected.port, actual.port, "${vector.name}: candidate $index port")
            }
        }
    }

    @Test
    fun `contact details survive, including non-ascii text`() {
        val vector = vectors.vectors.first { it.expected.contact != null }
        val contact = assertNotNull(openInvite(vector.code).invite.contact, "contact details were dropped")
        assertEquals(vector.expected.contact!!.name, contact.name)
        assertEquals(vector.expected.contact!!.phone, contact.phone)
        assertEquals(vector.expected.contact!!.email, contact.email)
        assertEquals(vector.expected.contact!!.note, contact.note, "the note carried non-ascii characters")
    }

    @Test
    fun `the encoded contact json matches what the web client writes`() {
        // The contact block is JSON inside the payload, so the field names and
        // escaping have to agree, not just the values.
        val vector = vectors.vectors.first { it.expected.contact != null }
        val expected = vector.expected.contact!!
        val reopen = openInvite(vector.code).invite.contact!!
        val body = encodeInviteBody(
            openInvite(vector.code).invite.copy(contact = reopen),
        )
        assertContentEquals(Hex.decode(vector.bodyHex), body, "re-encoding a decoded contact changed the bytes")
        assertTrue(expected.note!!.contains("ü"), "the vector should exercise non-ascii escaping")
    }

    @Test
    fun `a code this implementation signs is one the format can read back`() {
        // The other direction: produce a code here and read it back. The web
        // client's side of this is checked by tools/verify-native-codes.mjs,
        // which is run against codes written out by this test suite.
        val identity = Identity.generate()
        val original = openInvite(vectors.vectors[0].code).invite.copy(
            publicKey = identity.publicKey,
            nick = "from-kotlin",
            ufrag = "kOtLiN01",
            pwd = "kotlinpassword1234567890",
        )
        val code = sealInvite(original, identity)
        assertTrue(code.startsWith("P2P1z-") || code.startsWith("P2P1r-"), "unexpected code prefix: $code")

        val opened = openInvite(code)
        assertTrue(opened.verified, "our own signature did not verify")
        assertEquals("from-kotlin", opened.invite.nick)
        assertEquals("kOtLiN01", opened.invite.ufrag)
        assertEquals(original.candidates.size, opened.invite.candidates.size)

        NativeCodes.record(code)
    }

    @Test
    fun `a tampered code is refused rather than silently accepted`() {
        val vector = vectors.vectors[0]
        val code = vector.code
        // Flip a character in the middle of the payload.
        val index = code.length / 2
        val replacement = if (code[index] == 'A') 'B' else 'A'
        val tampered = code.substring(0, index) + replacement + code.substring(index + 1)

        val result = runCatching { openInvite(tampered) }
        val verified = result.getOrNull()?.verified
        assertTrue(
            result.isFailure || verified == false,
            "a tampered code was accepted as genuine",
        )
    }

    @Test
    fun `truncated payloads are rejected, not read past the end`() {
        val body = Hex.decode(vectors.vectors[0].bodyHex)
        for (length in intArrayOf(0, 1, 5, body.size - 1)) {
            val result = runCatching { decodeInviteBody(body.copyOfRange(0, length)) }
            assertTrue(result.isFailure, "a $length-byte payload should not decode")
        }
    }

    @Test
    fun `a link is recognised however it is pasted`() {
        val code = vectors.vectors[0].code
        for (text in listOf(
            code,
            "$code\n",
            "  $code  ",
            "https://example.com/#i=$code",
            "wisp://pair#i=$code",
            "have a look at https://example.com/#i=$code and tell me",
        )) {
            assertEquals(code, extractCode(text), "failed to find the code in: $text")
        }
        assertEquals(null, extractCode("no code here at all"))
        assertEquals(null, extractCode(null))
    }

    @Test
    fun `the vectors were produced by the code we think they were`() {
        // A guard against the vectors being regenerated with a different tool by
        // accident: the public key in the file must be the one the codes verify
        // against.
        assertTrue(vectors.publicKeyHex.length == 130, "an uncompressed P-256 point is 65 bytes")
        for (vector in vectors.vectors) {
            assertEquals(
                vectors.publicKeyHex,
                Hex.encode(openInvite(vector.code).invite.publicKey),
                "${vector.name} was not signed by the vector key",
            )
        }
    }

    @Test
    fun `base64url matches the encoding the codes use`() {
        assertEquals("", Base64Url.encode(ByteArray(0)))
        assertEquals("Zg", Base64Url.encode("f".toByteArray()))
        assertEquals("Zm8", Base64Url.encode("fo".toByteArray()))
        assertEquals("Zm9v", Base64Url.encode("foo".toByteArray()))
        assertEquals("Zm9vYg", Base64Url.encode("foob".toByteArray()))
        assertEquals("Zm9vYmE", Base64Url.encode("fooba".toByteArray()))
        assertEquals("Zm9vYmFy", Base64Url.encode("foobar".toByteArray()))
        // The url-safe alphabet, with no padding.
        assertEquals("-_8", Base64Url.encode(byteArrayOf(0xfb.toByte(), 0xff.toByte())))
        for (text in listOf("", "f", "fo", "foo", "foob", "fooba", "foobar")) {
            assertContentEquals(text.toByteArray(), Base64Url.decode(Base64Url.encode(text.toByteArray())))
        }
    }

    @Test
    fun `deflate is raw, so the browser can read it`() {
        // A zlib header would be 78 9c; raw deflate has none, and the web client
        // uses `deflate-raw`. This is the kind of difference that fails only at
        // runtime, on somebody else's phone.
        val packed = "hello hello hello hello".toByteArray()
        val compressed = deflateRaw(packed)
        assertFalse(
            compressed.size >= 2 && compressed[0] == 0x78.toByte(),
            "the output carries a zlib header; the browser expects raw deflate",
        )
        assertContentEquals(packed, inflateRaw(compressed))
    }

    @Test
    fun `signatures are 64 bytes of r and s, not a DER sequence`() {
        val identity = Identity.generate()
        val signature = identity.sign("something worth signing".toByteArray())
        assertEquals(64, signature.size, "the invite reserves exactly 64 bytes")
        assertTrue(
            verifySignature(identity.publicKey, KeyAlgorithm.P256, "something worth signing".toByteArray(), signature),
        )
        assertFalse(
            verifySignature(identity.publicKey, KeyAlgorithm.P256, "something else".toByteArray(), signature),
        )
    }
}
