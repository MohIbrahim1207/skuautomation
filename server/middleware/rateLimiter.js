/**
 * In-memory sliding window rate limiter middleware for standard drawing uploads.
 * Protects against DoS / resource exhaustion while supporting normal engineering team workflows.
 */

class RateLimiter {
  constructor(options = {}) {
    this.windowMs = options.windowMs || 15 * 60 * 1000; // 15 minutes default
    this.max = options.max || 60; // 60 uploads per 15 minutes per user/IP
    this.message = options.message || 'Upload rate limit exceeded. Please wait a few minutes before uploading another drawing.';
    this.hits = new Map(); // key -> array of timestamps

    // Cleanup stale entries every 5 minutes
    this.cleanupTimer = setInterval(() => {
      this.cleanup();
    }, 5 * 60 * 1000);

    if (this.cleanupTimer.unref) {
      this.cleanupTimer.unref();
    }
  }

  cleanup() {
    const now = Date.now();
    for (const [key, timestamps] of this.hits.entries()) {
      const valid = timestamps.filter(ts => now - ts < this.windowMs);
      if (valid.length === 0) {
        this.hits.delete(key);
      } else {
        this.hits.set(key, valid);
      }
    }
  }

  middleware() {
    return (req, res, next) => {
      // Key on authenticated user ID or username, fallback to client IP
      const key = (req.user && req.user.id) || (req.user && req.user.username) || req.ip || req.connection.remoteAddress || 'unknown';
      const now = Date.now();

      let timestamps = this.hits.get(key) || [];
      // Remove timestamps outside window
      timestamps = timestamps.filter(ts => now - ts < this.windowMs);

      if (timestamps.length >= this.max) {
        const oldestTimestamp = timestamps[0];
        const retryAfterSeconds = Math.ceil((this.windowMs - (now - oldestTimestamp)) / 1000);

        res.set({
          'Retry-After': String(retryAfterSeconds),
          'X-RateLimit-Limit': String(this.max),
          'X-RateLimit-Remaining': '0',
          'X-RateLimit-Reset': String(Math.ceil((oldestTimestamp + this.windowMs) / 1000))
        });

        return res.status(429).json({
          error: this.message,
          retryAfter: retryAfterSeconds
        });
      }

      timestamps.push(now);
      this.hits.set(key, timestamps);

      const remaining = Math.max(0, this.max - timestamps.length);
      res.set({
        'X-RateLimit-Limit': String(this.max),
        'X-RateLimit-Remaining': String(remaining),
        'X-RateLimit-Reset': String(Math.ceil((timestamps[0] + this.windowMs) / 1000))
      });

      next();
    };
  }

  reset() {
    this.hits.clear();
  }
}

// 60 uploads per 15 minutes allows ample head-room for normal engineering operations
const uploadRateLimiter = new RateLimiter({
  windowMs: 15 * 60 * 1000,
  max: 60,
  message: 'Standard drawing upload rate limit exceeded (max 60 uploads per 15 minutes). Please try again shortly.'
});

module.exports = {
  RateLimiter,
  uploadRateLimiter: uploadRateLimiter.middleware(),
  defaultRateLimiterInstance: uploadRateLimiter
};
