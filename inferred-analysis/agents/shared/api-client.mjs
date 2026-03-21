/**
 * Rate-Limited API Client with Caching, Retry, and Circuit Breaker
 *
 * Provides a production-grade data pipeline for external API calls:
 *   - Rate limiting with configurable requests/minute (Alpha Vantage free tier = 5/min)
 *   - Priority request queue (live > backtest > research)
 *   - Automatic retry with exponential backoff (max 3 retries)
 *   - Response caching with configurable TTL (1h intraday, 24h daily)
 *   - Cache invalidation on TTL expiry
 *   - Fallback chain: API -> stale cache -> synthetic data (with warning)
 *   - Circuit breaker for external APIs
 *
 * Usage:
 *   import { apiClient, RateLimitedClient, ResponseCache, CircuitBreaker } from '../shared/api-client.mjs';
 *
 *   // Use the default singleton
 *   const data = await apiClient.request('https://api.example.com/data', { priority: 'live' });
 *
 *   // Or create a custom client
 *   const client = new RateLimitedClient({ requestsPerMinute: 5 });
 */

// ─── Priority Levels ────────────────────────────────────

export const Priority = Object.freeze({
  LIVE: 0,      // Live trading — highest priority
  BACKTEST: 1,  // Backtesting
  RESEARCH: 2,  // Research / exploration — lowest priority
});

const PRIORITY_LABELS = { [Priority.LIVE]: 'live', [Priority.BACKTEST]: 'backtest', [Priority.RESEARCH]: 'research' };

// ─── Response Cache with TTL ────────────────────────────

export class ResponseCache {
  /**
   * @param {object} opts
   * @param {number} opts.defaultTTL      - Default TTL in ms (default: 1 hour)
   * @param {number} opts.maxEntries      - Max cache entries before eviction (default: 1000)
   * @param {boolean} opts.allowStale     - Whether to return stale entries as fallback (default: true)
   */
  constructor(opts = {}) {
    this.defaultTTL = opts.defaultTTL ?? 60 * 60 * 1000;        // 1 hour
    this.maxEntries = opts.maxEntries ?? 1000;
    this.allowStale = opts.allowStale ?? true;
    /** @type {Map<string, {data: any, fetchedAt: number, ttl: number, hits: number}>} */
    this._store = new Map();
    this._hitCount = 0;
    this._missCount = 0;
  }

  /**
   * Generate a cache key from URL and options.
   */
  static key(url, params = {}) {
    const sorted = Object.keys(params).sort().map(k => `${k}=${params[k]}`).join('&');
    return sorted ? `${url}?${sorted}` : url;
  }

  /**
   * Get a cached response. Returns { data, stale } or null.
   */
  get(key) {
    const entry = this._store.get(key);
    if (!entry) {
      this._missCount++;
      return null;
    }

    const age = Date.now() - entry.fetchedAt;
    const fresh = age < entry.ttl;

    if (fresh) {
      entry.hits++;
      this._hitCount++;
      return { data: entry.data, stale: false, age };
    }

    // Entry is stale
    if (this.allowStale) {
      entry.hits++;
      this._hitCount++;
      return { data: entry.data, stale: true, age };
    }

    // TTL expired and stale not allowed — evict
    this._store.delete(key);
    this._missCount++;
    return null;
  }

  /**
   * Get only fresh (non-stale) cached data, or null.
   */
  getFresh(key) {
    const result = this.get(key);
    if (result && !result.stale) return result.data;
    return null;
  }

  /**
   * Store a response in cache.
   * @param {string} key
   * @param {any} data
   * @param {number} [ttl] - TTL in ms, defaults to this.defaultTTL
   */
  set(key, data, ttl) {
    // Evict oldest entries if at capacity
    if (this._store.size >= this.maxEntries) {
      this._evictOldest(Math.ceil(this.maxEntries * 0.1));
    }

    this._store.set(key, {
      data,
      fetchedAt: Date.now(),
      ttl: ttl ?? this.defaultTTL,
      hits: 0,
    });
  }

  /**
   * Explicitly invalidate a cache entry.
   */
  invalidate(key) {
    return this._store.delete(key);
  }

