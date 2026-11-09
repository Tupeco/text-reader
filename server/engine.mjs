// @ts-check
// Shared types and errors for the translation engines.

/**
 * @typedef {object} Engine
 * @property {string} id
 * @property {string} label Shown to users, e.g. "DeepL".
 * @property {(texts: string[], source: string, target: string) => Promise<string[]>} translate
 *   Translates each text (a paragraph of card text) independently; same order and count.
 * @property {() => Promise<boolean>} [available] Whether to offer it right now (default: always).
 */

/** An error whose message is safe to show to app users; `status` is the HTTP status to answer with. */
export class EngineError extends Error {
  constructor(/** @type {string} */ message, /** @type {number} */ status = 502) {
    super(message);
    this.status = status;
  }
}

/** Retries `fn` on transient failures (it throws `{ retry: true }`-marked errors), with backoff. */
export async function withRetry(/** @type {() => Promise<any>} */ fn, attempts = 3, baseMs = 500) {
  for (let i = 1; ; i++) {
    try {
      return await fn();
    } catch (e) {
      if (!(e instanceof RetryableError) || i >= attempts) throw e instanceof RetryableError ? e.cause : e;
      await new Promise((r) => setTimeout(r, e.afterMs ?? baseMs * 2 ** (i - 1) * (0.5 + Math.random())));
    }
  }
}

export class RetryableError extends Error {
  /** @param {Error} cause @param {number} [afterMs] Wait before retrying, e.g. from Retry-After. */
  constructor(cause, afterMs) {
    super(cause.message, { cause });
    this.cause = cause;
    this.afterMs = afterMs;
  }
}
