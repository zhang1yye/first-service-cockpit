import { parentPort, workerData } from 'node:worker_threads'
import mammoth from 'mammoth'
import { PDFParse } from 'pdf-parse'
import * as XLSX from 'xlsx'

const maxZipEntries = 2000
const maxZipExpandedBytes = 128 * 1024 * 1024
const maxZipCompressionRatio = 100
const maxPdfPages = 500

function textSummary(text = '') {
  const normalized = String(text).replace(/\s+/g, ' ').trim()
  return {
    text: normalized.slice(0, 12000),
    textPreview: normalized.slice(0, 600),
    wordCount: normalized ? normalized.length : 0
  }
}

function readUInt32(buffer, offset) {
  if (offset < 0 || offset + 4 > buffer.length) throw new Error('ZIP central directory 越界')
  return buffer.readUInt32LE(offset)
}

function preflightZip(buffer) {
  // EOCD 最多位于文件尾 65557 字节内；不展开任何 entry 就校验资源上界。
  const minimum = Math.max(0, buffer.length - 65_557)
  let eocd = -1
  for (let offset = buffer.length - 22; offset >= minimum; offset -= 1) {
    if (buffer.readUInt32LE(offset) === 0x06054b50) {
      eocd = offset
      break
    }
  }
  if (eocd < 0) throw new Error('Office 文档缺少可验证 ZIP central directory')
  const entryCount = buffer.readUInt16LE(eocd + 10)
  const centralSize = readUInt32(buffer, eocd + 12)
  const centralOffset = readUInt32(buffer, eocd + 16)
  if (entryCount <= 0 || entryCount > maxZipEntries || centralOffset + centralSize > eocd) {
    throw new Error('ZIP entry 数或 central directory 边界超限')
  }
  let offset = centralOffset
  let expanded = 0
  for (let index = 0; index < entryCount; index += 1) {
    if (readUInt32(buffer, offset) !== 0x02014b50) throw new Error('ZIP central directory 结构无效')
    const compressed = readUInt32(buffer, offset + 20)
    const uncompressed = readUInt32(buffer, offset + 24)
    const nameLength = buffer.readUInt16LE(offset + 28)
    const extraLength = buffer.readUInt16LE(offset + 30)
    const commentLength = buffer.readUInt16LE(offset + 32)
    expanded += uncompressed
    if (expanded > maxZipExpandedBytes) throw new Error('ZIP 总展开量超出 128MiB')
    if (uncompressed > 0 && compressed === 0) throw new Error('ZIP 条目压缩大小异常')
    if (compressed > 0 && uncompressed / compressed > maxZipCompressionRatio) throw new Error('ZIP 压缩比超出 100:1')
    offset += 46 + nameLength + extraLength + commentLength
    if (offset > centralOffset + centralSize) throw new Error('ZIP central directory 长度不一致')
  }
  if (offset !== centralOffset + centralSize) throw new Error('ZIP central directory 未精确消费')
}

function extractWorkbookText(buffer) {
  preflightZip(buffer)
  const workbook = XLSX.read(buffer, { type: 'buffer', cellDates: true, raw: false, dense: true })
  const sections = []
  for (const sheetName of workbook.SheetNames.slice(0, 6)) {
    const rows = XLSX.utils.sheet_to_json(workbook.Sheets[sheetName], { header: 1, raw: false, defval: '' })
    const lines = rows.slice(0, 160)
      .map(row => row.map(cell => String(cell ?? '').trim()).filter(Boolean).join(' | '))
      .filter(Boolean).slice(0, 80)
    if (lines.length) sections.push(`工作表 ${sheetName}: ${lines.join(' ; ')}`)
  }
  return sections.join(' \n ')
}

async function parseAttachment() {
  const name = String(workerData?.name || '').toLowerCase()
  const mime = String(workerData?.mimetype || '')
  const buffer = Buffer.from(workerData?.buffer || [])
  if (buffer.length > 20 * 1024 * 1024) throw new Error('附件超出 worker 20MiB 硬上限')
  if (name.endsWith('.csv') || name.endsWith('.tsv') || mime.startsWith('text/') || name.endsWith('.txt')) {
    return { ...textSummary(buffer.toString('utf8')), extractionStatus: '已解析', extractionType: name.endsWith('.txt') ? 'text' : 'table' }
  }
  if (name.endsWith('.xlsx') || name.endsWith('.xls')) {
    if (!name.endsWith('.xlsx')) throw new Error('旧版 XLS 不支持安全 ZIP 预检，请转换为 XLSX')
    const text = extractWorkbookText(buffer)
    return { ...textSummary(text), extractionStatus: text ? '已解析' : '解析失败', extractionType: 'excel' }
  }
  if (name.endsWith('.docx')) {
    preflightZip(buffer)
    const result = await mammoth.extractRawText({ buffer })
    return { ...textSummary(result.value), extractionStatus: result.value ? '已解析' : '解析失败', extractionType: 'docx' }
  }
  if (name.endsWith('.pdf') || mime === 'application/pdf') {
    const roughPages = (buffer.toString('latin1').match(/\/Type\s*\/Page\b/g) || []).length
    if (roughPages > maxPdfPages) throw new Error(`PDF 页数估算 ${roughPages} 超出 ${maxPdfPages} 页上限`)
    const parser = new PDFParse({ data: buffer })
    try {
      const result = await parser.getText({ lineEnforce: true, cellSeparator: ' | ', pageJoiner: '\n' })
      return { ...textSummary(result.text), extractionStatus: result.text ? '已解析' : '解析失败', extractionType: 'pdf' }
    } finally {
      await parser.destroy()
    }
  }
  return { ...textSummary(''), extractionStatus: '不支持', extractionType: 'unknown' }
}

parseAttachment()
  .then(result => parentPort.postMessage({ ok: true, result }))
  .catch(error => parentPort.postMessage({ ok: false, error: error.message || '附件解析失败' }))
