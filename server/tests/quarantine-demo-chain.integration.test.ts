import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import Database from 'better-sqlite3'

const SCRIPT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../scripts/quarantine_demo_chain.py')
const DEMO_NAME = '朝阳万国城MOMΛ'

function sha256(file: string): string {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')
}

function run(args: string[]) {
  return spawnSync('python3', [SCRIPT, ...args], { encoding: 'utf8' })
}

function createFixture(root: string): string {
  const dbPath = path.join(root, 'shadow.db')
  const db = new Database(dbPath)
  db.pragma('foreign_keys = ON')
  db.exec(`
    CREATE TABLE projects (id INTEGER PRIMARY KEY, name TEXT NOT NULL);
    CREATE TABLE forecast_workflow_versions (id INTEGER PRIMARY KEY, project_id INTEGER, project_name TEXT);
    CREATE TABLE project_forecasts (id INTEGER PRIMARY KEY, project_id INTEGER, project_name TEXT);
    CREATE TABLE project_monthly_snapshots (id INTEGER PRIMARY KEY, project_id INTEGER, project_name TEXT);
    CREATE TABLE project_id_aliases (id INTEGER PRIMARY KEY, current_project_id INTEGER, project_name TEXT);
    CREATE TABLE weekly_meetings (id INTEGER PRIMARY KEY, title TEXT);
    CREATE TABLE weekly_meeting_items (id INTEGER PRIMARY KEY, meeting_id INTEGER, project_id INTEGER, project_name TEXT);
    CREATE TABLE management_tasks (id INTEGER PRIMARY KEY, project_id INTEGER, project_name TEXT, source_type TEXT, action TEXT, source_id TEXT);
    CREATE TABLE report_archives (id INTEGER PRIMARY KEY, payload TEXT);
    CREATE TABLE formal_output_archives (id INTEGER PRIMARY KEY, files_json TEXT);
    CREATE TABLE project_backups (id INTEGER PRIMARY KEY, payload TEXT);
    CREATE TABLE import_previews (id INTEGER PRIMARY KEY, payload TEXT);
    CREATE TABLE project_profiles (id INTEGER PRIMARY KEY, service_center TEXT);
    CREATE TABLE project_phase_profiles (id INTEGER PRIMARY KEY, profile_id INTEGER);
    CREATE TABLE project_profile_import_batches (id INTEGER PRIMARY KEY, source_sha256 TEXT);
    CREATE TABLE project_profile_center_links (id INTEGER PRIMARY KEY, profile_id INTEGER, source_center TEXT);
    CREATE TABLE data_ingestion_batches (id INTEGER PRIMARY KEY, status TEXT);
    CREATE TABLE data_ingestion_rows (id INTEGER PRIMARY KEY, batch_id INTEGER);
    CREATE TABLE operation_logs (id INTEGER PRIMARY KEY, action TEXT);
    CREATE TABLE data_quarantine (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      batch_key TEXT NOT NULL,
      source_table TEXT NOT NULL,
      source_id TEXT NOT NULL,
      record_json TEXT NOT NULL,
      reason TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'quarantined',
      quarantined_by TEXT NOT NULL,
      quarantined_at TEXT NOT NULL,
      restored_by TEXT DEFAULT '',
      restored_at TEXT DEFAULT '',
      UNIQUE(batch_key, source_table, source_id)
    );
  `)
  db.prepare('INSERT INTO projects VALUES (?,?)').run(1, DEMO_NAME)
  db.prepare('INSERT INTO projects VALUES (?,?)').run(2, '真实项目保留样例')
  for (const table of ['forecast_workflow_versions', 'project_forecasts', 'project_monthly_snapshots']) {
    db.prepare(`INSERT INTO ${table} VALUES (?,?,?)`).run(1, 1, DEMO_NAME)
    db.prepare(`INSERT INTO ${table} VALUES (?,?,?)`).run(2, 2, '真实项目保留样例')
  }
  db.prepare('INSERT INTO project_id_aliases VALUES (?,?,?)').run(1, 1, DEMO_NAME)
  db.prepare('INSERT INTO weekly_meetings VALUES (?,?)').run(1, '混合会议必须保留外壳')
  db.prepare('INSERT INTO weekly_meeting_items VALUES (?,?,?,?)').run(1, 1, 1, DEMO_NAME)
  db.prepare('INSERT INTO weekly_meeting_items VALUES (?,?,?,?)').run(2, 1, 2, '真实项目保留样例')
  db.prepare('INSERT INTO management_tasks VALUES (?,?,?,?,?,?)').run(1, 1, DEMO_NAME, 'alert', '演示任务', 'demo')
  db.prepare('INSERT INTO management_tasks VALUES (?,?,?,?,?,?)').run(2, 2, '真实项目保留样例', 'manual', '真实任务', 'real')
  db.prepare('INSERT INTO report_archives VALUES (?,?)').run(1, JSON.stringify({ project: DEMO_NAME }))
  db.prepare('INSERT INTO project_backups VALUES (?,?)').run(1, JSON.stringify([{ name: DEMO_NAME }]))
  db.prepare('INSERT INTO import_previews VALUES (?,?)').run(1, JSON.stringify([{ name: DEMO_NAME }]))
  db.prepare('INSERT INTO project_profiles VALUES (?,?)').run(1, '第一服务真实档案')
  db.prepare('INSERT INTO project_phase_profiles VALUES (?,?)').run(1, 1)
  db.prepare('INSERT INTO project_profile_import_batches VALUES (?,?)').run(1, 'a'.repeat(64))
  db.prepare('INSERT INTO project_profile_center_links VALUES (?,?,?)').run(1, 1, '真实中心')
  db.prepare('INSERT INTO data_ingestion_batches VALUES (?,?)').run(1, 'published')
  db.prepare('INSERT INTO data_ingestion_rows VALUES (?,?)').run(1, 1)
  db.prepare('INSERT INTO operation_logs VALUES (?,?)').run(1, '真实审计日志')
  db.close()
  return dbPath
}

