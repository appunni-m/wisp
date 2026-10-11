import test from 'node:test';
import assert from 'node:assert/strict';

import {
  QUALITY,
  QUALITY_PROFILES,
  capForAvailableBitrate,
  QualityGovernor,
  decideQuality,
  summariseStats,
  tuneOpus,
} from '../../src/call.js';

/* ------------------------------------------------------------- the policy */

test('a clean connection is good', () => {
  assert.equal(decideQuality({ lossRate: 0, roundTripTime: 0.02, jitter: 0.001 }), QUALITY.GOOD);
});

test('a little loss or delay is fair', () => {
  assert.equal(decideQuality({ lossRate: 0.03 }), QUALITY.FAIR);
  assert.equal(decideQuality({ roundTripTime: 0.2 }), QUALITY.FAIR);
  assert.equal(decideQuality({ jitter: 0.03 }), QUALITY.FAIR);
});

test('a bad connection falls to poor before it falls to audio only', () => {
  assert.equal(decideQuality({ lossRate: 0.06 }), QUALITY.POOR);
  assert.equal(decideQuality({ roundTripTime: 0.5 }), QUALITY.POOR);
});

test('heavy loss gives up on video to save the voice', () => {
  const tier = decideQuality({ lossRate: 0.25, roundTripTime: 1.4 });
  assert.equal(tier, QUALITY.BAD);
  assert.equal(QUALITY_PROFILES[tier].video, false, 'the profile must actually drop video');
});

test('the bandwidth estimate never decides the tier on its own', () => {
  // It starts near zero and climbs, so a flawless call would be pronounced
  // audio-only in its first seconds. Only symptoms move the tier.
  assert.equal(decideQuality({ availableOutgoingBitrate: 20_000 }), QUALITY.GOOD);
  assert.equal(decideQuality({}), QUALITY.GOOD);
});

test('a tight estimate trims the bitrate to fit', () => {
  const good = QUALITY_PROFILES[QUALITY.GOOD];
  const trimmed = capForAvailableBitrate(good, 600_000);
  assert.ok(trimmed.videoBitrate < good.videoBitrate, 'must send less than the estimate allows');
  assert.ok(trimmed.videoBitrate >= 250_000, `trimmed to ${trimmed.videoBitrate}, which is too harsh`);
  assert.equal(trimmed.audioBitrate, good.audioBitrate, 'audio is not what gets sacrificed');
});

test('an estimate too small for a picture drops the video but keeps the call', () => {
  const capped = capForAvailableBitrate(QUALITY_PROFILES[QUALITY.GOOD], 80_000);
  assert.equal(capped.video, false);
  assert.equal(capped.videoBitrate, 0);
  assert.ok(capped.audioBitrate > 0, 'the voice must survive');
});

test('a generous estimate changes nothing', () => {
  const good = QUALITY_PROFILES[QUALITY.GOOD];
  assert.equal(capForAvailableBitrate(good, 8_000_000), good);
  assert.equal(capForAvailableBitrate(good, null), good, 'no estimate is not a bad estimate');
  assert.equal(capForAvailableBitrate(QUALITY_PROFILES[QUALITY.BAD], 8_000_000).video, false);
});

test('every tier has a profile with sane numbers', () => {
  for (const [name, profile] of Object.entries(QUALITY_PROFILES)) {
    assert.ok(profile.label, `${name} needs a label`);
    assert.ok(profile.audioBitrate > 0, `${name} must leave audio something`);
    assert.ok(profile.scale >= 1, `${name} cannot scale up`);
    assert.ok(profile.maxFps > 0);
    if (profile.video) assert.ok(profile.videoBitrate > 0, `${name} claims video but sends none`);
    else assert.equal(profile.videoBitrate, 0);
  }
  // Worse connections must never get more bandwidth than better ones.
  const order = [QUALITY.BAD, QUALITY.POOR, QUALITY.FAIR, QUALITY.GOOD];
  for (let i = 1; i < order.length; i++) {
    assert.ok(
      QUALITY_PROFILES[order[i]].videoBitrate >= QUALITY_PROFILES[order[i - 1]].videoBitrate,
      `${order[i]} should not be stingier than ${order[i - 1]}`,
    );
  }
});

/* --------------------------------------------------------------- damping */

