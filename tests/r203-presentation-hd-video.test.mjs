import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import test from 'node:test'

const payloadRoot = new URL('../production-overlays/cockpit-r203-presentation-hd-video-20260902-v1/payload/', import.meta.url)

function trackDimensions(buffer) {
  const dimensions = []
  let cursor = 0
  while ((cursor = buffer.indexOf('tkhd', cursor, 'ascii')) >= 0) {
    const version = buffer[cursor + 4]
    const widthOffset = version === 1 ? cursor + 92 : cursor + 80
    const heightOffset = widthOffset + 4
    if (heightOffset + 4 <= buffer.length) {
      const width = buffer.readUInt32BE(widthOffset) / 65536
      const height = buffer.readUInt32BE(heightOffset) / 65536
      if (width > 0 && height > 0) dimensions.push({ width, height })
    }
    cursor += 4
  }
  return dimensions.sort((a, b) => (b.width * b.height) - (a.width * a.height))[0]
}

test('R203 binds the immutable HD media overlay to the R202 entry', () => {
  const index = fs.readFileSync(new URL('index.html', payloadRoot))
  assert.equal(
    crypto.createHash('sha256').update(index).digest('hex'),
    '1ace150ccba5227cc48aeab0217dd53feda1f015534d43d8e43ba426a5620445'
  )
  assert.match(index.toString('utf8'), /aph2-r202-presentation-entry-20260902-v1\.js/)
})

test('R203 preserves the original APH and LvZai recording resolution in browser-compatible H.264 MP4', () => {
  const cases = [
    ['aph.mp4', 2940, 1912, 40_000_000],
    ['lvzai.mp4', 3840, 2160, 120_000_000],
  ]
  for (const [filename, width, height, minimumBytes] of cases) {
    const buffer = fs.readFileSync(new URL(`presentation/ai-competition/media/${filename}`, payloadRoot))
    assert.equal(buffer.subarray(4, 8).toString('ascii'), 'ftyp', filename)
    assert.ok(buffer.includes(Buffer.from('avc1')), `${filename} should contain H.264 video`)
    assert.ok(buffer.length > minimumBytes, `${filename} should retain high-quality source data`)
    assert.deepEqual(trackDimensions(buffer), { width, height }, filename)
  }
})

test('R203 keeps the R202 hard-navigation and login-return fix', () => {
  const entry = fs.readFileSync(new URL('aph2-r202-presentation-entry-20260902-v1.js', payloadRoot), 'utf8')
  const login = fs.readFileSync(new URL('aph2-r202-login-shell-presentation-20260902-v1.js', payloadRoot), 'utf8')
  assert.match(entry, /window\.location\.assign/)
  assert.match(login, /'\/presentation\/ai-competition'/)
})
