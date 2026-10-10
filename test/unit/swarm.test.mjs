import test from 'node:test';
import assert from 'node:assert/strict';

import { planSources, toBatches, Swarm, REQUEST_BATCH } from '../../src/swarm.js';

const range = (n, from = 0) => Array.from({ length: n }, (_, i) => from + i);

/* ------------------------------------------------------------- scheduling */

test('work is split across every source with nothing asked twice', () => {
  const missing = range(10);
  const plan = planSources(missing, ['peerA', 'peerB', 'peerC']);

  const all = [...plan.values()].flat();
  assert.equal(all.length, 10, 'every chunk is assigned');
  assert.equal(new Set(all).size, 10, 'and none is assigned twice');
  assert.deepEqual([...plan.keys()], ['peerA', 'peerB', 'peerC']);
  for (const share of plan.values()) assert.ok(share.length >= 3, 'shares are even');
});

test('a single source is given everything', () => {
  const plan = planSources(range(5), ['only']);
  assert.deepEqual(plan.get('only'), [0, 1, 2, 3, 4]);
});

test('an uneven split still covers everything', () => {
  const plan = planSources(range(7), ['a', 'b']);
  assert.equal(plan.get('a').length, 4);
  assert.equal(plan.get('b').length, 3);
  assert.equal(new Set([...plan.get('a'), ...plan.get('b')]).size, 7);
});

test('round robin spreads the load rather than giving each source a block', () => {
  // With contiguous ranges, one slow source leaves a tail everyone waits on.
  const plan = planSources(range(6), ['a', 'b']);
  assert.deepEqual(plan.get('a'), [0, 2, 4]);
  assert.deepEqual(plan.get('b'), [1, 3, 5]);
});

test('nothing to do, or nobody to ask, yields nothing', () => {
  assert.equal(planSources([], ['a']).size, 0);
  assert.equal(planSources([1, 2], []).size, 0);
});

test('requests are batched so one message cannot grow without bound', () => {
  const batches = toBatches(range(REQUEST_BATCH * 2 + 5));
  assert.equal(batches.length, 3);
  assert.equal(batches[0].length, REQUEST_BATCH);
  assert.equal(batches[2].length, 5);
  assert.deepEqual(toBatches([1, 2, 3], 10), [[1, 2, 3]]);
});

/* ------------------------------------------------------------------ swarm */

function collector(options = {}) {
  const requests = [];
  let completed = 0;
  const swarm = new Swarm({
    total: 100,
    ...options,
    onRequest: (source, sequences) => requests.push({ source, sequences }),
    onComplete: () => {
      completed++;
      options.onComplete?.();
    },
  });
  return { swarm, requests, get completed() { return completed; } };
}

test('starting a swarm asks each source for its share', () => {
  const { swarm, requests } = collector();
  swarm.addSources(['p1', 'p2', 'p3']);
  const issued = swarm.start();

  assert.equal(requests.length, 3, 'one request per source');
  assert.equal(issued.length, 3);
  const asked = new Set(requests.flatMap((r) => r.sequences));
  assert.equal(asked.size, 100, 'all 100 chunks are accounted for');
});

test('chunks already held are never requested again', () => {
  const held = new Set(range(40));
  const { swarm, requests } = collector({ held: new Set(held) });
  swarm.addSources(['p1']);
  swarm.start();

  const asked = new Set(requests.flatMap((r) => r.sequences));
  assert.equal(asked.size, 60);
  assert.equal([...asked].some((sequence) => held.has(sequence)), false);
  assert.equal(swarm.progress, 0.4);
});

test('a duplicate chunk from a second source is ignored', () => {
  const { swarm } = collector();
  swarm.addSources(['p1']);
  assert.equal(swarm.accept(0), true);
  assert.equal(swarm.accept(0), false, 'the same chunk twice is not two chunks');
  assert.equal(swarm.progress, 0.01);
});

test('completing every chunk fires once', () => {
  // Not destructured: `completed` is a getter, and destructuring would snapshot
  // it at zero.
  const run = collector({ total: 3 });
  run.swarm.addSources(['p1']);
  run.swarm.start();
  run.swarm.accept(0);
  run.swarm.accept(1);
  assert.equal(run.completed, 0);
  run.swarm.accept(2);
  assert.equal(run.completed, 1);
  run.swarm.accept(2);
  assert.equal(run.completed, 1, 'and not twice');
});

test('a source that vanishes has only its unfinished work handed on', () => {
  const { swarm, requests } = collector();
  swarm.addSources(['fast', 'flaky']);
  swarm.start();

  // Everything except the last few has arrived.
  for (const sequence of range(95)) swarm.accept(sequence);
  requests.length = 0;

  const reassigned = swarm.removeSource('flaky');
  const asked = reassigned.flatMap((r) => r.sequences);

  assert.ok(asked.length > 0, 'the orphaned chunks are re-queued');
  assert.equal(asked.some((sequence) => swarm.held.has(sequence)), false, 'verified data is kept');
  assert.deepEqual([...new Set(asked)].sort((a, b) => a - b), asked.slice().sort((a, b) => a - b));
  assert.equal(swarm.sources().includes('flaky'), false);
});

test('a source that serves bad data is dropped and its chunk re-queued', () => {
  const { swarm, requests } = collector({ total: 10 });
  swarm.addSources(['liar', 'honest']);
  swarm.start();
  requests.length = 0;

  swarm.accept(0);
  const reissued = swarm.reject(5, 'liar');

  assert.equal(swarm.sources().includes('liar'), false, 'the bad source is not asked again');
  assert.equal(swarm.held.has(5), false, 'the rejected chunk is not counted as held');
  const asked = reissued.flatMap((r) => r.sequences);
  assert.ok(asked.includes(5), 'and it is requested from somebody else');
  assert.equal(asked.every((sequence) => !swarm.held.has(sequence)), true);
});

test('losing every source leaves the work queued, not lost', () => {
  const { swarm } = collector({ total: 5 });
  swarm.addSources(['only']);
  swarm.start();
  swarm.removeSource('only');
  assert.equal(swarm.sources().length, 0);
  assert.equal(swarm.progress, 0, 'nothing was falsely marked done');

  // A new source turns up later: the remaining work is still known.
  swarm.addSources(['late']);
  const issued = swarm.start();
  assert.equal(issued.flatMap((r) => r.sequences).length, 5);
});

test('cancelling stops accepting anything', () => {
  const { swarm } = collector({ total: 4 });
  swarm.addSources(['p1']);
  swarm.start();
  swarm.cancel();
  assert.equal(swarm.cancelled, true);
  assert.equal(swarm.accept(0), false);
});

test('a swarm with everything already held completes immediately', () => {
  let done = 0;
  const swarm = new Swarm({ total: 10, held: new Set(range(10)), onComplete: () => done++ });
  swarm.addSources(['p1']);
  assert.deepEqual(swarm.start(), []);
  assert.equal(done, 1);
});
