import Database from 'better-sqlite3'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import bcrypt from 'bcryptjs'
import fs from 'node:fs'
import os from 'node:os'
import crypto from 'node:crypto'
import { canUseDemoData } from './production-safety.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const DB_PATH = process.env.COCKPIT_DB_PATH || path.join(__dirname, '..', 'cockpit.db')

const db = new Database(DB_PATH)

// 启用 WAL 模式，提升并发读性能
db.pragma('journal_mode = WAL')
db.pragma('foreign_keys = ON')

// ─── 建表 ─────────────────────────────────────────────

db.exec(`
  CREATE TABLE IF NOT EXISTS payment_centers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    area TEXT NOT NULL,
    center TEXT NOT NULL,
    annual_budget REAL NOT NULL,
    cumulative_budget REAL NOT NULL,
    cumulative_executed REAL NOT NULL,
    same_period REAL,
    collection_rate REAL,
    version INTEGER NOT NULL DEFAULT 1,
    updated_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
  );

  CREATE TABLE IF NOT EXISTS daily_snapshots (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    date TEXT NOT NULL,
    center TEXT NOT NULL,
    annual_budget REAL,
    cumulative_budget REAL,
    cumulative_executed REAL,
    daily_collection REAL,
    quality_status TEXT NOT NULL DEFAULT 'unverified',
    quality_reason TEXT DEFAULT '',
    source TEXT DEFAULT '',
    source_status TEXT DEFAULT 'unverified',
    business_date TEXT,
    last_validated_at TEXT,
    field_provenance TEXT DEFAULT '{}',
    UNIQUE(date, center)
  );

  CREATE TABLE IF NOT EXISTS automation_principals (
    principal_id TEXT PRIMARY KEY,
    actor TEXT NOT NULL UNIQUE,
    purpose TEXT NOT NULL,
    active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0,1)),
    created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
    CHECK(principal_id='daily-reconciliation-automation'),
    CHECK(actor='daily-reconciliation-automation'),
    CHECK(purpose='daily-reconciliation')
  );

  CREATE TABLE IF NOT EXISTS daily_collection_reconciliations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    business_date TEXT NOT NULL,
    extracted_at TEXT NOT NULL,
    report_id TEXT NOT NULL,
    region TEXT NOT NULL,
    official_total REAL NOT NULL,
    detail_total REAL NOT NULL,
    source_row_count INTEGER NOT NULL,
    publication_mode TEXT NOT NULL DEFAULT 'snapshot_revision' CHECK(publication_mode IN ('snapshot_revision','daily_only')),
    payload_sha256 TEXT NOT NULL UNIQUE,
    business_payload_sha256 TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL,
    validation_errors TEXT NOT NULL DEFAULT '[]',
    supersedes_id INTEGER,
    created_by TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
    published_by TEXT NOT NULL DEFAULT '',
    published_at TEXT NOT NULL DEFAULT '',
    confirm_note TEXT NOT NULL DEFAULT '',
    zero_value_confirmed INTEGER NOT NULL DEFAULT 0 CHECK(zero_value_confirmed IN (0,1)),
    zero_value_confirm_note TEXT NOT NULL DEFAULT '',
    total_difference_confirmed INTEGER NOT NULL DEFAULT 0 CHECK(total_difference_confirmed IN (0,1)),
    total_difference_confirm_note TEXT NOT NULL DEFAULT '',
    FOREIGN KEY(supersedes_id) REFERENCES daily_collection_reconciliations(id)
  );

  CREATE TABLE IF NOT EXISTS daily_collection_revision_rows (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    reconciliation_id INTEGER NOT NULL,
    center TEXT NOT NULL,
    old_daily_collection REAL,
    new_daily_collection REAL NOT NULL,
    old_cumulative_budget REAL,
    old_cumulative_executed REAL,
    old_last_validated_at TEXT,
    old_field_provenance TEXT NOT NULL DEFAULT '{}',
    UNIQUE(reconciliation_id, center),
    FOREIGN KEY(reconciliation_id) REFERENCES daily_collection_reconciliations(id) ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS idx_daily_reconciliation_date_status
    ON daily_collection_reconciliations(business_date,status,id);

  CREATE TABLE IF NOT EXISTS collection_centers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    area TEXT NOT NULL,
    center TEXT NOT NULL,
    receivable REAL NOT NULL,
    received REAL NOT NULL,
    overdue30 REAL,
    overdue90 REAL
  );

  CREATE TABLE IF NOT EXISTS monthly_trends (
    month TEXT PRIMARY KEY,
    "华北汇总" REAL,
    "朝阳片区" REAL,
    "京东片区" REAL,
    "海淀片区" REAL,
    "顺平片区" REAL,
    "河北片区" REAL,
    "辽宁片区" REAL,
    quality_status TEXT NOT NULL DEFAULT 'unverified',
    quality_reason TEXT DEFAULT '',
    source TEXT DEFAULT '',
    source_status TEXT DEFAULT 'unverified',
    business_date TEXT,
    last_validated_at TEXT,
    field_provenance TEXT DEFAULT '{}'
  );

  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'viewer',
    area_scope TEXT DEFAULT '',
    project_scope TEXT DEFAULT '',
    service_center_scope TEXT DEFAULT '',
    token_version INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
  );

  CREATE TABLE IF NOT EXISTS projects (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    area TEXT NOT NULL,
    name TEXT NOT NULL,
    area_sqm REAL,
    units INTEGER,
    property_type TEXT,
    staff_count INTEGER,
    annual_income REAL,
    annual_cost REAL,
    ytd_income REAL,
    ytd_cost REAL,
    receivable REAL,
    received REAL,
    quality_score REAL,
    safety_incidents INTEGER,
    customer_satisfaction REAL,
    complaint_count INTEGER,
    updated_at TEXT DEFAULT (datetime('now','localtime'))
  );

  CREATE TABLE IF NOT EXISTS import_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    filename TEXT NOT NULL,
    rows_imported INTEGER DEFAULT 0,
    rows_skipped INTEGER DEFAULT 0,
    errors TEXT,
    imported_at TEXT DEFAULT (datetime('now','localtime'))
  );

  CREATE TABLE IF NOT EXISTS project_backups (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    source TEXT NOT NULL,
    row_count INTEGER DEFAULT 0,
    payload TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now','localtime'))
  );

  CREATE TABLE IF NOT EXISTS project_profile_import_batches (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    source_file TEXT NOT NULL,
    source_sha256 TEXT NOT NULL UNIQUE,
    source_sheet TEXT NOT NULL,
    filter_status TEXT NOT NULL,
    profile_count INTEGER NOT NULL,
    phase_count INTEGER NOT NULL,
    imported_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
  );

  CREATE TABLE IF NOT EXISTS project_profiles (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    batch_id INTEGER NOT NULL,
    service_center TEXT NOT NULL,
    region TEXT NOT NULL DEFAULT '华北',
    area TEXT NOT NULL DEFAULT '',
    company_entity TEXT NOT NULL DEFAULT '',
    management_status TEXT NOT NULL,
    phase_count INTEGER NOT NULL DEFAULT 0,
    property_type TEXT NOT NULL DEFAULT '',
    service_type TEXT NOT NULL DEFAULT '',
    project_source TEXT NOT NULL DEFAULT '',
    client_type TEXT NOT NULL DEFAULT '',
    province TEXT NOT NULL DEFAULT '',
    city TEXT NOT NULL DEFAULT '',
    address TEXT NOT NULL DEFAULT '',
    signed_area REAL NOT NULL DEFAULT 0,
    phase_signed_area REAL NOT NULL DEFAULT 0,
    managed_area REAL NOT NULL DEFAULT 0,
    pending_area REAL NOT NULL DEFAULT 0,
    signed_units INTEGER NOT NULL DEFAULT 0,
    movedin_units INTEGER NOT NULL DEFAULT 0,
    source_rows_json TEXT NOT NULL DEFAULT '[]',
    UNIQUE(batch_id, service_center),
    FOREIGN KEY(batch_id) REFERENCES project_profile_import_batches(id)
  );

  CREATE TABLE IF NOT EXISTS project_phase_profiles (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    batch_id INTEGER NOT NULL,
    profile_id INTEGER NOT NULL,
    source_row INTEGER NOT NULL,
    phase_name TEXT NOT NULL,
    management_status TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    UNIQUE(batch_id, source_row),
    FOREIGN KEY(batch_id) REFERENCES project_profile_import_batches(id),
    FOREIGN KEY(profile_id) REFERENCES project_profiles(id)
  );
  CREATE TABLE IF NOT EXISTS project_profile_center_links (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    batch_id INTEGER NOT NULL,
    profile_id INTEGER NOT NULL,
    source_system TEXT NOT NULL,
    source_center TEXT NOT NULL,
    link_method TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
    UNIQUE(batch_id, profile_id, source_system, source_center),
    FOREIGN KEY(batch_id) REFERENCES project_profile_import_batches(id),
    FOREIGN KEY(profile_id) REFERENCES project_profiles(id)
  );
  CREATE INDEX IF NOT EXISTS idx_project_profiles_batch_area ON project_profiles(batch_id, area, service_center);
  CREATE INDEX IF NOT EXISTS idx_project_phase_profiles_profile ON project_phase_profiles(profile_id, source_row);
  CREATE INDEX IF NOT EXISTS idx_project_profile_center_links_profile ON project_profile_center_links(profile_id, source_system);

  CREATE TABLE IF NOT EXISTS service_center_master_changes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    center_key TEXT NOT NULL,
    service_center TEXT NOT NULL,
    action_type TEXT NOT NULL CHECK(action_type IN ('withdraw','restore','transfer','correct')),
    previous_area TEXT NOT NULL DEFAULT '',
    new_area TEXT NOT NULL DEFAULT '',
    previous_status TEXT NOT NULL CHECK(previous_status IN ('在管','已撤场')),
    new_status TEXT NOT NULL CHECK(new_status IN ('在管','已撤场')),
    effective_date TEXT NOT NULL,
    reason TEXT NOT NULL,
    evidence TEXT NOT NULL DEFAULT '',
    reconciliation_json TEXT NOT NULL DEFAULT '{}',
    created_by INTEGER,
    created_by_name TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
    rolled_back_at TEXT,
    rolled_back_by INTEGER,
    rolled_back_by_name TEXT,
    rollback_reason TEXT,
    FOREIGN KEY(created_by) REFERENCES users(id),
    FOREIGN KEY(rolled_back_by) REFERENCES users(id)
  );
  CREATE INDEX IF NOT EXISTS idx_service_center_master_changes_effective
    ON service_center_master_changes(center_key,effective_date,id);
  CREATE INDEX IF NOT EXISTS idx_service_center_master_changes_active
    ON service_center_master_changes(rolled_back_at,effective_date);

  CREATE TABLE IF NOT EXISTS import_previews (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    filename TEXT NOT NULL,
    row_count INTEGER DEFAULT 0,
    payload TEXT NOT NULL,
    health_report TEXT,
    errors TEXT,
    created_at TEXT DEFAULT (datetime('now','localtime'))
  );

  CREATE TABLE IF NOT EXISTS management_tasks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id INTEGER,
    project_name TEXT NOT NULL,
    area TEXT,
    risk_type TEXT NOT NULL,
    action TEXT NOT NULL,
    owner TEXT DEFAULT '待指定',
    due_date TEXT,
    status TEXT NOT NULL DEFAULT '待处理',
    result TEXT DEFAULT '',
    review_note TEXT DEFAULT '',
    source TEXT DEFAULT 'AI预警',
    source_type TEXT DEFAULT '',
    source_id TEXT DEFAULT '',
    source_signature TEXT DEFAULT '',
    created_at TEXT DEFAULT (datetime('now','localtime')),
    updated_at TEXT DEFAULT (datetime('now','localtime'))
  );

  CREATE TABLE IF NOT EXISTS task_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id INTEGER NOT NULL,
    event_type TEXT NOT NULL,
    from_status TEXT DEFAULT '',
    to_status TEXT DEFAULT '',
    note TEXT DEFAULT '',
    operator TEXT DEFAULT '',
    created_at TEXT DEFAULT (datetime('now','localtime'))
  );

  CREATE TABLE IF NOT EXISTS task_notifications (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id INTEGER NOT NULL,
    recipient TEXT NOT NULL,
    channel TEXT NOT NULL CHECK(channel IN ('in_app','wecom')),
    content TEXT NOT NULL,
    status TEXT NOT NULL CHECK(status IN ('pending','sent','failed','read')),
    attempts INTEGER NOT NULL DEFAULT 0,
    last_error TEXT DEFAULT '',
    dedupe_key TEXT NOT NULL UNIQUE,
    sent_at TEXT,
    read_at TEXT,
    created_by TEXT DEFAULT '',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_task_notifications_task ON task_notifications(task_id, id DESC);
  CREATE INDEX IF NOT EXISTS idx_task_notifications_recipient ON task_notifications(recipient, status, id DESC);

  CREATE TABLE IF NOT EXISTS weekly_meetings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    week_start TEXT NOT NULL,
    area TEXT NOT NULL DEFAULT '华北',
    title TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','held','closed')),
    summary TEXT DEFAULT '',
    created_by TEXT DEFAULT '',
    held_at TEXT,
    closed_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE(week_start, area)
  );
  CREATE TABLE IF NOT EXISTS weekly_meeting_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    meeting_id INTEGER NOT NULL,
    source_type TEXT NOT NULL,
    source_id TEXT NOT NULL,
    source_signature TEXT NOT NULL,
    project_id INTEGER,
    project_name TEXT DEFAULT '',
    risk_type TEXT DEFAULT '',
    issue TEXT NOT NULL,
    decision TEXT DEFAULT '',
    owner TEXT DEFAULT '',
    due_date TEXT,
    linked_task_id INTEGER,
    status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open','decided','task_created','closed')),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE(meeting_id, source_signature)
  );
  CREATE INDEX IF NOT EXISTS idx_weekly_meeting_items_meeting ON weekly_meeting_items(meeting_id, status, id);

  CREATE TABLE IF NOT EXISTS project_forecasts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    month TEXT NOT NULL,
    project_id INTEGER NOT NULL,
    project_name TEXT NOT NULL,
    area TEXT NOT NULL,
    annual_income REAL,
    annual_cost REAL,
    ytd_income REAL,
    ytd_cost REAL,
    calculated_income REAL,
    calculated_cost REAL,
    forecast_income REAL,
    forecast_cost REAL,
    method TEXT NOT NULL,
    explanation TEXT DEFAULT '',
    owner TEXT DEFAULT '',
    data_source TEXT NOT NULL,
    created_by TEXT DEFAULT '',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE(month, project_id)
  );
  CREATE INDEX IF NOT EXISTS idx_project_forecasts_month_area ON project_forecasts(month, area, project_id);


  CREATE TABLE IF NOT EXISTS alert_rules (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    rule_key TEXT UNIQUE NOT NULL,
    label TEXT NOT NULL,
    threshold_value REAL NOT NULL,
    unit TEXT DEFAULT '',
    enabled INTEGER DEFAULT 1,
    description TEXT DEFAULT '',
    updated_at TEXT DEFAULT (datetime('now','localtime'))
  );

  CREATE TABLE IF NOT EXISTS operation_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER,
    username TEXT,
    action TEXT NOT NULL,
    target TEXT DEFAULT '',
    detail TEXT DEFAULT '{}',
    ip TEXT DEFAULT '',
    created_at TEXT DEFAULT (datetime('now','localtime'))
  );

  CREATE TABLE IF NOT EXISTS report_archives (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    report_date TEXT NOT NULL,
    area TEXT NOT NULL,
    version TEXT NOT NULL,
    title TEXT NOT NULL,
    summary TEXT DEFAULT '',
    payload TEXT NOT NULL,
    archive_version INTEGER NOT NULL DEFAULT 1,
    snapshot_month TEXT DEFAULT '',
    traceability TEXT DEFAULT '{}',
    created_by TEXT DEFAULT '',
    created_at TEXT DEFAULT (datetime('now','localtime'))
  );


  CREATE TABLE IF NOT EXISTS project_monthly_snapshots (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    month TEXT NOT NULL,
    project_id INTEGER,
    project_name TEXT NOT NULL,
    area TEXT NOT NULL,
    property_type TEXT DEFAULT '',
    ytd_income REAL,
    ytd_cost REAL,
    receivable REAL,
    received REAL,
    quality_score REAL,
    safety_incidents INTEGER,
    customer_satisfaction REAL,
    complaint_count INTEGER,
    source TEXT DEFAULT 'manual',
    quality_status TEXT NOT NULL DEFAULT 'unverified',
    quality_reason TEXT DEFAULT '',
    source_status TEXT DEFAULT 'unverified',
    business_date TEXT,
    last_validated_at TEXT,
    field_provenance TEXT DEFAULT '{}',
    created_at TEXT DEFAULT (datetime('now','localtime')),
    UNIQUE(month, project_name)
  );

  CREATE TABLE IF NOT EXISTS data_sources (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    source_key TEXT UNIQUE NOT NULL,
    name TEXT NOT NULL,
    source_type TEXT NOT NULL,
    endpoint TEXT DEFAULT '',
    status TEXT DEFAULT '待检测',
    last_sync_at TEXT,
    note TEXT DEFAULT '',
    updated_at TEXT DEFAULT (datetime('now','localtime'))
  );


  CREATE TABLE IF NOT EXISTS snapshot_runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    month TEXT NOT NULL,
    source TEXT DEFAULT 'auto',
    status TEXT NOT NULL,
    inserted INTEGER DEFAULT 0,
    skipped INTEGER DEFAULT 0,
    message TEXT DEFAULT '',
    created_at TEXT DEFAULT (datetime('now','localtime'))
  );

  CREATE TABLE IF NOT EXISTS data_source_sync_runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    source_key TEXT NOT NULL,
    source_name TEXT NOT NULL,
    run_type TEXT DEFAULT 'manual-check',
    status TEXT NOT NULL,
    health TEXT DEFAULT '',
    message TEXT DEFAULT '',
    detail TEXT DEFAULT '{}',
    duration_ms INTEGER DEFAULT 0,
    rows_read INTEGER DEFAULT 0,
    rows_written INTEGER DEFAULT 0,
    rows_rejected INTEGER DEFAULT 0,
    operator TEXT DEFAULT '',
    started_at TEXT DEFAULT (datetime('now','localtime')),
    finished_at TEXT DEFAULT (datetime('now','localtime')),
    created_at TEXT DEFAULT (datetime('now','localtime'))
  );
`)