test('a single bad sample does not drop the quality', () => {
  const governor = new QualityGovernor({ dropAfter: 2 });
  assert.equal(governor.sample({ lossRate: 0.3 }), QUALITY.GOOD, 'one hiccup is not a trend');
  assert.equal(governor.sample({ lossRate: 0.3 }), QUALITY.BAD, 'two in a row is');
});

test('quality drops immediately by default, because stuttering is worse', () => {
  const governor = new QualityGovernor();
  assert.equal(governor.sample({ lossRate: 0.3 }), QUALITY.BAD);
});

test('recovering takes longer than falling', () => {
  const governor = new QualityGovernor();
  governor.sample({ lossRate: 0.3 });
  assert.equal(governor.tier, QUALITY.BAD);

  // Three calm samples are needed before climbing back to good.
  assert.equal(governor.sample({}), QUALITY.BAD);
  assert.equal(governor.sample({}), QUALITY.BAD);
  assert.equal(governor.sample({}), QUALITY.GOOD);
});

test('a wobbling connection does not oscillate', () => {
  const governor = new QualityGovernor({ dropAfter: 2, riseAfter: 3 });
  const seen = [];
  for (const reading of [{}, { lossRate: 0.3 }, {}, { lossRate: 0.3 }, {}, {}, {}, {}]) {
    seen.push(governor.sample(reading));
  }
  // Alternating samples never confirm anything, so the tier only moves when the
  // evidence is consistent.
  const changes = seen.filter((tier, index) => index > 0 && tier !== seen[index - 1]).length;
  assert.ok(changes <= 2, `tier changed ${changes} times; it should be stable`);
});

test('a reading that matches the current tier resets the streak', () => {
  const governor = new QualityGovernor({ dropAfter: 2 });
  governor.sample({ lossRate: 0.3 });
  governor.sample({}); // back to normal, streak cleared
  assert.equal(governor.sample({ lossRate: 0.3 }), QUALITY.GOOD, 'the earlier sample should not count');
});

/* ---------------------------------------------------------------- reading */

function fakeReport(entries) {
  return { forEach: (fn) => entries.forEach(fn) };
}

test('loss is read from both directions', () => {
  const summary = summariseStats(fakeReport([
    { type: 'inbound-rtp', packetsReceived: 90, packetsLost: 10, jitter: 0.01 },
  ]));
  assert.equal(summary.lossRate, 0.1);
  assert.equal(summary.jitter, 0.01);
});

test('the nominated candidate pair supplies the round trip time', () => {
  const summary = summariseStats(fakeReport([
    { type: 'candidate-pair', state: 'succeeded', nominated: true, currentRoundTripTime: 0.08, availableOutgoingBitrate: 1_200_000 },
    { type: 'candidate-pair', state: 'succeeded', nominated: false, currentRoundTripTime: 9 },
  ]));
  assert.equal(summary.roundTripTime, 0.08, 'an unnominated pair is not the one in use');
  assert.equal(summary.availableOutgoingBitrate, 1_200_000);
});

test('a report with nothing in it is not a catastrophe', () => {
  const summary = summariseStats(fakeReport([]));
  assert.equal(summary.lossRate, 0);
  assert.equal(summary.roundTripTime, 0);
  assert.equal(decideQuality(summary), QUALITY.GOOD);
});

/* ----------------------------------------------------------------- codec */

test('opus is told to add redundancy and to go quiet when nobody speaks', () => {
  const sdp = 'a=rtpmap:111 opus/48000/2\r\na=fmtp:111 minptime=10;useinbandfec=0\r\n';
  const tuned = tuneOpus(sdp);
  assert.match(tuned, /useinbandfec=1/);
  assert.match(tuned, /usedtx=1/);
});

test('tuning leaves an already-tuned line alone', () => {
  const sdp = 'a=rtpmap:111 opus/48000/2\r\na=fmtp:111 minptime=10;useinbandfec=1;usedtx=1\r\n';
  const tuned = tuneOpus(sdp);
  assert.equal((tuned.match(/a=fmtp:111/g) ?? []).length, 1, 'no duplicate fmtp line');
});

test('sdp without opus passes through untouched', () => {
  const sdp = 'a=rtpmap:0 PCMU/8000\r\n';
  assert.equal(tuneOpus(sdp), sdp);
});
