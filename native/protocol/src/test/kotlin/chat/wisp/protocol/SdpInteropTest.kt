package chat.wisp.protocol

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * The SDP half of the format, held to the web client.
 *
 * A browser will reject a session description that is not exactly right, and
 * "nearly right" is not a category it accepts. These vectors come from
 * src/sdp.js, so a mismatch here is a phone that cannot pair with a desktop.
 */
class SdpInteropTest {

    private val vectors: Map<*, *> by lazy {
        val file = listOf(
            java.io.File("src/test/resources/sdp-vectors.json"),
            java.io.File("protocol/src/test/resources/sdp-vectors.json"),
            java.io.File("../protocol/src/test/resources/sdp-vectors.json"),
        ).firstOrNull { it.exists() }
            ?: error("sdp-vectors.json not found; run: node tools/make-vectors.mjs")
        MiniJson.parse(file.readText()) as Map<*, *>
    }

    private fun map(value: Any?): Map<*, *> = value as Map<*, *>
    private fun list(value: Any?): List<*> = value as List<*>
    private fun str(value: Any?): String = value as String
    private fun int(value: Any?): Int = (value as Number).toInt()
    private fun long(value: Any?): Long = (value as Number).toLong()

    @Test
    fun `the skeleton is read exactly as the web client reads it`() {
        val expected = map(vectors["extracted"])
        val fields = extractSdpFields(str(vectors["skeleton"]))

        assertEquals(str(expected["sessionId"]), fields.sessionId, "session id")
        assertEquals(str(expected["ufrag"]), fields.ufrag, "ufrag")
        assertEquals(str(expected["pwd"]), fields.pwd, "password")
        assertEquals(str(expected["setup"]), fields.setup, "setup role")
        val fingerprint = map(expected["fingerprint"])
        assertEquals(str(fingerprint["algo"]), fields.fingerprint?.algorithm, "fingerprint algorithm")
        assertEquals(str(fingerprint["value"]), fields.fingerprint?.value, "fingerprint value")
        assertEquals(list(expected["candidates"]).size, fields.candidates.size, "candidate count")
    }

    @Test
    fun `a session description is rebuilt byte for byte`() {
        // The one that matters: a browser has to accept what this produces.
        val build = map(vectors["build"])
        val expected = str(build["expected"])
        val fields = map(build["fields"])

        val rebuilt = buildSdpFromSkeleton(
            str(vectors["skeleton"]),
            SdpFields(
                sessionId = str(fields["sessionId"]),
                ufrag = str(fields["ufrag"]),
                pwd = str(fields["pwd"]),
                fingerprint = map(fields["fingerprint"]).let {
                    Fingerprint(str(it["algo"]), str(it["value"]))
                },
                setup = str(fields["setup"]),
                candidates = list(fields["candidates"]).map { raw ->
                    val candidate = map(raw)
                    SdpCandidate(
                        foundation = "",
                        component = int(candidate["component"]),
                        transport = str(candidate["transport"]),
                        priority = computePriority(str(candidate["type"]), int(candidate["component"])),
                        address = str(candidate["address"]),
                        port = int(candidate["port"]),
                        type = str(candidate["type"]),
                    )
                },
            ),
        )

        assertEquals(
            expected.replace("\r\n", "\n"),
            rebuilt.replace("\r\n", "\n"),
            "the rebuilt description differs from the web client's",
        )
    }

    @Test
    fun `candidate lines parse the same way`() {
        for (entry in list(vectors["candidateLines"])) {
            val line = str(entry)
            val expected = vectors["parsed"]?.let { parsed ->
                list(parsed).map { map(it) }.firstOrNull { str(it["line"]) == line }?.get("parsed")
            }
            val actual = parseCandidateLine(line)
            if (expected == null) {
                assertNull(actual, "should not have parsed: $line")
                continue
            }
            val wanted = map(expected)
            assertNotNull(actual, "failed to parse: $line")
            assertEquals(str(wanted["foundation"]), actual.foundation, "$line: foundation")
            assertEquals(int(wanted["component"]), actual.component, "$line: component")
            assertEquals(str(wanted["transport"]), actual.transport, "$line: transport")
            assertEquals(long(wanted["priority"]), actual.priority, "$line: priority")
            assertEquals(str(wanted["address"]), actual.address, "$line: address")
            assertEquals(int(wanted["port"]), actual.port, "$line: port")
            assertEquals(str(wanted["type"]), actual.type, "$line: type")
        }
    }