db.prepare(`INSERT INTO automation_principals(principal_id,actor,purpose,active)
  VALUES('daily-reconciliation-automation','daily-reconciliation-automation','daily-reconciliation',1)
  ON CONFLICT(principal_id) DO NOTHING`).run()

const dailyReconciliationColumns = new Set((db.prepare("PRAGMA table_info('daily_collection_reconciliations')").all() as Array<{ name: string }>).map(column => column.name))
if (!dailyReconciliationColumns.has('publication_mode')) {
  db.exec("ALTER TABLE daily_collection_reconciliations ADD COLUMN publication_mode TEXT NOT NULL DEFAULT 'snapshot_revision' CHECK(publication_mode IN ('snapshot_revision','daily_only'))")
}
if (!dailyReconciliationColumns.has('business_payload_sha256')) {
  db.exec("ALTER TABLE daily_collection_reconciliations ADD COLUMN business_payload_sha256 TEXT NOT NULL DEFAULT ''")
  db.exec("UPDATE daily_collection_reconciliations SET business_payload_sha256=payload_sha256 WHERE business_payload_sha256='' ")
}
if (!dailyReconciliationColumns.has('zero_value_confirmed')) {
  db.exec("ALTER TABLE daily_collection_reconciliations ADD COLUMN zero_value_confirmed INTEGER NOT NULL DEFAULT 0 CHECK(zero_value_confirmed IN (0,1))")
}
if (!dailyReconciliationColumns.has('zero_value_confirm_note')) {
  db.exec("ALTER TABLE daily_collection_reconciliations ADD COLUMN zero_value_confirm_note TEXT NOT NULL DEFAULT ''")
}
if (!dailyReconciliationColumns.has('total_difference_confirmed')) {
  db.exec("ALTER TABLE daily_collection_reconciliations ADD COLUMN total_difference_confirmed INTEGER NOT NULL DEFAULT 0 CHECK(total_difference_confirmed IN (0,1))")
}
if (!dailyReconciliationColumns.has('total_difference_confirm_note')) {
  db.exec("ALTER TABLE daily_collection_reconciliations ADD COLUMN total_difference_confirm_note TEXT NOT NULL DEFAULT ''")
}