  /**
   * Invalidate all entries matching a prefix.
   */
  invalidatePrefix(prefix) {
    let count = 0;
    for (const key of this._store.keys()) {
      if (key.startsWith(prefix)) {
        this._store.delete(key);
        count++;
      }
    }
    return count;
  }

  /**
   * Clear the entire cache.
   */
  clear() {
    this._store.clear();
  }

  _evictOldest(count) {
    const entries = [...this._store.entries()]
      .sort((a, b) => a[1].fetchedAt - b[1].fetchedAt);
    for (let i = 0; i < Math.min(count, entries.length); i++) {
      this._store.delete(entries[i][0]);
    }
  }

  get stats() {
    let staleCount = 0;
    const now = Date.now();
    for (const entry of this._store.values()) {
      if (now - entry.fetchedAt >= entry.ttl) staleCount++;
    }
    return {
      entries: this._store.size,
      stale: staleCount,
      fresh: this._store.size - staleCount,
      hits: this._hitCount,
      misses: this._missCount,
      hitRate: this._hitCount + this._missCount > 0
        ? ((this._hitCount / (this._hitCount + this._missCount)) * 100).toFixed(1) + '%'
        : 'N/A',
    };
  }
}

// ─── TTL Presets ─────────────────────────────────────────

export const CacheTTL = Object.freeze({
  INTRADAY: 60 * 60 * 1000,            // 1 hour
  DAILY: 24 * 60 * 60 * 1000,          // 24 hours
  WEEKLY: 7 * 24 * 60 * 60 * 1000,     // 7 days
  REALTIME: 30 * 1000,                 // 30 seconds
  NONE: 0,                             // No caching
});

// ─── Circuit Breaker ────────────────────────────────────

/**
 * Circuit breaker pattern for external API calls.
 *
 * States:
 *   CLOSED  — normal operation, requests go through
 *   OPEN    — failures exceeded threshold, requests rejected immediately
 *   HALF_OPEN — after cooldown, allow one probe request
 */
export class CircuitBreaker {
  /**
   * @param {object} opts
   * @param {number} opts.failureThreshold  - Failures before opening (default: 5)
   * @param {number} opts.cooldownMs        - Time in OPEN before trying HALF_OPEN (default: 60s)
   * @param {number} opts.successThreshold  - Successes in HALF_OPEN to close (default: 2)
   * @param {number} opts.timeoutMs         - Request timeout (default: 30s)
   */
  constructor(opts = {}) {
    this.failureThreshold = opts.failureThreshold ?? 5;
    this.cooldownMs = opts.cooldownMs ?? 60_000;
    this.successThreshold = opts.successThreshold ?? 2;
    this.timeoutMs = opts.timeoutMs ?? 30_000;

    this._state = 'CLOSED';
    this._failureCount = 0;
    this._successCount = 0;
    this._lastFailureTime = 0;
    this._totalFailures = 0;
    this._totalSuccesses = 0;
  }

  get state() {
    if (this._state === 'OPEN') {
      // Check if cooldown has elapsed -> transition to HALF_OPEN
      if (Date.now() - this._lastFailureTime >= this.cooldownMs) {
        this._state = 'HALF_OPEN';
        this._successCount = 0;
      }
    }
    return this._state;
  }

