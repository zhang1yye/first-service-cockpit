import Database from 'better-sqlite3'

export type KnowledgeExcerpt = {
  documentId: string
  title: string
  version: string
  section: string
  page: string | null
  content: string
  sourcePath: string
  category: string
}

export type KnowledgeSearchOptions = {
  dbPath: string
  domain: string
  asOf: string
  limit?: number
}

export function normalizeStandardCodeText(value: unknown): string {
  return String(value || '')
    .normalize('NFKC')
    .toUpperCase()
    .replace(/[‐‑‒–—―−﹘﹣－]/g, '-')
    .replace(/_{2,}/g, ' ')
    .replace(/_/g, '-')
    .replace(/\s*-\s*/g, '-')
}

/**
 * 同时覆盖 PM4-KF-01 三段码与 OA 源文件使用的 SYSTEM-2961 两段码。
 * 编码必须以字母开头，因此 2026-08-12 这类业务日期不会被识别为标准码。
 */
export function standardCodesIn(value: unknown): string[] {
  const normalized = normalizeStandardCodeText(value)
  const codes = [...normalized.matchAll(
    /(?<![A-Z0-9-])([A-Z][A-Z0-9]{1,15}(?:-[A-Z][A-Z0-9]{0,15})?-\d+)(?![A-Z0-9-])/g,
  )].map(match => match[1])
  for (const match of normalized.matchAll(/(?:OA|体系|SYSTEM)\s*(?:体系)?(?:编码|代码|CODE)\s*[:：]?\s*(\d{2,10})(?!\d)/g)) {
    codes.push(`SYSTEM-${match[1]}`)
  }
  return [...new Set(codes)]
}

function buildTrigramQuery(input: string): string | null {
  const normalized = normalizeStandardCodeText(input).trim().replace(/[\s，。！？、；：,.!?;:()（）\[\]【】]+/g, '')
  if (normalized.length < 3) return null
  const terms: string[] = []
  for (let index = 0; index <= normalized.length - 3 && terms.length < 24; index += 1) {
    const term = normalized.slice(index, index + 3).replace(/"/g, '""')
    if (!terms.includes(term)) terms.push(term)
  }
  return terms.length ? terms.map(term => `"${term}"`).join(' OR ') : null
}

export function searchApprovedKnowledge(query: string, options: KnowledgeSearchOptions): KnowledgeExcerpt[] {
  const requestedCode = standardCodesIn(query)[0]
  const match = buildTrigramQuery(query)
  if ((!match && !requestedCode) || !options.dbPath) return []
  let database: Database.Database | null = null
  try {
    database = new Database(options.dbPath, { readonly: true, fileMustExist: true })
    if (requestedCode) {
      const codeLike = `%${requestedCode}%`
      const rows = database.prepare(`
        SELECT
          d.id AS documentId,
          d.title,
          d.version,
          c.section,
          c.page,
          c.content,
          d.source_path AS sourcePath,
          d.category
        FROM knowledge_chunks c
        JOIN knowledge_documents d ON d.id = c.document_id
        WHERE d.approval_status = 'approved'
          AND (d.effective_date IS NULL OR d.effective_date <= ?)
          AND d.domain IN (?, 'all')
          AND c.section NOT IN ('主附件索引', '标准元数据')
          AND (
            UPPER(REPLACE(d.id, '_', '-')) LIKE ?
            OR UPPER(d.title) LIKE ?
            OR UPPER(REPLACE(d.source_path, '_', '-')) LIKE ?
            OR UPPER(d.category) LIKE ?
          )
        ORDER BY d.updated_at DESC, c.chunk_index
        LIMIT ?
      `).all(
        options.asOf,
        options.domain,
        codeLike,
        codeLike,
        codeLike,
        codeLike,
        Math.max(8, Math.min((options.limit || 5) * 8, 80)),
      ) as KnowledgeExcerpt[]
      // 精确编号只由文档身份字段认定；正文交叉引用不能冒充目标制度。
      return rows.filter(row => [row.documentId, row.title, row.sourcePath, row.category]
        .some(value => standardCodesIn(value).includes(requestedCode)))
        .slice(0, Math.max(1, Math.min(options.limit || 5, 10)))
    }
    const rows = database.prepare(`
      SELECT
        d.id AS documentId,
        d.title,
        d.version,
        c.section,
        c.page,
        c.content,
        d.source_path AS sourcePath,
        d.category
      FROM knowledge_chunks_fts
      JOIN knowledge_chunks c ON c.id = knowledge_chunks_fts.rowid
      JOIN knowledge_documents d ON d.id = c.document_id
      WHERE knowledge_chunks_fts MATCH ?
        AND d.approval_status = 'approved'
        AND (d.effective_date IS NULL OR d.effective_date <= ?)
        AND d.domain IN (?, 'all')
      ORDER BY bm25(knowledge_chunks_fts), d.updated_at DESC
      LIMIT ?
    `).all(
      match,
      options.asOf,
      options.domain,
      Math.max(1, Math.min(options.limit || 5, 10)),
    ) as KnowledgeExcerpt[]
    return rows
  } catch {
    return []
  } finally {
    database?.close()
  }
}