const syncRunColumns = new Set((db.prepare('PRAGMA table_info(data_source_sync_runs)').all() as Array<{ name: string }>).map(column => column.name))
for (const column of ['rows_read', 'rows_written', 'rows_rejected']) {
  if (!syncRunColumns.has(column)) db.exec(`ALTER TABLE data_source_sync_runs ADD COLUMN ${column} INTEGER DEFAULT 0`)
}

// P46 真实经营数据流水线：原始文件批次、逐行差异和发布记录均保留，不覆盖审计历史。
db.exec(`CREATE TABLE IF NOT EXISTS data_ingestion_batches (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source_key TEXT NOT NULL,
  business_date TEXT NOT NULL,
  extracted_at TEXT NOT NULL,
  batch_sha256 TEXT NOT NULL UNIQUE,
  source_files TEXT NOT NULL,
  archive_dir TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('blocked','previewed','published','rejected')),
  publishable INTEGER NOT NULL DEFAULT 0,
  row_count INTEGER NOT NULL DEFAULT 0,
  mapped_count INTEGER NOT NULL DEFAULT 0,
  unmapped_count INTEGER NOT NULL DEFAULT 0,
  validation_errors TEXT NOT NULL DEFAULT '[]',
  summary TEXT NOT NULL DEFAULT '{}',
  created_by TEXT DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  published_by TEXT DEFAULT '',
  published_at TEXT DEFAULT '',
  confirm_note TEXT DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_ingestion_batches_date ON data_ingestion_batches(business_date DESC,id DESC);
CREATE TABLE IF NOT EXISTS data_ingestion_rows (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  batch_id INTEGER NOT NULL,
  entity_type TEXT NOT NULL,
  source_key TEXT NOT NULL,
  canonical_key TEXT NOT NULL,
  mapping_method TEXT NOT NULL,
  change_type TEXT NOT NULL,
  changed_fields TEXT NOT NULL DEFAULT '[]',
  payload TEXT NOT NULL,
  UNIQUE(batch_id,entity_type,source_key)
);
CREATE INDEX IF NOT EXISTS idx_ingestion_rows_batch ON data_ingestion_rows(batch_id,entity_type,change_type);
CREATE TABLE IF NOT EXISTS data_quality_cases (
  code TEXT PRIMARY KEY,
  severity TEXT NOT NULL,
  category TEXT NOT NULL,
  title TEXT NOT NULL,
  detail TEXT NOT NULL,
  evidence_json TEXT NOT NULL DEFAULT '{}',
  recommendation TEXT NOT NULL DEFAULT '',
  workflow_status TEXT NOT NULL DEFAULT 'pending' CHECK(workflow_status IN ('pending','claimed','in_progress','review','resolved')),
  owner TEXT DEFAULT '',
  due_date TEXT DEFAULT '',
  sla_days INTEGER,
  claimed_at TEXT,
  handling_note TEXT DEFAULT '',
  evidence_ref TEXT DEFAULT '',
  review_note TEXT DEFAULT '',
  reviewed_by TEXT DEFAULT '',
  resolution_note TEXT DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  review_submitted_at TEXT,
  resolved_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_quality_cases_status ON data_quality_cases(workflow_status,severity,updated_at);
CREATE TABLE IF NOT EXISTS data_ingestion_publications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  batch_id INTEGER NOT NULL UNIQUE,
  business_date TEXT NOT NULL,
  backup_payload TEXT NOT NULL,
  backup_sha256 TEXT NOT NULL,
  payment_rows INTEGER NOT NULL,
  snapshot_rows INTEGER NOT NULL,
  collection_rows INTEGER NOT NULL DEFAULT 0,
  published_by TEXT DEFAULT '',
  published_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);
CREATE TABLE IF NOT EXISTS collection_trend_backfills (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  business_date TEXT NOT NULL UNIQUE,
  extracted_at TEXT NOT NULL,
  source_file_name TEXT NOT NULL,
  archive_path TEXT NOT NULL,
  source_sha256 TEXT NOT NULL,
  row_count INTEGER NOT NULL,
  payload TEXT NOT NULL,
  validation_errors TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL CHECK(status IN ('previewed','published')),
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  published_by TEXT DEFAULT '',
  published_at TEXT,
  confirm_note TEXT DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_collection_trend_backfills_status_date
  ON collection_trend_backfills(status,business_date);`)

const ingestionPublicationColumns = db.prepare('PRAGMA table_info(data_ingestion_publications)').all() as Array<{ name: string }>
if (!ingestionPublicationColumns.some(column => column.name === 'collection_rows')) {
  db.exec('ALTER TABLE data_ingestion_publications ADD COLUMN collection_rows INTEGER NOT NULL DEFAULT 0')
}

// R5 数据质量责任闭环：仅追加可空/有默认值字段，不改写现有责任状态和历史说明。
const qualityCaseColumns = new Set((db.prepare('PRAGMA table_info(data_quality_cases)').all() as Array<{ name: string }>).map(column => column.name))
const qualityCaseAdditions: Record<string, string> = {
  due_date: "TEXT DEFAULT ''",
  sla_days: 'INTEGER',
  claimed_at: 'TEXT',
  handling_note: "TEXT DEFAULT ''",
  evidence_ref: "TEXT DEFAULT ''",
  review_note: "TEXT DEFAULT ''",
  reviewed_by: "TEXT DEFAULT ''",
}
for (const [name, definition] of Object.entries(qualityCaseAdditions)) {
  if (!qualityCaseColumns.has(name)) db.exec(`ALTER TABLE data_quality_cases ADD COLUMN ${name} ${definition}`)
}
db.exec(`CREATE INDEX IF NOT EXISTS idx_quality_cases_due
  ON data_quality_cases(workflow_status,due_date,severity)`)

// 兼容旧库：历史版本 daily_snapshots 可能没有日报本日回款列
const dailySnapshotColumns = db.prepare('PRAGMA table_info(daily_snapshots)').all() as Array<{ name: string }>
if (!dailySnapshotColumns.some((col) => col.name === 'daily_collection')) {
  db.exec('ALTER TABLE daily_snapshots ADD COLUMN daily_collection REAL')
}