  /**
   * Execute a function through the circuit breaker.
   * @param {() => Promise<T>} fn - The async function to execute
   * @returns {Promise<T>}
   */
  async execute(fn) {
    const state = this.state;

    if (state === 'OPEN') {
      const waitMs = this.cooldownMs - (Date.now() - this._lastFailureTime);
      throw new CircuitBreakerOpenError(
        `Circuit breaker OPEN — too many failures. Retry in ${Math.ceil(waitMs / 1000)}s`,
        waitMs
      );
    }

    try {
      const result = await Promise.race([
        fn(),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error(`Request timed out after ${this.timeoutMs}ms`)), this.timeoutMs)
        ),
      ]);
      this._onSuccess();
      return result;
    } catch (err) {
      this._onFailure();
      throw err;
    }
  }

  _onSuccess() {
    this._totalSuccesses++;
    if (this._state === 'HALF_OPEN') {
      this._successCount++;
      if (this._successCount >= this.successThreshold) {
        this._state = 'CLOSED';
        this._failureCount = 0;
      }
    } else {
      this._failureCount = 0;
    }
  }

  _onFailure() {
    this._totalFailures++;
    this._failureCount++;
    this._lastFailureTime = Date.now();

    if (this._failureCount >= this.failureThreshold) {
      this._state = 'OPEN';
    } else if (this._state === 'HALF_OPEN') {
      // Any failure in HALF_OPEN reopens the circuit
      this._state = 'OPEN';
    }
  }

  /**
   * Manually reset the circuit breaker to CLOSED.
   */
  reset() {
    this._state = 'CLOSED';
    this._failureCount = 0;
    this._successCount = 0;
  }

  get stats() {
    return {
      state: this.state,
      failureCount: this._failureCount,
      totalFailures: this._totalFailures,
      totalSuccesses: this._totalSuccesses,
    };
  }
}

export class CircuitBreakerOpenError extends Error {
  constructor(message, retryAfterMs) {
    super(message);
    this.name = 'CircuitBreakerOpenError';
    this.retryAfterMs = retryAfterMs;
  }
}

// ─── Rate-Limited Request Queue ─────────────────────────

/**
 * Rate-limited API client with priority queue, retry, caching, and circuit breaker.
 */
export class RateLimitedClient {
  /**
   * @param {object} opts
   * @param {number}  opts.requestsPerMinute  - Max requests per minute (default: 5 for AV free tier)
   * @param {number}  opts.maxRetries         - Max retry attempts (default: 3)
   * @param {number}  opts.baseRetryMs        - Base retry delay in ms (default: 2000)
   * @param {number}  opts.maxRetryMs         - Max retry delay in ms (default: 60000)
   * @param {number}  opts.timeoutMs          - Request timeout in ms (default: 30000)
   * @param {ResponseCache} opts.cache        - Cache instance (default: new ResponseCache)
   * @param {CircuitBreaker} opts.circuitBreaker - Circuit breaker (default: new CircuitBreaker)
   */
  constructor(opts = {}) {
    this.requestsPerMinute = opts.requestsPerMinute ?? 5;
    this.maxRetries = opts.maxRetries ?? 3;
    this.baseRetryMs = opts.baseRetryMs ?? 2000;
    this.maxRetryMs = opts.maxRetryMs ?? 60_000;
    this.timeoutMs = opts.timeoutMs ?? 30_000;

    this.cache = opts.cache ?? new ResponseCache();
    this.circuitBreaker = opts.circuitBreaker ?? new CircuitBreaker({ timeoutMs: this.timeoutMs });

    // Rate limiting state
    this._requestTimes = [];   // timestamps of recent requests
    this._queue = [];          // pending requests sorted by priority
    this._processing = false;
    this._totalRequests = 0;
    this._totalErrors = 0;

    // Interval between requests to stay under the rate limit
    this._minIntervalMs = Math.ceil(60_000 / this.requestsPerMinute);
  }

  /**
   * Make a rate-limited API request with caching and retry.
   *
   * @param {string} url - The URL to fetch
   * @param {object} [opts]
   * @param {number}  opts.priority    - Priority.LIVE | BACKTEST | RESEARCH (default: RESEARCH)
   * @param {number}  opts.cacheTTL    - Cache TTL in ms (default: cache's defaultTTL)
   * @param {string}  opts.cacheKey    - Custom cache key (default: derived from URL)
   * @param {object}  opts.fetchOpts   - Options passed to fetch()
   * @param {boolean} opts.skipCache   - Skip cache lookup (default: false)
   * @param {Function} opts.transform  - Transform response before caching (default: res => res.json())
   * @param {Function} opts.fallback   - Fallback function if all else fails: () => data
   * @returns {Promise<{data: any, source: string, stale: boolean}>}
   */
  request(url, opts = {}) {
    const priority = opts.priority ?? Priority.RESEARCH;
    const cacheKey = opts.cacheKey ?? url;
    const cacheTTL = opts.cacheTTL;
    const skipCache = opts.skipCache ?? false;
    const transform = opts.transform ?? (res => res.json());
    const fallback = opts.fallback ?? null;
    const fetchOpts = opts.fetchOpts ?? {};

    // Check fresh cache first (synchronous fast path)
    if (!skipCache) {
      const cached = this.cache.get(cacheKey);
      if (cached && !cached.stale) {
        return Promise.resolve({ data: cached.data, source: 'cache', stale: false });
      }
    }

    // Enqueue the request
    return new Promise((resolve, reject) => {
      this._queue.push({
        url,
        priority,
        cacheKey,
        cacheTTL,
        skipCache,
        transform,
        fallback,
        fetchOpts,
        resolve,
        reject,
        retries: 0,
        enqueuedAt: Date.now(),
      });

      // Sort queue by priority (lower number = higher priority), then by enqueue time
      this._queue.sort((a, b) => a.priority - b.priority || a.enqueuedAt - b.enqueuedAt);

      this._processQueue();
    });
  }

