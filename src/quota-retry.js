const DEFAULT_MAX_WAIT_MS = 6 * 60 * 60 * 1000
const DEFAULT_RESET_MARGIN_MS = 10_000
const EXHAUSTED_PERCENT = 99.9

function cancellableDelay(delayMs, signal) {
  if (signal?.aborted) return Promise.resolve(false)
  return new Promise(resolve => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve(true)
    }, delayMs)
    function onAbort() {
      clearTimeout(timer)
      resolve(false)
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

function shortResetDelay(usage, nowMs, maxWaitMs, resetMarginMs) {
  const delays = []
  for (const limit of usage?.rateLimits ?? []) {
    // The usage response also contains feature-specific and code-review limits.
    // A model request cannot identify those meters, so only the main Codex limit
    // is authoritative for recovery of an openai-codex model failure.
    if (limit?.id !== 'codex') continue
    for (const window of limit?.windows ?? []) {
      if (!Number.isFinite(window?.usedPercent) || window.usedPercent < EXHAUSTED_PERCENT) continue
      if (!Number.isFinite(window?.windowSeconds) || window.windowSeconds * 1_000 > maxWaitMs) continue
      if (!Number.isFinite(window?.resetsAt)) continue
      const delayMs = window.resetsAt * 1_000 - nowMs
      if (delayMs <= 0 || delayMs + resetMarginMs > maxWaitMs) continue
      delays.push(delayMs)
    }
  }
  return delays.length === 0 ? undefined : Math.min(...delays)
}

/**
 * Recover a Codex subscription RATE_LIMIT only when the backend confirms an
 * exhausted short quota window whose reset is close enough to wait out.
 *
 * The listener intentionally owns the wait instead of relying on generic LLM
 * retry metadata: `/wham/usage` already exposes the authoritative rolling
 * window reset used by the plugin's quota UI.
 */
export function createCodexQuotaRetryHandler({
  usageReader,
  provider = 'openai-codex',
  now = Date.now,
  wait = cancellableDelay,
  maxWaitMs = DEFAULT_MAX_WAIT_MS,
  resetMarginMs = DEFAULT_RESET_MARGIN_MS,
} = {}) {
  if (usageReader === undefined || typeof usageReader.read !== 'function') {
    throw new TypeError('quota retry requires a usage reader')
  }
  if (typeof now !== 'function' || typeof wait !== 'function') {
    throw new TypeError('quota retry requires clock and wait functions')
  }
  if (!Number.isFinite(maxWaitMs) || maxWaitMs <= 0
    || !Number.isFinite(resetMarginMs) || resetMarginMs < 0) {
    throw new TypeError('quota retry requires a positive wait cap and non-negative reset margin')
  }
  return async ({ provider: requestProvider, failure, signal }, next) => {
    if (requestProvider !== provider || failure?.code !== 'RATE_LIMIT') return next()
    if (signal?.aborted) return undefined

    let usage
    try {
      usage = await usageReader.read({ force: true, signal })
    } catch {
      if (signal?.aborted) return undefined
      return next()
    }
    if (signal?.aborted) return undefined

    const resetDelayMs = shortResetDelay(usage, now(), maxWaitMs, resetMarginMs)
    if (resetDelayMs === undefined) return next()
    if (!await wait(resetDelayMs + resetMarginMs, signal)) return undefined
    if (signal?.aborted) return undefined

    try {
      if (typeof usageReader.clearCache === 'function') await usageReader.clearCache()
      else await usageReader.clear?.()
    } catch {
      // Cache invalidation must not turn a completed quota wait into a new
      // terminal failure. The next forced usage read can repair stale UI state.
    }
    return { kind: 'retry' }
  }
}
