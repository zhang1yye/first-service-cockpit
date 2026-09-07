import { createRequire } from 'node:module'
import { parentPort, workerData } from 'node:worker_threads'
import {
  COMMUNICATION_SIGNAL_COLUMNS,
  LEDGER_SIGNAL_COLUMNS,
  matchArrearsColumn,
  normalizeArrearsHeader,
  type ArrearsColumnKey,
  type ArrearsWorkbookProfile,
} from './arrears-columns.js'

const require = createRequire(import.meta.url)
const XLSX = require('@e965/xlsx')
const dangerousKeys = new Set(['__proto__', 'prototype', 'constructor'])
const MAX_SHEETS = 10
const MAX_HEADER_SCAN_ROWS = 20

type Candidate = {
  sheetName: string
  sheetIndex: number
  headerRow: number
  score: number
  dataRows: number
  matrix: unknown[][]
  columns: Array<{ index: number; label: string; key: ArrearsColumnKey | null }>
}

function hasValue(value: unknown): boolean {
  return String(value ?? '').trim().length > 0
}

function profileCandidate(matrix: unknown[][], sheetName: string, sheetIndex: number, headerRow: number, profile: ArrearsWorkbookProfile): Candidate | null {
  const header = Array.isArray(matrix[headerRow]) ? matrix[headerRow] : []
  if (!header.length || header.length > 40) return null
  const columns: Candidate['columns'] = []
  const positions = new Map<ArrearsColumnKey, number[]>()
  header.forEach((value, index) => {
    const label = String(value ?? '').trim()
    if (!label) return
    const key = matchArrearsColumn(label)
    columns.push({ index, label, key })
    if (key) positions.set(key, [...(positions.get(key) || []), index])
  })
  if (!columns.length) return null
  const has = (key: ArrearsColumnKey) => positions.has(key)
  const identityReady = has('resource') || (has('building') && has('unit') && has('room'))
  const signalColumns = profile === 'ledger' ? LEDGER_SIGNAL_COLUMNS : COMMUNICATION_SIGNAL_COLUMNS
  const dataRows = matrix.slice(headerRow + 1).filter(row => Array.isArray(row) && columns.some(column => hasValue(row[column.index]))).length
  if (!dataRows) return null
  let score = Math.min(columns.length, 10)
  score += identityReady ? 12 : 0
  if (profile === 'communications') score += has('content') ? 12 : 0
  else score += has('amount') ? 6 : 0
  score += signalColumns.filter(has).length * 2
  score += columns.filter(column => column.key).length * 4
  score += ['customer', 'phone'].filter(key => has(key as ArrearsColumnKey)).length
  return { sheetName, sheetIndex, headerRow, score, dataRows, matrix, columns }
}

function candidateSummary(workbook: any): string {
  const values: string[] = []
  for (const sheetName of workbook.SheetNames.slice(0, 3)) {
    const matrix = XLSX.utils.sheet_to_json(workbook.Sheets[sheetName], { header: 1, defval: '', raw: false, blankrows: true }) as unknown[][]
    for (const row of matrix.slice(0, 8)) {
      for (const value of Array.isArray(row) ? row : []) {
        const label = String(value ?? '').trim()
        if (label && label.length <= 40 && !values.includes(label)) values.push(label)
        if (values.length >= 12) return values.join('、')
      }
    }
  }
  return values.join('、') || '未检测到非空列名'
}

function looksLikeStructuredResource(value: unknown): boolean {
  const identity = String(value ?? '').trim()
  const separators = identity.match(/[-_/]/g)?.length || 0
  return identity.length >= 4 && separators >= 2 && /[A-Za-z0-9]/.test(identity)
}