  async _processQueue() {
    if (this._processing || this._queue.length === 0) return;
    this._processing = true;

    while (this._queue.length > 0) {
      // Wait for rate limit window
      await this._waitForRateLimit();

      const item = this._queue.shift();
      if (!item) break;

      try {
        const result = await this._executeRequest(item);
        item.resolve(result);
      } catch (err) {
        // On failure, check if we should retry
        if (item.retries < this.maxRetries && this._isRetryable(err)) {
          item.retries++;
          const delay = this._retryDelay(item.retries);
          console.warn(
            `  [api-client] Retry ${item.retries}/${this.maxRetries} for ${item.url} in ${delay}ms: ${err.message}`
          );
          await this._sleep(delay);
          // Re-enqueue with same priority
          this._queue.push(item);
          this._queue.sort((a, b) => a.priority - b.priority || a.enqueuedAt - b.enqueuedAt);
        } else {
          // Exhausted retries — try fallback chain
          const fallbackResult = await this._tryFallback(item, err);
          if (fallbackResult) {
            item.resolve(fallbackResult);
          } else {
            item.reject(err);
          }
        }
      }
    }

    this._processing = false;
  }

  async _executeRequest(item) {
    this._totalRequests++;

    const result = await this.circuitBreaker.execute(async () => {
      const res = await fetch(item.url, {
        ...item.fetchOpts,
        signal: AbortSignal.timeout(this.timeoutMs),
      });

      if (!res.ok) {
        const body = await res.text().catch(() => '');
        throw new ApiError(`HTTP ${res.status}: ${body}`, res.status);
      }

      const data = await item.transform(res);

      // Check for Alpha Vantage-style rate limit messages embedded in response body
      if (data && typeof data === 'object') {
        if (data['Note'] && /call frequency/i.test(data['Note'])) {
          throw new RateLimitError(`API rate limit: ${data['Note']}`);
        }
        if (data['Information'] && /rate limit/i.test(data['Information'])) {
          throw new RateLimitError(`API rate limit: ${data['Information']}`);
        }
      }

      return data;
    });

    // Record the request timestamp for rate limiting
    this._requestTimes.push(Date.now());

    // Cache the result
    if (!item.skipCache) {
      this.cache.set(item.cacheKey, result, item.cacheTTL);
    }

    return { data: result, source: 'api', stale: false };
  }

  async _tryFallback(item, originalError) {
    this._totalErrors++;

    // Fallback 1: Return stale cache if available
    if (!item.skipCache) {
      const stale = this.cache.get(item.cacheKey);
      if (stale) {
        console.warn(
          `  [api-client] Using stale cache for ${item.cacheKey} (age: ${Math.round(stale.age / 60000)}min): ${originalError.message}`
        );
        return { data: stale.data, source: 'cache-stale', stale: true };
      }
    }

    // Fallback 2: User-provided fallback function
    if (item.fallback) {
      try {
        console.warn(
          `  [api-client] Using fallback for ${item.cacheKey}: ${originalError.message}`
        );
        const data = await item.fallback();
        return { data, source: 'fallback', stale: false };
      } catch (fallbackErr) {
        console.error(`  [api-client] Fallback also failed: ${fallbackErr.message}`);
      }
    }

    return null;
  }

