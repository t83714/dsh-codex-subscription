import assert from 'node:assert/strict'
import test from 'node:test'

import { createCodexQuotaRetryHandler as createHandler } from '../src/quota-retry.js'

const payload = ({
  provider = 'openai-codex',
  code = 'RATE_LIMIT',
  message,
  signal = new AbortController().signal,
} = {}) => ({ provider, failure: { code, ...(message === undefined ? {} : { message }) }, signal })

test('recoverable short Codex quota waits through reset then retries without delegating', async () => {
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

test('Codex native usage-limit message recovers across affected DSH classifiers', async () => {
  const nowMs = 1_000_000
  let reads = 0
  let waited = 0
  const handler = createHandler({
    now: () => nowMs,
    usageReader: {
      async read() {
        reads += 1
        return {
          rateLimits: [{
            id: 'codex',
            windows: [{
              usedPercent: 100,
              windowSeconds: 18_000,
              resetsAt: (nowMs + 60_000) / 1_000,
            }],
          }],
        }
      },
    },
    wait: async delayMs => {
      waited = delayMs
      return true
    },
  })

  const result = await handler(payload({
    code: 'PI_AI_ERROR',
    message: 'You have hit your ChatGPT usage limit (team plan). Try again in ~237 min.',
  }), async () => ({ kind: 'downstream' }))

  assert.deepEqual(result, { kind: 'retry' })
  assert.equal(reads, 1)
  assert.equal(waited, 70_000)
})

test('unrelated exhausted feature quotas do not park a model turn', async () => {
  const nowMs = 1_000_000
  let waited = false
  const handler = createHandler({
    now: () => nowMs,
    usageReader: {
      async read() {
        return {
          rateLimits: [{
            id: 'codex',
            windows: [{ usedPercent: 50, windowSeconds: 18_000, resetsAt: (nowMs + 60_000) / 1_000 }],
          }, {
            id: 'code_review',
            windows: [{ usedPercent: 100, windowSeconds: 3_600, resetsAt: (nowMs + 60_000) / 1_000 }],
          }],
        }
      },
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

test('weekly quota is never parked even when its reset happens within six hours', async () => {
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

test('short-window reset beyond the bounded wait falls through', async () => {
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

test('maximum wait includes the reset safety margin', async () => {
  const nowMs = 1_000_000
  const maxWaitMs = 60_000
  const waits = []
  const usageReader = resetDelayMs => ({
    async read() {
      return {
        rateLimits: [{
          id: 'codex',
          windows: [{
            usedPercent: 100,
            windowSeconds: 60,
            resetsAt: (nowMs + resetDelayMs) / 1_000,
          }],
        }],
      }
    },
  })
  const next = async () => ({ kind: 'downstream' })

  const beyond = createHandler({
    usageReader: usageReader(maxWaitMs - 5_000),
    now: () => nowMs,
    maxWaitMs,
    resetMarginMs: 10_000,
    wait: async delayMs => { waits.push(delayMs); return true },
  })
  assert.deepEqual(await beyond(payload(), next), { kind: 'downstream' })

  const boundary = createHandler({
    usageReader: usageReader(maxWaitMs - 10_000),
    now: () => nowMs,
    maxWaitMs,
    resetMarginMs: 10_000,
    wait: async delayMs => { waits.push(delayMs); return true },
  })
  assert.deepEqual(await boundary(payload(), next), { kind: 'retry' })
  assert.deepEqual(waits, [maxWaitMs])
})

test('non-Codex and non-rate-limit failures remain owned by downstream recovery', async () => {
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
  assert.deepEqual(await handler(payload({ code: 'PI_AI_ERROR', message: 'generic provider failure' }), next), { kind: 'downstream' })
  assert.deepEqual(await handler(payload({ code: 'PI_AI_ERROR', message: 'You have hit your ChatGPT usage limit, maybe.' }), next), { kind: 'downstream' })
  assert.equal(reads, 0)
  assert.equal(delegated, 4)
})

test('usage refresh failures preserve the original rate-limit failure path', async () => {
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

test('successful recovery clears only the volatile quota cache when available', async () => {
  const nowMs = 1_000_000
  const clears = []
  const handler = createHandler({
    now: () => nowMs,
    usageReader: {
      async read() {
        return {
          rateLimits: [{
            id: 'codex',
            windows: [{
              usedPercent: 100,
              windowSeconds: 18_000,
              resetsAt: (nowMs + 60_000) / 1_000,
            }],
          }],
        }
      },
      clearCache() { clears.push('cache') },
      clear() { clears.push('persistent') },
    },
    wait: async () => true,
  })

  assert.deepEqual(await handler(payload(), async () => undefined), { kind: 'retry' })
  assert.deepEqual(clears, ['cache'])
})

test('cache cleanup failures do not suppress retry after the completed wait', async () => {
  const nowMs = 1_000_000
  const handler = createHandler({
    now: () => nowMs,
    usageReader: {
      async read() {
        return {
          rateLimits: [{
            id: 'codex',
            windows: [{
              usedPercent: 100,
              windowSeconds: 18_000,
              resetsAt: (nowMs + 60_000) / 1_000,
            }],
          }],
        }
      },
      async clear() { throw new Error('state store unavailable') },
    },
    wait: async () => true,
  })

  assert.deepEqual(await handler(payload(), async () => undefined), { kind: 'retry' })
})

test('cancellation during a parked quota wait suppresses the retry', async () => {
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