function parseProfileRows(workbook: any, profile: ArrearsWorkbookProfile, maxRows: number): Array<Record<string, unknown>> {
  const candidates: Candidate[] = []
  workbook.SheetNames.forEach((sheetName: string, sheetIndex: number) => {
    const matrix = XLSX.utils.sheet_to_json(workbook.Sheets[sheetName], { header: 1, defval: '', raw: false, blankrows: true }) as unknown[][]
    const scanRows = Math.min(MAX_HEADER_SCAN_ROWS, matrix.length)
    for (let headerRow = 0; headerRow < scanRows; headerRow++) {
      const candidate = profileCandidate(matrix, sheetName, sheetIndex, headerRow, profile)
      if (candidate) candidates.push(candidate)
    }
  })
  candidates.sort((left, right) => right.score - left.score || right.dataRows - left.dataRows || left.sheetIndex - right.sheetIndex || left.headerRow - right.headerRow)
  const selected = candidates[0]
  if (!selected) throw new Error(`${profile === 'ledger' ? '欠费台账' : '沟通记录'}没有可读取的数据行。检测到：${candidateSummary(workbook)}`)
  const bestBySheet = new Map<number, Candidate>()
  for (const candidate of candidates) if (!bestBySheet.has(candidate.sheetIndex)) bestBySheet.set(candidate.sheetIndex, candidate)
  const mergeable = [...bestBySheet.values()].filter(candidate => {
    const keys = new Set(candidate.columns.map(column => column.key).filter(Boolean))
    return keys.has('resource') && keys.has('amount')
  }).sort((left, right) => left.sheetIndex - right.sheetIndex)
  const selectedCandidates = profile === 'ledger' && mergeable.length > 1 ? mergeable : [selected]
  const rows: Array<Record<string, unknown>> = []
  for (const candidate of selectedCandidates) {
    const outputLabels = new Map<number, string>()
    const usedLabels = new Set<string>()
    for (const column of candidate.columns) {
      const safeBase = dangerousKeys.has(column.label) ? `列${column.index + 1}` : column.label
      let label = safeBase
      let suffix = 2
      while (usedLabels.has(normalizeArrearsHeader(label))) label = `${safeBase}_${suffix++}`
      usedLabels.add(normalizeArrearsHeader(label))
      outputLabels.set(column.index, label)
    }
    const identityColumns = candidate.columns.filter(column => column.key === 'resource')
    candidate.matrix.slice(candidate.headerRow + 1).forEach((rawRow, offset) => {
      if (!Array.isArray(rawRow) || !candidate.columns.some(column => hasValue(rawRow[column.index]))) return
      if (profile === 'ledger' && selectedCandidates.length > 1 && !identityColumns.some(column => looksLikeStructuredResource(rawRow[column.index]))) return
      if (rawRow.length > 40) throw new Error(`${candidate.sheetName}第${candidate.headerRow + offset + 2}行列数超过40列`)
      const clean: Record<string, unknown> = Object.create(null)
      clean.__sourceRow = rows.length + 2
      clean.__sourceSheet = candidate.sheetName
      clean.__sourceSheetRow = candidate.headerRow + offset + 2
      for (const column of candidate.columns) {
        const value = rawRow[column.index]
        if (String(value ?? '').length > 4000) throw new Error(`${candidate.sheetName}第${clean.__sourceSheetRow}行存在超过4000字的单元格`)
        const label = outputLabels.get(column.index) || `列${column.index + 1}`
        clean[label] = value == null || ['string', 'number', 'boolean'].includes(typeof value) ? value : String(value)
      }
      rows.push(clean)
    })
  }
  if (rows.length > maxRows) throw new Error(`数据行数超过${maxRows}行`)
  return rows
}

try {
  const buffer = Buffer.from(workerData.buffer)
  const originalName = String(workerData.originalName || 'upload')
  const maxRows = Number(workerData.maxRows || 0)
  const profile = String(workerData.profile || '') as ArrearsWorkbookProfile | ''
  let workbook
  if (/\.csv$/i.test(originalName)) {
    let csvText = ''
    try {
      csvText = new TextDecoder('utf-8', { fatal: true }).decode(buffer).replace(/^\uFEFF/, '')
    } catch {
      throw new Error('CSV必须使用UTF-8编码')
    }
    workbook = XLSX.read(csvText, { type: 'string', cellDates: false, raw: false })
  } else {
    workbook = XLSX.read(buffer, { type: 'buffer', cellDates: false, raw: false })
  }
  if (workbook.SheetNames.length > MAX_SHEETS) throw new Error(`工作表数量超过${MAX_SHEETS}个`)
  if (!workbook.SheetNames.length) throw new Error(`${originalName}没有可读取的工作表`)
  let rows: Array<Record<string, unknown>>
  if (profile === 'ledger' || profile === 'communications') {
    rows = parseProfileRows(workbook, profile, maxRows)
  } else {
    const sheetName = workbook.SheetNames[0]
    const parsed = XLSX.utils.sheet_to_json(workbook.Sheets[sheetName], { defval: '', raw: false }) as Array<Record<string, unknown>>
    if (parsed.length > maxRows) throw new Error(`数据行数超过${maxRows}行`)
    rows = parsed.map((row, index) => {
      const keys = Object.keys(row)
      if (keys.length > 40) throw new Error(`第${index + 2}行列数超过40列`)
      if (keys.some(key => dangerousKeys.has(key))) throw new Error(`第${index + 2}行包含禁止字段名`)
      const clean: Record<string, unknown> = Object.create(null)
      for (const key of keys) {
        const value = row[key]
        if (String(value ?? '').length > 4000) throw new Error(`第${index + 2}行存在超过4000字的单元格`)
        clean[key] = value == null || ['string', 'number', 'boolean'].includes(typeof value) ? value : String(value)
      }
      return clean
    })
  }
  parentPort?.postMessage({ ok: true, rows })
} catch (error: any) {
  parentPort?.postMessage({ ok: false, error: String(error?.message || '工作簿解析失败').slice(0, 500) })
}