  async _waitForRateLimit() {
    // Clean old timestamps outside the 1-minute window
    const windowStart = Date.now() - 60_000;
    this._requestTimes = this._requestTimes.filter(t => t > windowStart);

    if (this._requestTimes.length >= this.requestsPerMinute) {
      // Calculate how long to wait until the oldest request in the window expires
      const oldestInWindow = this._requestTimes[0];
      const waitMs = oldestInWindow + 60_000 - Date.now() + 100; // +100ms buffer
      if (waitMs > 0) {
        console.log(`  [api-client] Rate limit: waiting ${Math.ceil(waitMs / 1000)}s (${this._requestTimes.length}/${this.requestsPerMinute} requests in window)`);
        await this._sleep(waitMs);
      }
    } else if (this._requestTimes.length > 0) {
      // Ensure minimum interval between consecutive requests
      const lastRequest = this._requestTimes[this._requestTimes.length - 1];
      const elapsed = Date.now() - lastRequest;
      if (elapsed < this._minIntervalMs) {
        await this._sleep(this._minIntervalMs - elapsed);
      }
    }
  }

  _retryDelay(attempt) {
    // Exponential backoff with jitter: base * 2^attempt + random jitter
    const exponential = this.baseRetryMs * Math.pow(2, attempt - 1);
    const jitter = Math.random() * this.baseRetryMs * 0.5;
    return Math.min(exponential + jitter, this.maxRetryMs);
  }

  _isRetryable(err) {
    // Don't retry circuit breaker open errors
    if (err instanceof CircuitBreakerOpenError) return false;

    // Retry rate limit errors
    if (err instanceof RateLimitError) return true;

    // Retry 5xx server errors and network errors
    if (err instanceof ApiError) {
      return err.status >= 500 || err.status === 429;
    }

    // Retry network/timeout errors
    if (err.name === 'AbortError' || err.name === 'TimeoutError') return true;
    if (err.code === 'ECONNRESET' || err.code === 'ECONNREFUSED' || err.code === 'ETIMEDOUT') return true;
    if (err.message?.includes('fetch failed') || err.message?.includes('network')) return true;

    return false;
  }

  _sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * Drain the queue, rejecting all pending requests.
   */
  drain() {
    while (this._queue.length > 0) {
      const item = this._queue.shift();
      item.reject(new Error('Client drained'));
    }
  }

  get stats() {
    return {
      queueLength: this._queue.length,
      totalRequests: this._totalRequests,
      totalErrors: this._totalErrors,
      errorRate: this._totalRequests > 0
        ? ((this._totalErrors / this._totalRequests) * 100).toFixed(1) + '%'
        : 'N/A',
      cache: this.cache.stats,
      circuitBreaker: this.circuitBreaker.stats,
      rateLimit: {
        requestsPerMinute: this.requestsPerMinute,
        requestsInWindow: this._requestTimes.filter(t => t > Date.now() - 60_000).length,
      },
    };
  }
}

// ─── Error Types ────────────────────────────────────────

export class ApiError extends Error {
  constructor(message, status) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}

export class RateLimitError extends Error {
  constructor(message) {
    super(message);
    this.name = 'RateLimitError';
  }
}

// ─── Default Singleton ──────────────────────────────────

/**
 * Default API client configured for Alpha Vantage free tier.
 * Shared across the application to enforce global rate limits.
 */
export const apiClient = new RateLimitedClient({
  requestsPerMinute: 5,
  maxRetries: 3,
  baseRetryMs: 2000,
  timeoutMs: 30_000,
  cache: new ResponseCache({
    defaultTTL: CacheTTL.DAILY,
    maxEntries: 500,
    allowStale: true,
  }),
});

// ─── Convenience: createClient for other APIs ───────────

/**
 * Create a rate-limited client for a specific API.
 *
 * @param {object} opts - Same as RateLimitedClient constructor options
 * @returns {RateLimitedClient}
 *
 * @example
 *   const coinGeckoClient = createClient({ requestsPerMinute: 10, timeoutMs: 15000 });
 */
export function createClient(opts) {
  return new RateLimitedClient(opts);
}
