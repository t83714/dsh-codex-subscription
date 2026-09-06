import assert from 'node:assert/strict'
import test from 'node:test'

let createHandler
try {
  const module = await import('../src/quota-retry.js')
  createHandler = module.createCodexQuotaRetryHandler
} catch {
  createHandler = undefined
}

// Keep the RED phase as an assertion failure rather than an import error. Once
// the helper exists, the behavior cases below become active automatically.
test('quota-aware retry helper is part of the plugin runtime', () => {
  assert.equal(typeof createHandler, 'function')
})

const quotaTest = typeof createHandler === 'function' ? test : test.skip

const payload = ({
  provider = 'openai-codex',
  code = 'RATE_LIMIT',
  signal = new AbortController().signal,
} = {}) => ({ provider, failure: { code }, signal })

quotaTest('recoverable short Codex quota waits through reset then retries without delegating', async () => {
  const nowMs = 1_000_000
  const reads = []
  const waits = []
  let clears = 0
  let delegated = 0
  const signal = new AbortController().signal
  const usageReader = {
    async read(options) {
      reads.push(options)
      return {
        rateLimits: [{
          id: 'codex',
          windows: [{
            usedPercent: 100,
            remainingPercent: 0,
            windowSeconds: 18_000,
            resetsAt: (nowMs + 60_000) / 1_000,
          }],
        }],
      }
    },
    clear() { clears += 1 },
  }
  const handler = createHandler({
    usageReader,
    now: () => nowMs,
    wait: async (delayMs, waitSignal) => {
      waits.push({ delayMs, signal: waitSignal })
      return true
    },
  })

  const result = await handler(payload({ signal }), async () => {
    delegated += 1
    return { kind: 'downstream' }
  })

  assert.deepEqual(result, { kind: 'retry' })
  assert.deepEqual(reads, [{ force: true, signal }])
  assert.deepEqual(waits, [{ delayMs: 70_000, signal }])
  assert.equal(clears, 1)
  assert.equal(delegated, 0)
})

quotaTest('weekly quota is never parked even when its reset happens within six hours', async () => {
  const nowMs = 1_000_000
  let waited = false
  let delegated = 0
  const handler = createHandler({
    now: () => nowMs,
    usageReader: {
      async read() {
        return {
          rateLimits: [{
            id: 'codex',
            windows: [{
              usedPercent: 100,
              remainingPercent: 0,
              windowSeconds: 604_800,
              resetsAt: (nowMs + 60_000) / 1_000,
            }],
          }],
        }
      },
      clear() {},
    },
    wait: async () => {
      waited = true
      return true
    },
  })

  const result = await handler(payload(), async () => {
    delegated += 1
    return { kind: 'downstream' }
  })

  assert.deepEqual(result, { kind: 'downstream' })
  assert.equal(waited, false)
  assert.equal(delegated, 1)
})

quotaTest('short-window reset beyond the bounded wait falls through', async () => {
  const nowMs = 1_000_000
  let waited = false
  const handler = createHandler({
    now: () => nowMs,
    usageReader: {
      async read() {
        return {
          rateLimits: [{
            id: 'codex',
            windows: [{
              usedPercent: 100,
              remainingPercent: 0,
              windowSeconds: 18_000,
              resetsAt: (nowMs + 7 * 60 * 60 * 1_000) / 1_000,
            }],
          }],
        }
      },
      clear() {},
    },
    wait: async () => {
      waited = true
      return true
    },
  })

  const sentinel = { kind: 'downstream' }
  assert.equal(await handler(payload(), async () => sentinel), sentinel)
  assert.equal(waited, false)
})

quotaTest('non-Codex and non-rate-limit failures remain owned by downstream recovery', async () => {
  let reads = 0
  const handler = createHandler({
    usageReader: {
      async read() { reads += 1; return { rateLimits: [] } },
      clear() {},
    },
    wait: async () => true,
  })
  let delegated = 0
  const next = async () => {
    delegated += 1
    return { kind: 'downstream' }
  }

  assert.deepEqual(await handler(payload({ provider: 'other' }), next), { kind: 'downstream' })
  assert.deepEqual(await handler(payload({ code: 'AUTH_FAILED' }), next), { kind: 'downstream' })
  assert.equal(reads, 0)
  assert.equal(delegated, 2)
})

quotaTest('usage refresh failures preserve the original rate-limit failure path', async () => {
  const handler = createHandler({
    usageReader: {
      async read() { throw new Error('usage unavailable') },
      clear() {},
    },
    wait: async () => true,
  })
  const sentinel = { kind: 'downstream' }
  assert.equal(await handler(payload(), async () => sentinel), sentinel)
})

quotaTest('cancellation during a parked quota wait suppresses the retry', async () => {
  const nowMs = 1_000_000
  let delegated = 0
  let clears = 0
  const handler = createHandler({
    now: () => nowMs,
    usageReader: {
      async read() {
        return {
          rateLimits: [{
            id: 'codex',
            windows: [{
              usedPercent: 100,
              remainingPercent: 0,
              windowSeconds: 18_000,
              resetsAt: (nowMs + 60_000) / 1_000,
            }],
          }],
        }
      },
      clear() { clears += 1 },
    },
    wait: async () => false,
  })

  const result = await handler(payload(), async () => {
    delegated += 1
    return { kind: 'downstream' }
  })

  assert.equal(result, undefined)
  assert.equal(clears, 0)
  assert.equal(delegated, 0)
})
