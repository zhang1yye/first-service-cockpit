import assert from 'node:assert/strict'
import test from 'node:test'
import { refineWithHermes } from '../src/hermes-client.js'

const input = {
  question: '测试回退',
  baseline: '规则答案62.83%。',
  context: { rate: 62.83 },
  history: [],
  knowledge: [],
}

test('Hermes adapter times out and fails closed', async () => {
  const fetchImpl: typeof fetch = async (_url, init) => await new Promise<Response>((_resolve, reject) => {
    const signal = init?.signal
    signal?.addEventListener('abort', () => {
      const error = new Error('aborted')
      error.name = 'AbortError'
      reject(error)
    }, { once: true })
  })
  const started = Date.now()
  const result = await refineWithHermes(input, {
    baseUrl: 'http://127.0.0.1:8650', apiKey: 'test-secret-key-123456', model: 'north-cockpit', timeoutMs: 10, fetchImpl,
  })
  assert.equal(result, null)
  assert.ok(Date.now() - started < 1000)
})

test('Hermes adapter rejects malformed JSON and fails closed', async () => {
  const fetchImpl: typeof fetch = async () => new Response('{not-json', { status: 200, headers: { 'content-type': 'application/json' } })
  const result = await refineWithHermes(input, {
    baseUrl: 'http://127.0.0.1:8650', apiKey: 'test-secret-key-123456', model: 'north-cockpit', fetchImpl,
  })
  assert.equal(result, null)
})

test('Hermes adapter ignores internal prompt rule numbers but not business quantities', async () => {
  const metaFetch: typeof fetch = async () => new Response(JSON.stringify({
    model: 'north-cockpit', choices: [{ message: { content: '按照规则第9条，现有知识不足。' } }],
  }), { status: 200 })
  const metaResult = await refineWithHermes(input, {
    baseUrl: 'http://127.0.0.1:8650', apiKey: 'test-secret-key-123456', model: 'north-cockpit', fetchImpl: metaFetch,
  })
  assert.match(metaResult?.text || '', /规则第9条/)

  const businessFetch: typeof fetch = async () => new Response(JSON.stringify({
    model: 'north-cockpit', choices: [{ message: { content: '存在9条欠费记录。' } }],
  }), { status: 200 })
  const businessResult = await refineWithHermes(input, {
    baseUrl: 'http://127.0.0.1:8650', apiKey: 'test-secret-key-123456', model: 'north-cockpit', fetchImpl: businessFetch,
  })
  assert.equal(businessResult, null)
})
