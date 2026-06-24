import type { Request, Response, NextFunction, RequestHandler } from 'express';

/**
 * Minimal in-memory token-bucket rate limiter.
 *
 * Zero-dependency on purpose. This is fine for a single instance (dev/staging,
 * or prod behind a sticky LB). For multi-instance production, swap the Map for
 * a Redis-backed store (e.g. `express-rate-limit` + `rate-limit-redis`) and
 * keep this module's exported limiter API unchanged so call sites don't move.
 *
 * Each limiter keeps a Map<key, { hits, resetAt }> and sweeps expired buckets
 * lazily so memory does not grow unbounded under churn from one-off clients.
 */
interface Bucket {
  hits: number;
  resetAt: number;
}

interface LimiterOptions {
  /** Window length in milliseconds. */
  windowMs: number;
  /** Max requests per window per key. */
  limit: number;
  /** Derives the rate-limit key from a request (default: IP + userId). */
  keyGenerator?: (req: Request) => string;
  /** Optional response body override on 429. */
  message?: unknown;
}

export function createRateLimiter(opts: LimiterOptions): RequestHandler {
  const buckets = new Map<string, Bucket>();
  const keyOf =
    opts.keyGenerator ??
    ((req: Request) => `${req.ip ?? 'unknown'}:${req.auth?.userId ?? 'anon'}`);

  return (req: Request, res: Response, next: NextFunction) => {
    const now = Date.now();
    const key = keyOf(req);
    const existing = buckets.get(key);

    let bucket: Bucket;
    if (!existing || existing.resetAt <= now) {
      bucket = { hits: 1, resetAt: now + opts.windowMs };
      buckets.set(key, bucket);
    } else {
      existing.hits += 1;
      bucket = existing;
    }

    // Periodic GC of expired buckets to avoid a memory leak under churn.
    if (buckets.size > 1000 && Math.random() < 0.01) {
      for (const [k, b] of buckets) if (b.resetAt <= now) buckets.delete(k);
    }

    res.setHeader('X-RateLimit-Limit', String(opts.limit));
    res.setHeader(
      'X-RateLimit-Remaining',
      String(Math.max(0, opts.limit - bucket.hits)),
    );
    res.setHeader('X-RateLimit-Reset', String(Math.floor(bucket.resetAt / 1000)));

    if (bucket.hits > opts.limit) {
      res.status(429).json(
        opts.message ?? {
          error: {
            code: 'RATE_LIMITED',
            message: 'Too many requests. Please slow down.',
          },
        },
      );
      return;
    }
    next();
  };
}

/**
 * Tighter limit for presign endpoints. Each call burns an IAM action, and a
 * burst from one bad client can warm up the S3 bill while doing nothing
 * legitimate. 20/min per IP+user is plenty for honest UX.
 */
export const presignLimiter = createRateLimiter({
  windowMs: 60 * 1000,
  limit: 20,
  message: {
    error: {
      code: 'RATE_LIMITED',
      message: 'Too many upload requests; slow down.',
    },
  },
});

/** General-purpose write limiter for create/update/delete routes. */
export const writeLimiter = createRateLimiter({
  windowMs: 60 * 1000,
  limit: 60,
});
