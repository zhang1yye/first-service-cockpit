#!/usr/bin/env python3
"""Select a bounded, resumable batch of unreconciled historical dates."""

from __future__ import annotations

import argparse
import json
import sqlite3
from datetime import datetime
from decimal import Decimal, InvalidOperation

DAILY_REPORT_ID = "810ca5a0-b239-466b-85c2-386373244c8e"
VALID_SNAPSHOT_CARDINALITIES = (56, 59, 61)
TOTAL_MATCH_TOLERANCE = Decimal("0.011")
MAX_CONFIRMABLE_TOTAL_DIFFERENCE = Decimal("0.05")


def _money(value: object) -> Decimal | None:
    try:
        amount = Decimal(str(value))
    except (InvalidOperation, ValueError):
        return None
    if not amount.is_finite():
        return None
    try:
        if amount != amount.quantize(Decimal("0.01")):
            return None
    except InvalidOperation:
        return None
    return amount


def ensure_attempt_table(connection: sqlite3.Connection) -> None:
    connection.execute("""CREATE TABLE IF NOT EXISTS daily_reconciliation_attempts(
        business_date TEXT PRIMARY KEY,attempts INTEGER NOT NULL DEFAULT 0,failure_count INTEGER NOT NULL DEFAULT 0,
        status TEXT NOT NULL DEFAULT 'pending',last_error TEXT NOT NULL DEFAULT '',
        first_attempted_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
        last_attempted_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
        completed_at TEXT NOT NULL DEFAULT '')""")
    columns = {row[1] for row in connection.execute("PRAGMA table_info(daily_reconciliation_attempts)")}
    if "failure_count" not in columns:
        connection.execute("ALTER TABLE daily_reconciliation_attempts ADD COLUMN failure_count INTEGER NOT NULL DEFAULT 0")
    connection.commit()


def record_attempt(connection: sqlite3.Connection, business_date: str, status: str, error: str, max_attempts: int) -> None:
    if status not in ("failed", "succeeded"):
        raise ValueError("status must be failed or succeeded")
    ensure_attempt_table(connection)
    current = connection.execute("SELECT attempts,failure_count FROM daily_reconciliation_attempts WHERE business_date=?", (business_date,)).fetchone()
    attempts = int(current[0]) if current else 0
    failures = int(current[1]) if current else 0
    attempts += 1
    failures += 1 if status == "failed" else 0
    stored_status = "quarantined" if status == "failed" and failures >= max_attempts else status
    connection.execute("""INSERT INTO daily_reconciliation_attempts
      (business_date,attempts,failure_count,status,last_error,last_attempted_at,completed_at) VALUES(?,?,?,?,?,datetime('now','localtime'),?)
      ON CONFLICT(business_date) DO UPDATE SET attempts=excluded.attempts,failure_count=excluded.failure_count,status=excluded.status,
        last_error=excluded.last_error,last_attempted_at=excluded.last_attempted_at,completed_at=excluded.completed_at""",
      (business_date, attempts, failures, stored_status, error[:2000], "" if status == "failed" else datetime.now().astimezone().isoformat()))
    connection.commit()


def manual_review_dates(connection: sqlite3.Connection) -> list[dict[str, object]]:
    try:
        rows = connection.execute("SELECT business_date,attempts,last_error FROM daily_reconciliation_attempts WHERE status='quarantined' ORDER BY business_date").fetchall()
    except sqlite3.OperationalError:
        return []
    return [{"businessDate": row[0], "attempts": int(row[1]), "lastError": row[2]} for row in rows]


def _published_heads(connection: sqlite3.Connection, business_date: str) -> list[sqlite3.Row]:
    connection.row_factory = sqlite3.Row
    return connection.execute(
        """SELECT current.* FROM daily_collection_reconciliations current
           WHERE current.business_date=? AND current.status='published'
             AND NOT EXISTS (
               SELECT 1 FROM daily_collection_reconciliations successor
               WHERE successor.business_date=current.business_date
                 AND successor.status='published' AND successor.supersedes_id=current.id)
           ORDER BY current.id""",
        (business_date,),
    ).fetchall()


def _valid_daily_only(connection: sqlite3.Connection, head: sqlite3.Row) -> bool:
    if head["publication_mode"] != "daily_only" or head["report_id"] != DAILY_REPORT_ID:
        return False
    if int(head["source_row_count"]) != 61:
        return False
    status = connection.execute(
        """SELECT COUNT(*) revision_count,COUNT(DISTINCT revision.center) center_count,
                  SUM(revision.new_daily_collection) revision_total,
                  SUM(CASE WHEN payment.center IS NULL THEN 1 ELSE 0 END) unknown_centers,
                  SUM(CASE WHEN revision.old_daily_collection IS NOT NULL
                    OR revision.old_cumulative_budget IS NOT NULL OR revision.old_cumulative_executed IS NOT NULL
                    OR revision.old_last_validated_at IS NOT NULL OR revision.old_field_provenance IS NOT '{}'
                    THEN 1 ELSE 0 END) invalid_lineage
           FROM daily_collection_revision_rows revision
           LEFT JOIN payment_centers payment ON payment.center=revision.center
           WHERE revision.reconciliation_id=?""",
        (head["id"],),
    ).fetchone()
    return (
        int(status["revision_count"]) == 56
        and int(status["center_count"]) == 56
        and int(status["unknown_centers"] or 0) == 0
        and int(status["invalid_lineage"] or 0) == 0
        and abs(float(status["revision_total"] or 0) - float(head["detail_total"])) <= 0.011
    )


