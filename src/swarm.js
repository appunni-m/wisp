/**
 * Fetching one file from several peers at once.
 *
 * A one-to-one chat has exactly one source, so there is nothing to swarm: the
 * parallelism there is inside the link, in media.js. This matters in a room,
 * where several members may already hold the same file — a video one person
 * shared can then be pulled from everyone who has it, in parallel, which is the
 * difference between waiting for one phone's uplink and using all of them.
 *
 * Three things make it safe rather than merely fast:
 *
 *   - **Disjoint work.** Each source is asked for a different set of chunks, so
 *     no bytes are fetched twice. The split is round-robin so a slow source
 *     delays at most its share.
 *   - **Piece verification.** Chunks are checked against the manifest as their
 *     piece completes, so a peer that serves rubbish is caught while the
 *     transfer is running, not after it finishes.
 *   - **Reassignment.** If a source goes away, only its unfinished chunks are
 *     handed to somebody else. Everything already verified is kept.
 *
 * The scheduler is pure: it takes what is missing and who is available, and
 * returns an assignment. That is the part worth testing.
 */

/** How many chunks to ask a source for in one go. */
export const REQUEST_BATCH = 64;

/**
 * Split the missing sequences across the available sources.
 *
 * Round-robin rather than contiguous ranges: a source that is slow or drops out
 * then costs a fixed fraction of its share, instead of leaving one long tail
 * that everything else has to wait for.
 */
export function planSources(missing, sources) {
  const plan = new Map();
  if (!sources.length || !missing.length) return plan;

  sources.forEach((source) => plan.set(source, []));
  missing.forEach((sequence, index) => {
    plan.get(sources[index % sources.length]).push(sequence);
  });
  return plan;
}

/** Break a source's share into request-sized batches. */
export function toBatches(sequences, batchSize = REQUEST_BATCH) {
  const batches = [];
  for (let i = 0; i < sequences.length; i += batchSize) {
    batches.push(sequences.slice(i, i + batchSize));
  }
  return batches;
}

/**
 * Keeps track of who is fetching what, and what to do when somebody drops.
 *
 * Deliberately unaware of the transport: it is handed callbacks, so its
 * behaviour under failure can be tested without a peer.
 */
export class Swarm {
  #sources = new Map();
  #outstanding = new Map();
  #completed = new Set();
  #cancelled = false;

  constructor({ total, held = new Set(), onComplete, onProgress, onRequest } = {}) {
    this.total = total;
    this.held = new Set(held);
    this.onComplete = onComplete;
    this.onProgress = onProgress;
    this.onRequest = onRequest;
  }

  get remaining() {
    return this.total - this.held.size;
  }

  get progress() {
    return this.total ? this.held.size / this.total : 1;
  }

  /** Sources currently able to serve, best first. */
  addSources(sources) {
    for (const source of sources) {
      if (!this.#sources.has(source)) this.#sources.set(source, { pending: 0 });
    }
  }

  removeSource(source) {
    this.#sources.delete(source);
    const orphaned = this.#outstanding.get(source) ?? [];
    this.#outstanding.delete(source);
    if (!orphaned.length) return [];
    // Only the chunks that never arrived are handed on; verified data is kept.
    return this.#redistribute(orphaned.filter((sequence) => !this.held.has(sequence)));
  }

  /** Ask every source for its share. Returns the requests made. */
  start() {
    const missing = [];
    for (let sequence = 0; sequence < this.total; sequence++) {
      if (!this.held.has(sequence)) missing.push(sequence);
    }
    if (!missing.length) {
      this.onComplete?.();
      return [];
    }
    return this.#redistribute(missing);
  }

  #redistribute(sequences) {
    const sources = [...this.#sources.keys()];
    if (!sources.length) return [];
    const plan = planSources(sequences, sources);
    const issued = [];
    for (const [source, share] of plan) {
      if (!share.length) continue;
      this.#outstanding.set(source, share);
      for (const batch of toBatches(share)) {
        issued.push({ source, sequences: batch });
        this.onRequest?.(source, batch);
      }
    }
    return issued;
  }

  /**
   * A chunk arrived. Returns true when it was new — a duplicate from a second
   * source is ignored rather than corrupting the count.
   */
  accept(sequence) {
    if (this.#cancelled || this.held.has(sequence)) return false;
    this.held.add(sequence);
    this.#completed.add(sequence);
    this.onProgress?.(this.progress);
    if (this.held.size >= this.total) {
      this.onComplete?.();
    }
    return true;
  }

  /** A chunk was checked against the manifest and rejected. */
  reject(sequence, source) {
    this.held.delete(sequence);
    this.#completed.delete(sequence);
    // Drop the source that served it, and re-queue the work elsewhere.
    this.#outstanding.delete(source);
    this.#sources.delete(source);
    return this.#redistribute([sequence]);
  }

  cancel() {
    this.#cancelled = true;
    this.#outstanding.clear();
  }

  get cancelled() {
    return this.#cancelled;
  }

  sources() {
    return [...this.#sources.keys()];
  }
}