// 快照真实性迁移：旧记录一律保持原值但标记为未验证，禁止自动进入趋势、预测和正式输出。
function ensureSnapshotColumn(table: 'daily_snapshots' | 'project_monthly_snapshots' | 'monthly_trends', name: string, definition: string) {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>
  if (!columns.some(column => column.name === name)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${definition}`)
}
for (const table of ['daily_snapshots', 'project_monthly_snapshots', 'monthly_trends'] as const) {
  ensureSnapshotColumn(table, 'quality_status', "TEXT NOT NULL DEFAULT 'unverified'")
  ensureSnapshotColumn(table, 'quality_reason', "TEXT DEFAULT '历史记录缺少可验证来源与字段血缘'")
  ensureSnapshotColumn(table, 'source', "TEXT DEFAULT ''")
  ensureSnapshotColumn(table, 'source_status', "TEXT DEFAULT 'unverified'")
  ensureSnapshotColumn(table, 'business_date', 'TEXT')
  ensureSnapshotColumn(table, 'last_validated_at', 'TEXT')
  ensureSnapshotColumn(table, 'field_provenance', "TEXT DEFAULT '{}'")
}

// 真实性迁移：历史表把“缺失同期/账龄”强制存为0。重建为可空列，旧0按未验证缺失转NULL。
const paymentCenterColumns = db.prepare('PRAGMA table_info(payment_centers)').all() as Array<{ name: string; notnull: number }>
if (paymentCenterColumns.some(col => ['same_period', 'collection_rate'].includes(col.name) && col.notnull === 1)) {
  db.transaction(() => {
    db.exec(`CREATE TABLE payment_centers_truthful (
      id INTEGER PRIMARY KEY AUTOINCREMENT, area TEXT NOT NULL, center TEXT NOT NULL,
      annual_budget REAL NOT NULL, cumulative_budget REAL NOT NULL, cumulative_executed REAL NOT NULL,
      same_period REAL, collection_rate REAL
    )`)
    db.exec(`INSERT INTO payment_centers_truthful
      SELECT id,area,center,annual_budget,cumulative_budget,cumulative_executed,
        CASE WHEN same_period=0 THEN NULL ELSE same_period END,
        CASE WHEN collection_rate=0 THEN NULL ELSE collection_rate END
      FROM payment_centers`)
    db.exec('DROP TABLE payment_centers')
    db.exec('ALTER TABLE payment_centers_truthful RENAME TO payment_centers')
  })()
}

const paymentWriteColumns = db.prepare('PRAGMA table_info(payment_centers)').all() as Array<{ name: string }>
if (!paymentWriteColumns.some(col => col.name === 'version')) {
  db.exec('ALTER TABLE payment_centers ADD COLUMN version INTEGER NOT NULL DEFAULT 1')
}
if (!paymentWriteColumns.some(col => col.name === 'updated_at')) {
  db.exec("ALTER TABLE payment_centers ADD COLUMN updated_at TEXT NOT NULL DEFAULT ''")
}

const collectionCenterColumns = db.prepare('PRAGMA table_info(collection_centers)').all() as Array<{ name: string; notnull: number }>
if (collectionCenterColumns.some(col => ['overdue30', 'overdue90'].includes(col.name) && col.notnull === 1)) {
  db.transaction(() => {
    db.exec(`CREATE TABLE collection_centers_truthful (
      id INTEGER PRIMARY KEY AUTOINCREMENT, area TEXT NOT NULL, center TEXT NOT NULL,
      receivable REAL NOT NULL, received REAL NOT NULL, overdue30 REAL, overdue90 REAL
    )`)
    db.exec(`INSERT INTO collection_centers_truthful
      SELECT id,area,center,receivable,received,
        CASE WHEN overdue30=0 THEN NULL ELSE overdue30 END,
        CASE WHEN overdue90=0 THEN NULL ELSE overdue90 END
      FROM collection_centers`)
    db.exec('DROP TABLE collection_centers')
    db.exec('ALTER TABLE collection_centers_truthful RENAME TO collection_centers')
  })()
}


// 兼容旧库：旧范围列仅保留展示；非管理员以单一service_center_scope为准，空值默认拒绝。
const userColumns = db.prepare('PRAGMA table_info(users)').all() as Array<{ name: string }>
if (!userColumns.some((col) => col.name === 'area_scope')) {
  db.exec("ALTER TABLE users ADD COLUMN area_scope TEXT DEFAULT ''")
}
if (!userColumns.some((col) => col.name === 'project_scope')) {
  db.exec("ALTER TABLE users ADD COLUMN project_scope TEXT DEFAULT ''")
}
if (!userColumns.some((col) => col.name === 'service_center_scope')) {
  // 旧成员不猜测归属：保持空范围并由业务路由默认拒绝，管理员上线后逐一分配。
  db.exec("ALTER TABLE users ADD COLUMN service_center_scope TEXT DEFAULT ''")
}
if (!userColumns.some((col) => col.name === 'token_version')) {
  db.exec('ALTER TABLE users ADD COLUMN token_version INTEGER NOT NULL DEFAULT 0')
}

// 兼容旧库：经营指挥台TOP5等来源任务需要稳定来源标识，确保未闭环任务幂等。
const taskColumns = db.prepare('PRAGMA table_info(management_tasks)').all() as Array<{ name: string }>
if (!taskColumns.some((col) => col.name === 'source_type')) {
  db.exec("ALTER TABLE management_tasks ADD COLUMN source_type TEXT DEFAULT ''")
}
if (!taskColumns.some((col) => col.name === 'source_id')) {
  db.exec("ALTER TABLE management_tasks ADD COLUMN source_id TEXT DEFAULT ''")
}
if (!taskColumns.some((col) => col.name === 'source_signature')) {
  db.exec("ALTER TABLE management_tasks ADD COLUMN source_signature TEXT DEFAULT ''")
}
if (!taskColumns.some((col) => col.name === 'archived_at')) db.exec("ALTER TABLE management_tasks ADD COLUMN archived_at TEXT DEFAULT ''")
if (!taskColumns.some((col) => col.name === 'archived_reason')) db.exec("ALTER TABLE management_tasks ADD COLUMN archived_reason TEXT DEFAULT ''")
if (!taskColumns.some((col) => col.name === 'merged_into_task_id')) db.exec('ALTER TABLE management_tasks ADD COLUMN merged_into_task_id INTEGER')
db.exec('DROP INDEX IF EXISTS idx_management_tasks_open_source_signature')
db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_management_tasks_open_source_signature
  ON management_tasks(source_signature)
  WHERE source_signature != '' AND status != '已完成' AND COALESCE(archived_at,'')=''`)
db.exec(`CREATE TABLE IF NOT EXISTS task_merge_groups (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  primary_task_id INTEGER NOT NULL,
  merge_key TEXT NOT NULL,
  reason TEXT NOT NULL,
  member_count INTEGER NOT NULL,
  merged_by TEXT NOT NULL,
  confirm_note TEXT NOT NULL,
  merged_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);
CREATE TABLE IF NOT EXISTS task_merge_members (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  group_id INTEGER NOT NULL,
  task_id INTEGER NOT NULL UNIQUE,
  member_role TEXT NOT NULL CHECK(member_role IN ('primary','duplicate')),
  task_snapshot TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);
CREATE INDEX IF NOT EXISTS idx_task_merge_primary ON task_merge_groups(primary_task_id);
CREATE INDEX IF NOT EXISTS idx_task_merge_members_group ON task_merge_members(group_id);`)

// P39 项目主数据治理：内部稳定编码与历史项目ID别名，不把内部编码冒充外部系统ID。
const projectColumns = db.prepare('PRAGMA table_info(projects)').all() as Array<{ name: string }>
const projectColumnNames = new Set(projectColumns.map(column => column.name))
if (!projectColumnNames.has('project_code')) db.exec("ALTER TABLE projects ADD COLUMN project_code TEXT DEFAULT ''")
if (!projectColumnNames.has('source_system')) db.exec("ALTER TABLE projects ADD COLUMN source_system TEXT DEFAULT 'cockpit-import'")
if (!projectColumnNames.has('source_project_id')) db.exec("ALTER TABLE projects ADD COLUMN source_project_id TEXT DEFAULT ''")
if (!projectColumnNames.has('active_status')) db.exec("ALTER TABLE projects ADD COLUMN active_status TEXT DEFAULT 'active'")
if (!projectColumnNames.has('validation_status')) db.exec("ALTER TABLE projects ADD COLUMN validation_status TEXT DEFAULT 'unverified'")
if (!projectColumnNames.has('source_batch')) db.exec("ALTER TABLE projects ADD COLUMN source_batch TEXT DEFAULT ''")
if (!projectColumnNames.has('field_provenance')) db.exec("ALTER TABLE projects ADD COLUMN field_provenance TEXT DEFAULT '{}'")
if (!projectColumnNames.has('official_collection_rate')) db.exec('ALTER TABLE projects ADD COLUMN official_collection_rate REAL')
db.exec("UPDATE projects SET project_code = 'HB-' || printf('%04d', id) WHERE COALESCE(project_code, '') = ''")
db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_projects_project_code ON projects(project_code)')
db.exec(`CREATE TABLE IF NOT EXISTS project_id_aliases (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  legacy_project_id INTEGER NOT NULL,
  current_project_id INTEGER NOT NULL,
  project_name TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'legacy-task-migration',
  migrated_records INTEGER NOT NULL DEFAULT 0,
  migrated_by TEXT DEFAULT '',
  created_at TEXT DEFAULT (datetime('now','localtime')),
  UNIQUE(legacy_project_id, current_project_id)
)`)

// P48 周会纪律：记录实际召开/关闭操作人，旧记录不补造人员。
const meetingColumns=db.prepare('PRAGMA table_info(weekly_meetings)').all() as Array<{name:string}>
const meetingColumnNames=new Set(meetingColumns.map(x=>x.name))
if(!meetingColumnNames.has('held_by'))db.exec("ALTER TABLE weekly_meetings ADD COLUMN held_by TEXT DEFAULT ''")
if(!meetingColumnNames.has('closed_by'))db.exec("ALTER TABLE weekly_meetings ADD COLUMN closed_by TEXT DEFAULT ''")

// P42 滚动预测审批：当前状态保存在主表，每次动作快照写入不可变版本表。
const forecastColumns = db.prepare('PRAGMA table_info(project_forecasts)').all() as Array<{ name: string }>
const forecastColumnNames = new Set(forecastColumns.map(column => column.name))
if (!forecastColumnNames.has('workflow_status')) db.exec("ALTER TABLE project_forecasts ADD COLUMN workflow_status TEXT NOT NULL DEFAULT 'draft'")
if (!forecastColumnNames.has('workflow_version')) db.exec('ALTER TABLE project_forecasts ADD COLUMN workflow_version INTEGER NOT NULL DEFAULT 1')
if (!forecastColumnNames.has('last_action_note')) db.exec("ALTER TABLE project_forecasts ADD COLUMN last_action_note TEXT DEFAULT ''")
if (!forecastColumnNames.has('submitted_by')) db.exec("ALTER TABLE project_forecasts ADD COLUMN submitted_by TEXT DEFAULT ''")
if (!forecastColumnNames.has('submitted_at')) db.exec("ALTER TABLE project_forecasts ADD COLUMN submitted_at TEXT DEFAULT ''")
if (!forecastColumnNames.has('area_reviewed_by')) db.exec("ALTER TABLE project_forecasts ADD COLUMN area_reviewed_by TEXT DEFAULT ''")
if (!forecastColumnNames.has('area_reviewed_at')) db.exec("ALTER TABLE project_forecasts ADD COLUMN area_reviewed_at TEXT DEFAULT ''")
if (!forecastColumnNames.has('region_reviewed_by')) db.exec("ALTER TABLE project_forecasts ADD COLUMN region_reviewed_by TEXT DEFAULT ''")
if (!forecastColumnNames.has('region_reviewed_at')) db.exec("ALTER TABLE project_forecasts ADD COLUMN region_reviewed_at TEXT DEFAULT ''")
if (!forecastColumnNames.has('locked_by')) db.exec("ALTER TABLE project_forecasts ADD COLUMN locked_by TEXT DEFAULT ''")
if (!forecastColumnNames.has('locked_at')) db.exec("ALTER TABLE project_forecasts ADD COLUMN locked_at TEXT DEFAULT ''")
db.exec(`CREATE TABLE IF NOT EXISTS forecast_workflow_versions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  forecast_id INTEGER NOT NULL,
  month TEXT NOT NULL,
  project_id INTEGER NOT NULL,
  project_name TEXT NOT NULL,
  version INTEGER NOT NULL,
  previous_status TEXT NOT NULL,
  status TEXT NOT NULL,
  action TEXT NOT NULL,
  forecast_income REAL,
  forecast_cost REAL,
  explanation TEXT DEFAULT '',
  owner TEXT DEFAULT '',
  note TEXT DEFAULT '',
  actor TEXT DEFAULT '',
  actor_role TEXT DEFAULT '',
  created_at TEXT NOT NULL,
  UNIQUE(forecast_id, version)
)`)
db.exec('CREATE INDEX IF NOT EXISTS idx_forecast_workflow_versions_forecast ON forecast_workflow_versions(forecast_id, version DESC)')

// P43 正式办公输出：归档记录只追加，不覆盖历史文件。
db.exec(`CREATE TABLE IF NOT EXISTS formal_output_archives (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  output_type TEXT NOT NULL,
  period TEXT NOT NULL,
  area TEXT NOT NULL DEFAULT '华北',
  title TEXT NOT NULL,
  base_name TEXT NOT NULL,
  files_json TEXT NOT NULL,
  evidence_json TEXT NOT NULL DEFAULT '{}',
  created_by TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
)`)

// 欠费资源分析：受控上传批次、脱敏事实、证据化归因和人工复核。
// 原始文件仅以AES-GCM密文存储在数据库外，AI不得回写正式收费事实或自动创建任务。
const ARREARS_SCHEMA_SQL = `CREATE TABLE IF NOT EXISTS arrears_upload_batches (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL,
  project_name TEXT NOT NULL,
  business_date TEXT NOT NULL,
  ledger_filename TEXT NOT NULL,
  ledger_sha256 TEXT NOT NULL,
  communication_filename TEXT NOT NULL,
  communication_sha256 TEXT NOT NULL,
  encrypted_archive_dir TEXT DEFAULT '',
  archive_ledger_sha256 TEXT DEFAULT '',
  archive_communication_sha256 TEXT DEFAULT '',
  encryption_key_version TEXT DEFAULT '',
  archive_deleted_at TEXT DEFAULT '',
  archive_delete_state TEXT NOT NULL DEFAULT 'active' CHECK(archive_delete_state IN ('active','pending','deleted','error')),
  status TEXT NOT NULL CHECK(status IN ('parsed','blocked','analyzing','analyzed','rule_only','revoked')),
  parser_version TEXT NOT NULL,
  ledger_rows INTEGER NOT NULL DEFAULT 0,
  communication_rows INTEGER NOT NULL DEFAULT 0,
  matched_resources INTEGER NOT NULL DEFAULT 0,
  unmatched_communication_rows INTEGER NOT NULL DEFAULT 0,
  validation_errors TEXT NOT NULL DEFAULT '[]',
  created_by_user_id INTEGER,
  created_by TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  analyzed_at TEXT DEFAULT '',
  ai_model TEXT DEFAULT '',
  ai_status TEXT DEFAULT '',
  active_run_id INTEGER,
  retention_until TEXT NOT NULL,
  revoked_by TEXT DEFAULT '',
  revoked_at TEXT DEFAULT '',
  revoke_note TEXT DEFAULT '',
  UNIQUE(project_id,ledger_sha256,communication_sha256),
  FOREIGN KEY(project_id) REFERENCES project_profiles(id) ON DELETE RESTRICT
);
CREATE TABLE IF NOT EXISTS arrears_source_sync_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source TEXT NOT NULL CHECK(source IN ('lvzai','wecom_ledger','qxm')),
  business_date TEXT NOT NULL,
  extracted_at TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('published','superseded')),
  row_count INTEGER NOT NULL,
  unique_house_count INTEGER NOT NULL,
  total_amount REAL,
  quality_json TEXT NOT NULL,
  evidence_sha256 TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  UNIQUE(source,business_date,evidence_sha256)
);
CREATE INDEX IF NOT EXISTS idx_arrears_source_runs_effective ON arrears_source_sync_runs(source,status,business_date DESC,id DESC);
CREATE TABLE IF NOT EXISTS arrears_lvzai_facts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id INTEGER NOT NULL,
  source_row INTEGER NOT NULL,
  house_hash TEXT NOT NULL,
  house_masked TEXT NOT NULL,
  service_center TEXT NOT NULL,
  room_id_hash TEXT NOT NULL,
  person_id_hash TEXT NOT NULL,
  fee_item TEXT NOT NULL,
  amount REAL NOT NULL,
  period_start TEXT NOT NULL,
  period_end TEXT NOT NULL,
  payment_status TEXT NOT NULL,
  evidence_sha256 TEXT NOT NULL,
  UNIQUE(run_id,source_row),
  UNIQUE(run_id,evidence_sha256),
  FOREIGN KEY(run_id) REFERENCES arrears_source_sync_runs(id) ON DELETE RESTRICT
);
CREATE INDEX IF NOT EXISTS idx_arrears_lvzai_house ON arrears_lvzai_facts(run_id,house_hash);
CREATE TABLE IF NOT EXISTS arrears_wecom_ledger_facts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id INTEGER NOT NULL,
  source_row INTEGER NOT NULL,
  house_hash TEXT NOT NULL,
  house_masked TEXT NOT NULL,
  service_center TEXT NOT NULL,
  document_id_hash TEXT NOT NULL,
  sheet_id_hash TEXT NOT NULL,
  record_id_hash TEXT NOT NULL,
  manual_cause TEXT NOT NULL,
  progress TEXT NOT NULL,
  latest_followup_date TEXT NOT NULL,
  promised_payment_date TEXT NOT NULL,
  responsible_user_id_hash TEXT NOT NULL,
  evidence_sha256 TEXT NOT NULL,
  UNIQUE(run_id,source_row),
  UNIQUE(run_id,record_id_hash),
  UNIQUE(run_id,evidence_sha256),
  FOREIGN KEY(run_id) REFERENCES arrears_source_sync_runs(id) ON DELETE RESTRICT
);
CREATE INDEX IF NOT EXISTS idx_arrears_wecom_house ON arrears_wecom_ledger_facts(run_id,house_hash);
CREATE TABLE IF NOT EXISTS arrears_qxm_evidence (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id INTEGER NOT NULL,
  source_row INTEGER NOT NULL,
  service_center TEXT NOT NULL,
  match_state TEXT NOT NULL CHECK(match_state IN ('matched','review_required')),
  house_hash TEXT,
  house_masked TEXT NOT NULL,
  room_reference_hash TEXT NOT NULL,
  message_id_hash TEXT NOT NULL UNIQUE,
  external_user_id_hash TEXT NOT NULL,
  employee_user_id_hash TEXT NOT NULL,
  occurred_at TEXT NOT NULL,
  direction TEXT NOT NULL,
  content_kind TEXT NOT NULL,
  signal_state TEXT NOT NULL,
  cause_signal TEXT NOT NULL,
  evidence_sha256 TEXT NOT NULL,
  UNIQUE(run_id,source_row),
  FOREIGN KEY(run_id) REFERENCES arrears_source_sync_runs(id) ON DELETE RESTRICT
);
CREATE INDEX IF NOT EXISTS idx_arrears_qxm_house ON arrears_qxm_evidence(service_center,house_hash,occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_arrears_qxm_review ON arrears_qxm_evidence(match_state,service_center,occurred_at DESC);
CREATE TABLE IF NOT EXISTS arrears_qxm_shard_status (
  department_id_hash TEXT NOT NULL,
  service_center TEXT NOT NULL,
  business_date TEXT NOT NULL,
  extracted_at TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('passed','failed')),
  error_code TEXT NOT NULL DEFAULT '',
  row_count INTEGER NOT NULL DEFAULT 0,
  matched_count INTEGER NOT NULL DEFAULT 0,
  isolated_count INTEGER NOT NULL DEFAULT 0,
  cursor_advanced INTEGER NOT NULL DEFAULT 0 CHECK(cursor_advanced IN (0,1)),
  run_id INTEGER,
  updated_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  PRIMARY KEY(department_id_hash,service_center),
  FOREIGN KEY(run_id) REFERENCES arrears_source_sync_runs(id) ON DELETE RESTRICT
);
CREATE INDEX IF NOT EXISTS idx_arrears_qxm_shard_status_center ON arrears_qxm_shard_status(service_center,state,business_date DESC);
CREATE TABLE IF NOT EXISTS arrears_evidence_conflict_reviews (
  conflict_key TEXT PRIMARY KEY,
  conflict_type TEXT NOT NULL,
  house_hash TEXT NOT NULL,
  service_center TEXT NOT NULL,
  lvzai_run_id INTEGER,
  wecom_run_id INTEGER,
  qxm_run_id INTEGER,
  decision TEXT NOT NULL CHECK(decision IN ('confirmed','rejected')),
  reason_code TEXT NOT NULL,
  reviewed_by_user_id INTEGER,
  reviewed_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  version INTEGER NOT NULL DEFAULT 1,
  FOREIGN KEY(lvzai_run_id) REFERENCES arrears_source_sync_runs(id) ON DELETE RESTRICT,
  FOREIGN KEY(wecom_run_id) REFERENCES arrears_source_sync_runs(id) ON DELETE RESTRICT,
  FOREIGN KEY(qxm_run_id) REFERENCES arrears_source_sync_runs(id) ON DELETE RESTRICT
);
CREATE INDEX IF NOT EXISTS idx_arrears_conflict_reviews_runs ON arrears_evidence_conflict_reviews(lvzai_run_id,wecom_run_id,qxm_run_id,service_center);
CREATE INDEX IF NOT EXISTS idx_arrears_batches_project ON arrears_upload_batches(project_id,id DESC);
CREATE INDEX IF NOT EXISTS idx_arrears_batches_status ON arrears_upload_batches(status,retention_until);
CREATE TABLE IF NOT EXISTS arrears_ledger_rows (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  batch_id INTEGER NOT NULL,
  source_row INTEGER NOT NULL,
  evidence_ref TEXT NOT NULL,
  resource_hash TEXT NOT NULL,
  resource_display TEXT NOT NULL DEFAULT '',
  resource_masked TEXT NOT NULL,
  customer_masked TEXT DEFAULT '',
  phone_masked TEXT DEFAULT '',
  arrears_amount REAL,
  fee_item TEXT DEFAULT '',
  period_start TEXT DEFAULT '',
  period_end TEXT DEFAULT '',
  ageing_days INTEGER,
  source_status TEXT DEFAULT '',
  evidence_json TEXT NOT NULL DEFAULT '{}',
  UNIQUE(batch_id,evidence_ref),
  FOREIGN KEY(batch_id) REFERENCES arrears_upload_batches(id)
);
CREATE INDEX IF NOT EXISTS idx_arrears_ledger_resource ON arrears_ledger_rows(batch_id,resource_hash);
CREATE TABLE IF NOT EXISTS arrears_communication_rows (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  batch_id INTEGER NOT NULL,
  source_row INTEGER NOT NULL,
  evidence_ref TEXT NOT NULL,
  resource_hash TEXT NOT NULL,
  resource_masked TEXT NOT NULL,
  occurred_at TEXT DEFAULT '',
  channel TEXT DEFAULT '',
  actor_masked TEXT DEFAULT '',
  content_masked TEXT NOT NULL,
  evidence_sha256 TEXT NOT NULL,
  UNIQUE(batch_id,evidence_ref),
  FOREIGN KEY(batch_id) REFERENCES arrears_upload_batches(id)
);
CREATE INDEX IF NOT EXISTS idx_arrears_communications_resource ON arrears_communication_rows(batch_id,resource_hash);
CREATE TABLE IF NOT EXISTS arrears_analysis_results (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  batch_id INTEGER NOT NULL,
  resource_hash TEXT NOT NULL,
  resource_ref TEXT NOT NULL,
  resource_masked TEXT NOT NULL,
  rule_category TEXT NOT NULL DEFAULT 'unknown',
  rule_confidence REAL NOT NULL DEFAULT 0,
  rule_evidence_json TEXT NOT NULL DEFAULT '[]',
  data_notes_json TEXT NOT NULL DEFAULT '[]',
  ai_category TEXT DEFAULT '',
  ai_confidence REAL,
  ai_reason TEXT DEFAULT '',
  ai_evidence_json TEXT NOT NULL DEFAULT '[]',
  analysis_status TEXT NOT NULL DEFAULT 'pending_ai' CHECK(analysis_status IN ('pending_ai','ai_analyzed','ai_rejected')),
  human_status TEXT NOT NULL DEFAULT 'pending' CHECK(human_status IN ('pending','confirmed','rejected')),
  human_category TEXT DEFAULT '',
  human_note TEXT DEFAULT '',
  reviewed_by TEXT DEFAULT '',
  reviewed_at TEXT DEFAULT '',
  UNIQUE(batch_id,resource_hash),
  FOREIGN KEY(batch_id) REFERENCES arrears_upload_batches(id)
);
CREATE INDEX IF NOT EXISTS idx_arrears_results_batch ON arrears_analysis_results(batch_id,analysis_status,human_status);
CREATE TABLE IF NOT EXISTS arrears_analysis_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  batch_id INTEGER NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('running','completed','partial','failed','discarded')),
  prompt_sha256 TEXT NOT NULL,
  model TEXT DEFAULT '',
  accepted_count INTEGER NOT NULL DEFAULT 0,
  rejected_count INTEGER NOT NULL DEFAULT 0,
  summary_json TEXT NOT NULL DEFAULT '{}',
  error_message TEXT DEFAULT '',
  started_by TEXT DEFAULT '',
  started_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  completed_at TEXT DEFAULT '',
  FOREIGN KEY(batch_id) REFERENCES arrears_upload_batches(id)
);
CREATE INDEX IF NOT EXISTS idx_arrears_runs_batch ON arrears_analysis_runs(batch_id,id DESC);`
db.exec(ARREARS_SCHEMA_SQL)
const arrearsLedgerColumns = new Set((db.prepare("PRAGMA table_info('arrears_ledger_rows')").all() as Array<{ name: string }>).map(column => column.name))
if (!arrearsLedgerColumns.has('resource_display')) db.exec("ALTER TABLE arrears_ledger_rows ADD COLUMN resource_display TEXT NOT NULL DEFAULT ''")

// 56个服务中心的 Hermes 分析与经营事实分层保存。
// input_sha256 包含 null 原值、发布状态、模型、prompt 和知识版本；
// 因此只有完全相同的证据才会命中缓存，不会用旧结论覆盖新数据。
db.exec(`CREATE TABLE IF NOT EXISTS service_center_ai_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  scope_sha256 TEXT NOT NULL,
  input_hashes_json TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL CHECK(status IN ('running','completed','partial','failed','discarded')),
  model TEXT NOT NULL DEFAULT '',
  prompt_version TEXT NOT NULL,
  total_count INTEGER NOT NULL DEFAULT 0,
  completed_count INTEGER NOT NULL DEFAULT 0,
  generated_count INTEGER NOT NULL DEFAULT 0,
  cached_count INTEGER NOT NULL DEFAULT 0,
  rejected_count INTEGER NOT NULL DEFAULT 0,
  unavailable_count INTEGER NOT NULL DEFAULT 0,
  insufficient_count INTEGER NOT NULL DEFAULT 0,
  error_summary_json TEXT NOT NULL DEFAULT '{}',
  started_by_user_id INTEGER,
  started_by TEXT NOT NULL DEFAULT '',
  started_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  completed_at TEXT DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_service_center_ai_runs_scope
  ON service_center_ai_runs(scope_sha256,status,id DESC);
CREATE TABLE IF NOT EXISTS service_center_ai_results (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  normalized_center TEXT NOT NULL,
  input_sha256 TEXT NOT NULL UNIQUE,
  business_date TEXT DEFAULT '',
  status TEXT NOT NULL CHECK(status IN ('generated','rejected','unavailable','insufficient_evidence')),
  generated_by TEXT NOT NULL CHECK(generated_by IN ('hermes-grounded','verified-rules')),
  model TEXT DEFAULT '',
  prompt_version TEXT NOT NULL,
  knowledge_sha256 TEXT NOT NULL,
  ai_opinion_json TEXT NOT NULL DEFAULT 'null',
  error_code TEXT DEFAULT '',
  generated_at TEXT DEFAULT '',
  created_at_ms INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_service_center_ai_results_center
  ON service_center_ai_results(normalized_center,created_at_ms DESC);`)

// 服务重启后不得把未完成的模型请求伪装成成功结果。
db.prepare(`UPDATE service_center_ai_runs
  SET status='failed', completed_at=datetime('now','localtime'),
      error_summary_json=json_object('code','service_restarted','message','AI分析因服务重启中断，可安全重试')
  WHERE status='running'`).run()

// 早期候选版本错误地关联了空的 legacy projects 表。欠费功能尚无批次时可安全重建；
// 一旦存在任何批次则失败关闭，禁止静默改写项目身份。
const arrearsProjectForeignKey = (db.prepare("PRAGMA foreign_key_list('arrears_upload_batches')").all() as Array<{ table: string; from: string }>).find(row => row.from === 'project_id')
if (arrearsProjectForeignKey?.table !== 'project_profiles') {
  const batchCount = Number((db.prepare('SELECT COUNT(*) AS count FROM arrears_upload_batches').get() as { count: number }).count)
  if (batchCount !== 0) throw new Error('arrears_project_fk_migration_requires_manual_review')
  db.exec(`
    DROP TABLE IF EXISTS arrears_analysis_runs;
    DROP TABLE IF EXISTS arrears_analysis_results;
    DROP TABLE IF EXISTS arrears_communication_rows;
    DROP TABLE IF EXISTS arrears_ledger_rows;
    DROP TABLE IF EXISTS arrears_upload_batches;
  `)
  db.exec(ARREARS_SCHEMA_SQL)
}

// 欠费分析结构为隐私敏感功能：旧版/残缺表不得静默运行，必须先走受控迁移。
const arrearsBatchColumns = new Set((db.prepare("PRAGMA table_info('arrears_upload_batches')").all() as Array<{ name: string }>).map(column => column.name))
const requiredArrearsColumns = ['archive_ledger_sha256','archive_communication_sha256','encryption_key_version','archive_deleted_at','archive_delete_state','active_run_id']
const missingArrearsColumns = requiredArrearsColumns.filter(name => !arrearsBatchColumns.has(name))
const arrearsBatchSql = String((db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='arrears_upload_batches'").get() as any)?.sql || '')
const arrearsForeignKeys = db.prepare("PRAGMA foreign_key_list('arrears_upload_batches')").all() as Array<{ table: string; from: string; on_delete: string }>
if (missingArrearsColumns.length || !arrearsBatchSql.includes("'analyzing'") || !arrearsForeignKeys.some(item => item.table === 'project_profiles' && item.from === 'project_id' && item.on_delete.toUpperCase() === 'RESTRICT')) {
  throw new Error(`欠费分析数据库结构版本不兼容，已拒绝启动：missing=${missingArrearsColumns.join(',') || 'none'}`)
}

// 数据真实性隔离区：保存被移出业务表的完整原始记录，支持审计和受控恢复。
db.exec(`CREATE TABLE IF NOT EXISTS data_quarantine (
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
)`)
db.exec('CREATE INDEX IF NOT EXISTS idx_data_quarantine_status ON data_quarantine(status, source_table, id)')

// P30 月报归档版本与追溯证据：旧库增量升级，归档只新增不覆盖。
const reportArchiveColumns = db.prepare("PRAGMA table_info('report_archives')").all() as Array<{ name: string }>
const reportArchiveColumnNames = new Set(reportArchiveColumns.map(column => column.name))
if (!reportArchiveColumnNames.has('archive_version')) db.exec("ALTER TABLE report_archives ADD COLUMN archive_version INTEGER NOT NULL DEFAULT 1")
if (!reportArchiveColumnNames.has('snapshot_month')) db.exec("ALTER TABLE report_archives ADD COLUMN snapshot_month TEXT DEFAULT ''")
if (!reportArchiveColumnNames.has('traceability')) db.exec("ALTER TABLE report_archives ADD COLUMN traceability TEXT DEFAULT '{}'")
db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_report_archives_version
  ON report_archives(report_date, area, version, archive_version)`)

// 种子管理员：禁止源码硬编码弱口令；优先环境变量，否则生成一次性强密码写入本机密钥文件
const userCnt = db.prepare('SELECT COUNT(*) as cnt FROM users').get() as { cnt: number }
if (userCnt.cnt === 0) {
  const pwdFile = process.env.COCKPIT_ADMIN_PASSWORD_FILE || `${os.homedir()}/.cockpit_admin_initial_password`
  let initialPassword = process.env.COCKPIT_ADMIN_PASSWORD || ''
  if (!initialPassword) {
    initialPassword = crypto.randomBytes(18).toString('base64url')
    fs.writeFileSync(pwdFile, initialPassword, { mode: 0o600 })
  }
  db.prepare('INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)').run(
    'admin', bcrypt.hashSync(initialPassword, 10), 'admin'
  )
  console.log(`[db] 默认管理员已初始化；初始密码来自 ${process.env.COCKPIT_ADMIN_PASSWORD ? 'COCKPIT_ADMIN_PASSWORD' : pwdFile}`)
}

// 业务演示数据只能在非生产环境显式开启。生产空表必须暴露“无数据”，禁止伪装成真实经营数据。
if (canUseDemoData()) {

const paymentCount = db.prepare('SELECT COUNT(*) as cnt FROM payment_centers').get() as { cnt: number }

if (paymentCount.cnt === 0) {
  const insertPayment = db.prepare(`
    INSERT INTO payment_centers (area, center, annual_budget, cumulative_budget, cumulative_executed, same_period, collection_rate)
    VALUES (@area, @center, @annualBudget, @cumulativeBudget, @cumulativeExecuted, @samePeriod, @collectionRate)
  `)

  const payments = [
    { area: '朝阳片区', center: '朝阳第一服务中心', annualBudget: 3997, cumulativeBudget: 1906, cumulativeExecuted: 1660, samePeriod: 1931, collectionRate: 0.918 },
    { area: '朝阳片区', center: '朝阳第二服务中心', annualBudget: 2634, cumulativeBudget: 1261, cumulativeExecuted: 1069, samePeriod: 1278, collectionRate: 0.886 },
    { area: '京东片区', center: '通州服务中心', annualBudget: 3052, cumulativeBudget: 1453, cumulativeExecuted: 1238, samePeriod: 1434, collectionRate: 0.895 },
    { area: '京东片区', center: '亦庄服务中心', annualBudget: 2398, cumulativeBudget: 1138, cumulativeExecuted: 903, samePeriod: 1067, collectionRate: 0.842 },
    { area: '海淀片区', center: '海淀服务中心', annualBudget: 3415, cumulativeBudget: 1630, cumulativeExecuted: 1404, samePeriod: 1637, collectionRate: 0.905 },
    { area: '海淀片区', center: '西城服务中心', annualBudget: 1780, cumulativeBudget: 861, cumulativeExecuted: 672, samePeriod: 794, collectionRate: 0.828 },
    { area: '顺平片区', center: '顺义服务中心', annualBudget: 1562, cumulativeBudget: 746, cumulativeExecuted: 591, samePeriod: 714, collectionRate: 0.836 },
    { area: '顺平片区', center: '平谷服务中心', annualBudget: 981, cumulativeBudget: 469, cumulativeExecuted: 368, samePeriod: 441, collectionRate: 0.821 },
    { area: '河北片区', center: '石家庄服务中心', annualBudget: 1671, cumulativeBudget: 799, cumulativeExecuted: 644, samePeriod: 754, collectionRate: 0.852 },
    { area: '河北片区', center: '天津服务中心', annualBudget: 1417, cumulativeBudget: 676, cumulativeExecuted: 560, samePeriod: 653, collectionRate: 0.869 },
    { area: '辽宁片区', center: '沈阳服务中心', annualBudget: 1308, cumulativeBudget: 630, cumulativeExecuted: 503, samePeriod: 589, collectionRate: 0.845 },
    { area: '辽宁片区', center: '大连服务中心', annualBudget: 854, cumulativeBudget: 407, cumulativeExecuted: 318, samePeriod: 377, collectionRate: 0.818 },
  ]

  const insertMany = db.transaction(() => {
    for (const p of payments) insertPayment.run(p)
  })
  insertMany()
}

const collectionCount = db.prepare('SELECT COUNT(*) as cnt FROM collection_centers').get() as { cnt: number }

if (collectionCount.cnt === 0) {
  const insertCollection = db.prepare(`
    INSERT INTO collection_centers (area, center, receivable, received, overdue30, overdue90)
    VALUES (@area, @center, @receivable, @received, @overdue30, @overdue90)
  `)

  const collections = [
    { area: '朝阳片区', center: '朝阳第一服务中心', receivable: 1807, received: 1660, overdue30: 87, overdue90: 60 },
    { area: '朝阳片区', center: '朝阳第二服务中心', receivable: 1207, received: 1069, overdue30: 77, overdue90: 60 },
    { area: '京东片区', center: '通州服务中心', receivable: 1382, received: 1238, overdue30: 84, overdue90: 60 },
    { area: '京东片区', center: '亦庄服务中心', receivable: 1072, received: 903, overdue30: 96, overdue90: 73 },
    { area: '海淀片区', center: '海淀服务中心', receivable: 1551, received: 1404, overdue30: 82, overdue90: 66 },
    { area: '海淀片区', center: '西城服务中心', receivable: 811, received: 672, overdue30: 79, overdue90: 60 },
    { area: '顺平片区', center: '顺义服务中心', receivable: 706, received: 591, overdue30: 68, overdue90: 48 },
    { area: '顺平片区', center: '平谷服务中心', receivable: 449, received: 368, overdue30: 45, overdue90: 35 },
    { area: '河北片区', center: '石家庄服务中心', receivable: 757, received: 644, overdue30: 63, overdue90: 49 },
    { area: '河北片区', center: '天津服务中心', receivable: 644, received: 560, overdue30: 48, overdue90: 37 },
    { area: '辽宁片区', center: '沈阳服务中心', receivable: 596, received: 503, overdue30: 53, overdue90: 39 },
    { area: '辽宁片区', center: '大连服务中心', receivable: 388, received: 318, overdue30: 39, overdue90: 31 },
  ]

  const insertMany = db.transaction(() => {
    for (const c of collections) insertCollection.run(c)
  })
  insertMany()
}

const trendsCount = db.prepare('SELECT COUNT(*) as cnt FROM monthly_trends').get() as { cnt: number }

if (trendsCount.cnt === 0) {
  const insertTrend = db.prepare(`
    INSERT INTO monthly_trends (month, "华北汇总", "朝阳片区", "京东片区", "海淀片区", "顺平片区", "河北片区", "辽宁片区")
    VALUES (@month, @华北汇总, @朝阳片区, @京东片区, @海淀片区, @顺平片区, @河北片区, @辽宁片区)
  `)

  const trends = [
    { month: '2025-09', '华北汇总': 0.842, '朝阳片区': 0.872, '京东片区': 0.851, '海淀片区': 0.868, '顺平片区': 0.812, '河北片区': 0.835, '辽宁片区': 0.808 },
    { month: '2025-10', '华北汇总': 0.848, '朝阳片区': 0.881, '京东片区': 0.856, '海淀片区': 0.872, '顺平片区': 0.818, '河北片区': 0.841, '辽宁片区': 0.815 },
    { month: '2025-11', '华北汇总': 0.853, '朝阳片区': 0.889, '京东片区': 0.862, '海淀片区': 0.878, '顺平片区': 0.822, '河北片区': 0.848, '辽宁片区': 0.821 },
    { month: '2025-12', '华北汇总': 0.858, '朝阳片区': 0.895, '京东片区': 0.865, '海淀片区': 0.881, '顺平片区': 0.825, '河北片区': 0.852, '辽宁片区': 0.825 },
    { month: '2026-01', '华北汇总': 0.862, '朝阳片区': 0.901, '京东片区': 0.87, '海淀片区': 0.885, '顺平片区': 0.828, '河北片区': 0.855, '辽宁片区': 0.828 },
    { month: '2026-02', '华北汇总': 0.864, '朝阳片区': 0.905, '京东片区': 0.872, '海淀片区': 0.888, '顺平片区': 0.83, '河北片区': 0.858, '辽宁片区': 0.83 },
    { month: '2026-03', '华北汇总': 0.866, '朝阳片区': 0.908, '京东片区': 0.875, '海淀片区': 0.892, '顺平片区': 0.832, '河北片区': 0.86, '辽宁片区': 0.832 },
    { month: '2026-04', '华北汇总': 0.869, '朝阳片区': 0.91, '京东片区': 0.878, '海淀片区': 0.895, '顺平片区': 0.834, '河北片区': 0.862, '辽宁片区': 0.835 },
    { month: '2026-05', '华北汇总': 0.871, '朝阳片区': 0.912, '京东片区': 0.881, '海淀片区': 0.898, '顺平片区': 0.835, '河北片区': 0.865, '辽宁片区': 0.838 },
    { month: '2026-06', '华北汇总': 0.872, '朝阳片区': 0.915, '京东片区': 0.885, '海淀片区': 0.901, '顺平片区': 0.836, '河北片区': 0.868, '辽宁片区': 0.84 },
  ]

  const insertMany = db.transaction(() => {
    for (const t of trends) insertTrend.run(t)
  })
  insertMany()
}

// ─── 种子项目数据（脱敏演示用）─────────────────────
const projectCount = db.prepare('SELECT COUNT(*) as cnt FROM projects').get() as { cnt: number }

if (projectCount.cnt === 0) {
  const insertProject = db.prepare(`
    INSERT INTO projects (area, name, area_sqm, units, property_type, staff_count,
      annual_income, annual_cost, ytd_income, ytd_cost, receivable, received,
      quality_score, safety_incidents, customer_satisfaction, complaint_count)
    VALUES (@area, @name, @area_sqm, @units, @property_type, @staff_count,
      @annual_income, @annual_cost, @ytd_income, @ytd_cost, @receivable, @received,
      @quality_score, @safety_incidents, @customer_satisfaction, @complaint_count)
  `)

  const projects = [
    { area: '朝阳片区', name: '朝阳万国城MOMΛ', area_sqm: 182000, units: 1680, property_type: '住宅', staff_count: 85,
      annual_income: 3200, annual_cost: 2480, ytd_income: 1850, ytd_cost: 1420, receivable: 1650, received: 1520,
      quality_score: 92, safety_incidents: 0, customer_satisfaction: 88, complaint_count: 12 },
    { area: '朝阳片区', name: '朝阳当代MOMΛ', area_sqm: 145000, units: 1320, property_type: '住宅', staff_count: 68,
      annual_income: 2650, annual_cost: 2050, ytd_income: 1530, ytd_cost: 1180, receivable: 1380, received: 1250,
      quality_score: 89, safety_incidents: 0, customer_satisfaction: 85, complaint_count: 18 },
    { area: '京东片区', name: '通州万国城MOMΛ', area_sqm: 210000, units: 1950, property_type: '住宅', staff_count: 92,
      annual_income: 3800, annual_cost: 2950, ytd_income: 2200, ytd_cost: 1700, receivable: 1950, received: 1780,
      quality_score: 91, safety_incidents: 1, customer_satisfaction: 86, complaint_count: 22 },
    { area: '京东片区', name: '亦庄创意生活广场', area_sqm: 68000, units: 0, property_type: '商业', staff_count: 45,
      annual_income: 1800, annual_cost: 1420, ytd_income: 1050, ytd_cost: 820, receivable: 920, received: 780,
      quality_score: 85, safety_incidents: 0, customer_satisfaction: 82, complaint_count: 8 },
    { area: '海淀片区', name: '海淀西山上品湾MOMΛ', area_sqm: 165000, units: 1520, property_type: '住宅', staff_count: 78,
      annual_income: 2950, annual_cost: 2280, ytd_income: 1700, ytd_cost: 1310, receivable: 1520, received: 1400,
      quality_score: 93, safety_incidents: 0, customer_satisfaction: 90, complaint_count: 6 },
    { area: '海淀片区', name: '上第MOMΛ', area_sqm: 135000, units: 1280, property_type: '住宅', staff_count: 62,
      annual_income: 2480, annual_cost: 1920, ytd_income: 1430, ytd_cost: 1100, receivable: 1280, received: 1160,
      quality_score: 88, safety_incidents: 0, customer_satisfaction: 84, complaint_count: 15 },
    { area: '顺平片区', name: '顺义MOMΛ万万树', area_sqm: 95000, units: 520, property_type: '别墅', staff_count: 48,
      annual_income: 2200, annual_cost: 1750, ytd_income: 1280, ytd_cost: 1010, receivable: 1150, received: 1020,
      quality_score: 90, safety_incidents: 0, customer_satisfaction: 89, complaint_count: 5 },
    { area: '河北片区', name: '石家庄当代府MOMΛ', area_sqm: 128000, units: 1180, property_type: '住宅', staff_count: 58,
      annual_income: 2350, annual_cost: 1820, ytd_income: 1360, ytd_cost: 1050, receivable: 1220, received: 1080,
      quality_score: 86, safety_incidents: 0, customer_satisfaction: 83, complaint_count: 20 },
    { area: '河北片区', name: '天津海河大观', area_sqm: 156000, units: 1420, property_type: '住宅', staff_count: 72,
      annual_income: 2780, annual_cost: 2150, ytd_income: 1610, ytd_cost: 1240, receivable: 1450, received: 1320,
      quality_score: 87, safety_incidents: 1, customer_satisfaction: 84, complaint_count: 16 },
    { area: '辽宁片区', name: '沈阳当代RIVER MOMΛ', area_sqm: 112000, units: 1050, property_type: '住宅', staff_count: 52,
      annual_income: 2050, annual_cost: 1620, ytd_income: 1190, ytd_cost: 930, receivable: 1080, received: 950,
      quality_score: 84, safety_incidents: 0, customer_satisfaction: 81, complaint_count: 24 },
  ]

  const insertMany = db.transaction(() => {
    for (const p of projects) insertProject.run(p)
  })
  insertMany()
}

  console.warn('[db] 已显式启用开发环境业务演示数据；禁止将此数据库发布到生产')
}

console.log('[db] SQLite 初始化完成，数据就绪')

export default db