def _valid_snapshot_revision(connection: sqlite3.Connection, business_date: str, head: sqlite3.Row) -> bool:
    if head["publication_mode"] != "snapshot_revision" or head["report_id"] != DAILY_REPORT_ID or int(head["source_row_count"]) != 61:
        return False
    snapshot_count = connection.execute(
        "SELECT COUNT(*) FROM daily_snapshots WHERE date=?", (business_date,)
    ).fetchone()[0]
    if int(snapshot_count) != 56:
        return False
    status = connection.execute(
        """SELECT COUNT(revision.id) revision_count,COUNT(snapshot.id) snapshot_count,
                  SUM(CASE WHEN snapshot.id IS NULL
                    OR snapshot.daily_collection IS NOT revision.new_daily_collection
                    OR snapshot.cumulative_budget IS NOT revision.old_cumulative_budget
                    OR snapshot.cumulative_executed IS NOT revision.old_cumulative_executed
                    OR snapshot.quality_status IS NOT 'verified'
                    OR snapshot.source_status IS NOT 'available'
                    OR snapshot.business_date IS NOT snapshot.date
                    OR snapshot.last_validated_at IS NOT ? THEN 1
                    WHEN json_valid(COALESCE(snapshot.field_provenance,'')) <> 1 THEN 1
                    WHEN json_extract(snapshot.field_provenance,'$.daily_collection.reportId') IS NOT ?
                      OR json_extract(snapshot.field_provenance,'$.daily_collection.businessDate') IS NOT ?
                      OR json_extract(snapshot.field_provenance,'$.daily_collection.extractedAt') IS NOT ?
                      OR json_extract(snapshot.field_provenance,'$.daily_collection.dailyReconciliationId') IS NOT ?
                    THEN 1 ELSE 0 END) mismatches
           FROM daily_collection_revision_rows revision
           LEFT JOIN daily_snapshots snapshot ON snapshot.date=? AND snapshot.center=revision.center
           WHERE revision.reconciliation_id=?""",
        (
            head["extracted_at"], head["report_id"], business_date,
            head["extracted_at"], head["id"], business_date, head["id"],
        ),
    ).fetchone()
    return int(status["revision_count"]) == 56 and int(status["snapshot_count"]) == 56 and int(status["mismatches"] or 0) == 0


def has_current_published(connection: sqlite3.Connection, business_date: str) -> bool:
    heads = _published_heads(connection, business_date)
    if len(heads) != 1:
        return False
    head = heads[0]
    official_total = _money(head["official_total"])
    detail_total = _money(head["detail_total"])
    if official_total is None or detail_total is None:
        return False
    total_difference = abs(official_total - detail_total)
    if total_difference > MAX_CONFIRMABLE_TOTAL_DIFFERENCE:
        return False
    difference_confirmed = int(head["total_difference_confirmed"] or 0) if "total_difference_confirmed" in head.keys() else 0
    if total_difference > TOTAL_MATCH_TOLERANCE and difference_confirmed != 1:
        return False
    if float(head["detail_total"]) == 0 and int(head["zero_value_confirmed"]) != 1:
        return False
    return _valid_daily_only(connection, head) or _valid_snapshot_revision(connection, business_date, head)


def eligible_dates(connection: sqlite3.Connection, start_date: str) -> list[str]:
    return [row[0] for row in connection.execute(
        """SELECT date FROM daily_snapshots
           WHERE date>=? AND date<date('now','localtime')
           GROUP BY date HAVING COUNT(*) IN (56,59,61)
           ORDER BY date ASC""",
        (start_date,),
    )]