    @Test
    fun `a TCP candidate is parsed, and a non-candidate line is not`() {
        assertNotNull(parseCandidateLine("a=candidate:3 1 tcp 2105458943 192.168.0.201 9 typ host tcptype active"))
        assertNull(parseCandidateLine("not a candidate at all"))
        assertNull(parseCandidateLine("a=candidate:3 1 udp 123 10.0.0.1 9 typ nonsense"))
    }

    @Test
    fun `candidate lines are written the same way`() {
        for (entry in list(vectors["formatted"])) {
            val record = map(entry)
            val candidate = map(record["candidate"])
            val line = formatCandidateLine(
                SdpCandidate(
                    foundation = "",
                    component = int(candidate["component"]),
                    transport = str(candidate["transport"]),
                    priority = long(record["priority"]),
                    address = str(candidate["address"]),
                    port = int(candidate["port"]),
                    type = str(candidate["type"]),
                ),
            )
            assertEquals(str(record["line"]), line, "formatted line differs")
        }
    }

    @Test
    fun `priorities follow the RFC, so the far side recomputes the same numbers`() {
        // These are not carried on the wire: both sides derive them, so a
        // disagreement here would silently change which path gets chosen.
        for (entry in list(vectors["priorities"])) {
            val record = map(entry)
            assertEquals(long(record["value"]), computePriority(str(record["type"]), 1), str(record["type"]))
        }
        assertTrue(computePriority("host") > computePriority("srflx"), "host should beat srflx")
        assertTrue(computePriority("srflx") > computePriority("relay"), "srflx should beat relay")
        assertEquals(computePriority("host", 1) - 1, computePriority("host", 2), "component 2 ranks lower")
    }

    @Test
    fun `duplicate candidates are dropped the same way`() {
        val deduped = dedupeCandidates(
            listOf(
                SdpCandidate("", 1, "udp", 1, "10.0.0.1", 1, "host"),
                SdpCandidate("", 1, "udp", 1, "10.0.0.1", 1, "host"),
                SdpCandidate("", 1, "udp", 1, "10.0.0.1", 2, "host"),
                SdpCandidate("", 1, "udp", 1, "10.0.0.1", 1, "srflx"),
            ),
        )
        assertEquals(list(vectors["dedupe"]).size, deduped.size, "kept a different number of candidates")
    }

    @Test
    fun `private addresses are recognised the same way`() {
        // This is what tells somebody their invite only works on the same
        // network, so getting it wrong produces a confident lie in the UI.
        for (entry in list(vectors["privateAddresses"])) {
            val record = map(entry)
            assertEquals(
                record["isPrivate"] as Boolean,
                isPrivateAddress(str(record["address"])),
                str(record["address"]),
            )
        }
    }

    @Test
    fun `candidates are stripped before a skeleton is reused`() {
        val skeleton = str(vectors["skeleton"])
        val stripped = stripCandidates(skeleton)
        assertTrue(stripped.isNotEmpty())
        assertTrue(!stripped.contains("a=candidate:"), "candidate lines survived stripping")
        assertTrue(!stripped.contains("a=end-of-candidates"), "the end marker survived stripping")
        assertTrue(stripped.contains("a=ice-ufrag:"), "the rest of the description was lost")
    }

    @Test
    fun `rebuilding twice gives the same answer`() {
        // Rebuilding is not idempotent in general — the origin version is bumped —
        // but with the same fields it must be, or a retry would produce a
        // description the peer has already rejected.
        val build = map(vectors["build"])
        val fields = map(build["fields"])
        val parsed = extractSdpFields(str(build["expected"]))
        val again = buildSdpFromSkeleton(
            str(vectors["skeleton"]),
            parsed.copy(sessionId = str(fields["sessionId"])),
        )
        val once = buildSdpFromSkeleton(
            str(vectors["skeleton"]),
            SdpFields(
                sessionId = str(fields["sessionId"]),
                ufrag = parsed.ufrag,
                pwd = parsed.pwd,
                fingerprint = parsed.fingerprint,
                setup = parsed.setup,
                candidates = parsed.candidates,
            ),
        )
        assertEquals(once.replace("\r\n", "\n"), again.replace("\r\n", "\n"))
    }
}
