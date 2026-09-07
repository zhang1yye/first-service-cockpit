import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const releaseName = 'cockpit-r200-ai-presentation-20260902-v1'
const payload = path.join(root, 'production-overlays', releaseName, 'payload')
const presentation = path.join(payload, 'presentation', 'ai-competition')

const read = (file) => fs.readFileSync(path.join(presentation, file), 'utf8')

test('R200 使用经现网核验的 R198 前端基线并只增加汇报资产', () => {
  const index = fs.readFileSync(path.join(payload, 'index.html'))
  assert.equal(
    crypto.createHash('sha256').update(index).digest('hex'),
    'f1be07ed0f078bbde0f188d408431c6338d771bb1f53f4f2cf0167718f79490a'
  )
})

test('R200 独立汇报页包含 12 页可访问幻灯片', () => {
  const html = read('index.html')
  const script = read('presentation.js')
  const style = read('presentation.css')

  assert.match(html, /presentation\.css/)
  assert.match(html, /presentation\.js/)
  assert.match(script, /TOTAL_SLIDES = 12/)
  assert.match(script, /ArrowRight/)
  assert.match(script, /requestFullscreen/)
  assert.match(style, /aspect-ratio:\s*16\s*\/\s*9/)

  for (let index = 1; index <= 12; index += 1) {
    const filename = `slides/slide-${String(index).padStart(2, '0')}.webp`
    const data = fs.readFileSync(path.join(presentation, filename))
    assert.equal(data.subarray(0, 4).toString('ascii'), 'RIFF', filename)
    assert.equal(data.subarray(8, 12).toString('ascii'), 'WEBP', filename)
    assert.ok(data.length > 20_000, filename)
  }
})

test('R200 第 4 页 APH 和绿仔均可点击全屏播放 H.264 MP4', () => {
  const html = read('index.html')
  const script = read('presentation.js')
  assert.match(html, /data-video="aph"/)
  assert.match(html, /data-video="lvzai"/)
  assert.match(script, /currentSlide !== 4/)
  assert.match(script, /videoPlayer\.play\(\)/)
  assert.match(script, /enterFullscreen\(videoOverlay\)/)

  for (const filename of ['media/aph.mp4', 'media/lvzai.mp4']) {
    const data = fs.readFileSync(path.join(presentation, filename))
    assert.equal(data.subarray(4, 8).toString('ascii'), 'ftyp', filename)
    assert.ok(data.length > 20_000_000, filename)
    assert.ok(data.includes(Buffer.from('avc1')), `${filename} should contain an H.264 avc1 track`)
  }
})

test('R200 汇报入口沿用驾驶舱登录凭据', () => {
  const script = read('presentation.js')
  assert.match(script, /cockpit_token/)
  assert.match(script, /authToken/)
  assert.match(script, /window\.location\.replace\(`\/login\?redirect=/)
})
