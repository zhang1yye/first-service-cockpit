import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { searchApprovedKnowledge } from '../src/knowledge-retriever.js'

function createKnowledgeDb(path: string) {
  const db = new Database(path)
  db.exec(`
    CREATE TABLE knowledge_documents (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      source_path TEXT NOT NULL,
      version TEXT NOT NULL,
      effective_date TEXT,
      approval_status TEXT NOT NULL,
      domain TEXT NOT NULL,
      category TEXT NOT NULL,
      confidentiality TEXT NOT NULL DEFAULT 'internal',
      content_hash TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE knowledge_chunks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      document_id TEXT NOT NULL,
      chunk_index INTEGER NOT NULL,
      section TEXT NOT NULL,
      page TEXT,
      content TEXT NOT NULL
    );
    CREATE VIRTUAL TABLE knowledge_chunks_fts USING fts5(content, section, content='knowledge_chunks', content_rowid='id', tokenize='trigram');
    CREATE TRIGGER knowledge_chunks_ai AFTER INSERT ON knowledge_chunks BEGIN
      INSERT INTO knowledge_chunks_fts(rowid, content, section) VALUES (new.id, new.content, new.section);
    END;
  `)
  const addDoc = db.prepare(`INSERT INTO knowledge_documents VALUES (@id,@title,@source_path,@version,@effective_date,@approval_status,@domain,@category,'internal',@content_hash,'2026-08-05T00:00:00Z')`)
  const addChunk = db.prepare(`INSERT INTO knowledge_chunks(document_id,chunk_index,section,page,content) VALUES (?,?,?,?,?)`)
  addDoc.run({ id: 'approved', title: '费用收缴专项方案', source_path: 'approved.md', version: '2026', effective_date: '2026-01-01', approval_status: 'approved', domain: 'north-operations', category: 'collection', content_hash: 'a' })
  addChunk.run('approved', 0, '催缴流程', '12', '物业费催缴应先核对欠费事实，再按服务标准完成沟通和留痕。')
  addDoc.run({ id: 'draft', title: '未审核催缴草案', source_path: 'draft.md', version: 'draft', effective_date: '2026-01-01', approval_status: 'draft', domain: 'north-operations', category: 'collection', content_hash: 'b' })
  addChunk.run('draft', 0, '激进催缴', null, '物业费催缴可以直接采取未经批准的激进动作。')
  addDoc.run({ id: 'engineering', title: '本源新筑工程催款案例', source_path: 'engineering.md', version: '2026', effective_date: '2026-01-01', approval_status: 'approved', domain: 'engineering', category: 'collection', content_hash: 'c' })
  addChunk.run('engineering', 0, '工程款催收', null, '物业费催缴工程施工结算利润率。')
  addDoc.run({ id: 'related-water', title: 'PM4-SS-52 第一服务景观水系统节能运行作业标准', source_path: 'water.md', version: '1.0', effective_date: '2026-01-01', approval_status: 'approved', domain: 'all', category: 'first-service-standard-ss', content_hash: 'd' })
  addChunk.run('related-water', 0, '运行要求', null, '水系统节能运行和维护保养应按照巡检要求执行。')
  addDoc.run({ id: 'pending-water', title: 'PM4-SS-70 第一服务中水系统节能运行作业标准', source_path: 'pending-water.md', version: '1.0', effective_date: '2026-01-01', approval_status: 'pending', domain: 'all', category: 'first-service-standard-ss', content_hash: 'e' })
  addChunk.run('pending-water', 0, '待审核正文', null, '中水系统节能运行和维护保养。')
  db.close()
}

test('knowledge retrieval returns approved in-domain citations only', () => {
  const dir = mkdtempSync(join(tmpdir(), 'north-kb-'))
  const path = join(dir, 'knowledge.db')
  try {
    createKnowledgeDb(path)
    const results = searchApprovedKnowledge('物业费催缴怎么做', { dbPath: path, domain: 'north-operations', asOf: '2026-08-05', limit: 5 })
    assert.equal(results.length, 1)
    assert.equal(results[0].documentId, 'approved')
    assert.equal(results[0].title, '费用收缴专项方案')
    assert.equal(results[0].section, '催缴流程')
    assert.equal(results[0].page, '12')
    assert.match(results[0].content, /核对欠费事实/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('missing knowledge database fails closed with no results', () => {
  const results = searchApprovedKnowledge('收缴率', { dbPath: '/tmp/does-not-exist-north-kb.db', domain: 'north-operations', asOf: '2026-08-05', limit: 5 })
  assert.deepEqual(results, [])
})

test('an explicitly requested pending standard code is not substituted with a related approved standard', () => {
  const dir = mkdtempSync(join(tmpdir(), 'north-kb-code-'))
  const path = join(dir, 'knowledge.db')
  try {
    createKnowledgeDb(path)
    const results = searchApprovedKnowledge('根据PM4-SS-70，中水系统节能运行怎么做？', { dbPath: path, domain: 'north-operations', asOf: '2026-08-05', limit: 5 })
    assert.deepEqual(results, [])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