test('quarantine dry-run is read-only and emits exact target and retained manifests', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cockpit-quarantine-dry-'))
  try {
    const dbPath = createFixture(root)
    const before = sha256(dbPath)
    const result = run(['--db', dbPath])
    assert.equal(result.status, 0, result.stderr)
    const report = JSON.parse(result.stdout)
    assert.equal(report.mode, 'dry-run')
    assert.equal(report.database_sha256, before)
    assert.equal(report.targets.projects.count, 1)
    assert.deepEqual(report.targets.projects.source_ids, ['1'])
    assert.equal(report.retained_before.projects.count, 1)
    assert.equal(report.retained_before.management_tasks.count, 1)
    assert.equal(report.apply_requirements.production_authorization_required, true)
    assert.equal(sha256(dbPath), before)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('apply refuses missing or mismatched SHA/backup before changing the database', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cockpit-quarantine-refuse-'))
  try {
    const dbPath = createFixture(root)
    const before = sha256(dbPath)
    const missing = run(['--db', dbPath, '--apply'])
    assert.notEqual(missing.status, 0)
    assert.match(missing.stderr, /expected-db-sha256/)
    const mismatch = run(['--db', dbPath, '--apply', '--expected-db-sha256', '0'.repeat(64), '--backup', path.join(root, 'backup.db')])
    assert.notEqual(mismatch.status, 0)
    assert.equal(fs.existsSync(path.join(root, 'backup.db')), false)
    assert.equal(sha256(dbPath), before)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('shadow apply creates a verified backup, quarantines exact demo chain, and preserves real records', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cockpit-quarantine-apply-'))
  try {
    const dbPath = createFixture(root)
    const backupPath = path.join(root, 'backups', 'pre-quarantine.db')
    const result = run([
      '--db', dbPath,
      '--apply',
      '--expected-db-sha256', sha256(dbPath),
      '--backup', backupPath,
      '--batch', 'test-shadow-batch',
      '--operator', 'qa-test',
    ])
    assert.equal(result.status, 0, result.stderr)
    const report = JSON.parse(result.stdout)
    assert.equal(report.success, true)
    assert.equal(report.backup.sha256, sha256(backupPath))
    assert.equal(report.backup.verification.ok, true)
    assert.equal(report.backup.logical_match, true)
    assert.equal(report.backup.source_logical_sha256, report.backup.backup_logical_sha256)
    assert.equal(report.verification_after.ok, true)
    assert.ok(Object.values(report.retained_unchanged).every(Boolean))

    const db = new Database(dbPath, { readonly: true })
    const scalar = (sql: string, field = 'count') => (db.prepare(sql).get() as Record<string, unknown>)[field]
    assert.equal(scalar('SELECT COUNT(*) count FROM projects'), 1)
    assert.equal(scalar('SELECT name FROM projects', 'name'), '真实项目保留样例')
    assert.equal(scalar('SELECT COUNT(*) count FROM management_tasks'), 1)
    assert.equal(scalar('SELECT COUNT(*) count FROM weekly_meetings'), 1)
    assert.equal(scalar('SELECT COUNT(*) count FROM weekly_meeting_items'), 1)
    assert.equal(scalar("SELECT COUNT(*) count FROM data_quarantine WHERE batch_key='test-shadow-batch'"), 10)
    db.close()
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('retained-record trigger tampering aborts and rolls back the whole quarantine transaction', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cockpit-quarantine-trigger-'))
  try {
    const dbPath = createFixture(root)
    const setup = new Database(dbPath)
    setup.exec(`
      CREATE TRIGGER tamper_retained_project
      BEFORE DELETE ON projects
      WHEN OLD.id = 1
      BEGIN
        UPDATE projects SET name='被触发器篡改' WHERE id=2;
      END;
    `)
    setup.close()
    const backupPath = path.join(root, 'backups', 'pre-quarantine.db')
    const result = run([
      '--db', dbPath,
      '--apply',
      '--expected-db-sha256', sha256(dbPath),
      '--backup', backupPath,
      '--batch', 'trigger-rollback-batch',
      '--operator', 'qa-test',
    ])
    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /retained records changed unexpectedly/)

    const db = new Database(dbPath, { readonly: true })
    assert.deepEqual(
      db.prepare('SELECT id,name FROM projects ORDER BY id').all(),
      [{ id: 1, name: DEMO_NAME }, { id: 2, name: '真实项目保留样例' }],
    )
    assert.equal(
      (db.prepare("SELECT COUNT(*) count FROM data_quarantine WHERE batch_key='trigger-rollback-batch'").get() as { count: number }).count,
      0,
    )
    db.close()
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})