def backfill_completion_status(connection: sqlite3.Connection, attempts_connection: sqlite3.Connection,
                               start_date: str) -> dict[str, object]:
    targets = eligible_dates(connection, start_date)
    target_set = set(targets)
    valid_dates = {business_date for business_date in targets if has_current_published(connection, business_date)}
    manual = [row for row in manual_review_dates(attempts_connection)
              if row["businessDate"] in target_set and row["businessDate"] not in valid_dates]
    quarantined_dates = {row["businessDate"] for row in manual}
    pending_dates = [business_date for business_date in targets
                     if business_date not in quarantined_dates and business_date not in valid_dates]
    counts = {
        "eligibleTotal": len(targets),
        "eligiblePending": len(pending_dates),
        "quarantined": len(quarantined_dates),
        "validPublishedHeads": len(valid_dates),
    }
    return {
        "ok": counts["eligiblePending"] == 0 and counts["quarantined"] == 0 and counts["validPublishedHeads"] == counts["eligibleTotal"],
        "mode": "backfill",
        "completed": counts["eligiblePending"] == 0 and counts["quarantined"] == 0 and counts["validPublishedHeads"] == counts["eligibleTotal"],
        **counts,
        "counts": counts,
        "pendingDates": pending_dates,
        "manualReview": manual,
    }


def select_candidates(connection: sqlite3.Connection, start_date: str, batch_size: int, max_attempts: int = 3,
                      attempts_connection: sqlite3.Connection | None = None) -> list[str]:
    if batch_size < 1 or batch_size > 64:
        raise ValueError("batch_size must be between 1 and 64")
    dates = eligible_dates(connection, start_date)
    try:
        excluded = {row[0] for row in (attempts_connection or connection).execute(
            "SELECT business_date FROM daily_reconciliation_attempts WHERE status='quarantined'")}
    except sqlite3.OperationalError:
        excluded = set()
    pending = [business_date for business_date in dates if business_date not in excluded and not has_current_published(connection, business_date)]
    return pending[:batch_size]


def select_latest_formal_candidate(connection: sqlite3.Connection, before_date: str,
                                   attempts_connection: sqlite3.Connection | None = None) -> list[str]:
    row = connection.execute(
        """SELECT batch.business_date
           FROM data_ingestion_batches batch
           JOIN data_ingestion_publications publication ON publication.batch_id=batch.id
           WHERE batch.business_date<? AND batch.status='published'
             AND length(batch.batch_sha256)=64 AND COALESCE(batch.published_at,'')<>''
             AND publication.business_date=batch.business_date
             AND length(publication.backup_sha256)=64
             AND COALESCE(publication.published_at,'')<>''
             AND publication.payment_rows>0
             AND publication.snapshot_rows=publication.payment_rows
             AND publication.collection_rows=35
             AND (SELECT COUNT(*) FROM data_ingestion_rows row
                  WHERE row.batch_id=batch.id AND row.entity_type='payment_center')=publication.payment_rows
             AND (SELECT COUNT(*) FROM data_ingestion_rows row
                  WHERE row.batch_id=batch.id AND row.entity_type='daily_snapshot')=publication.snapshot_rows
             AND (SELECT COUNT(*) FROM data_ingestion_rows row
                  WHERE row.batch_id=batch.id AND row.entity_type='collection_center')=publication.collection_rows
           ORDER BY batch.business_date DESC,datetime(batch.published_at) DESC,batch.id DESC
           LIMIT 1""",
        (before_date,),
    ).fetchone()
    if not row:
        return []
    business_date = row[0]
    if has_current_published(connection, business_date):
        return []
    try:
        quarantined = (attempts_connection or connection).execute(
            "SELECT 1 FROM daily_reconciliation_attempts WHERE business_date=? AND status='quarantined'",
            (business_date,),
        ).fetchone()
    except sqlite3.OperationalError:
        quarantined = None
    return [] if quarantined else [business_date]


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("database")
    parser.add_argument("--start-date", default="2026-06-15")
    parser.add_argument("--batch-size", type=int, required=True)
    parser.add_argument("--max-attempts", type=int, default=3)
    parser.add_argument("--record-result", choices=("failed", "succeeded"))
    parser.add_argument("--business-date")
    parser.add_argument("--error", default="")
    parser.add_argument("--manual-review", action="store_true")
    parser.add_argument("--completion-status", action="store_true")
    parser.add_argument("--latest-formal-before")
    parser.add_argument("--state-database")
    args = parser.parse_args()
    connection = sqlite3.connect(f"file:{args.database}?mode=ro", uri=True)
    state = sqlite3.connect(args.state_database or args.database)
    try:
        if args.record_result:
            if not args.business_date:
                parser.error("--business-date is required with --record-result")
            record_attempt(state, args.business_date, args.record_result, args.error, args.max_attempts)
        elif args.manual_review:
            print(json.dumps(manual_review_dates(state), ensure_ascii=False))
        elif args.completion_status:
            ensure_attempt_table(state)
            print(json.dumps(backfill_completion_status(connection, state, args.start_date), ensure_ascii=False, separators=(",", ":")))
        elif args.latest_formal_before:
            ensure_attempt_table(state)
            for date in select_latest_formal_candidate(connection, args.latest_formal_before, state):
                print(date)
        else:
            ensure_attempt_table(state)
            for date in select_candidates(connection, args.start_date, args.batch_size, args.max_attempts, state):
                print(date)
    finally:
        connection.close()
        state.close()


if __name__ == "__main__":
    main()
