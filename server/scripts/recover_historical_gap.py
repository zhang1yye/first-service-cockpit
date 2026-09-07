#!/usr/bin/env python3
"""Recover one missing historical P46 day without replacing current live tables/files."""
import argparse
import datetime as dt
import hashlib
import json
import os
import pathlib
import shutil
import sqlite3
import sys

REPORT_ID = "810ca5a0-b239-466b-85c2-386373244c8e"
REPORT_REGION = "华北地区"
CONFIRMATION = "确认补发历史缺口并保留当前数据"
MERGE_GROUPS = [
    (["第一服务北京满庭芳园服务中心", "第一服务北京青云大厦服务中心"], "第一服务满庭青云服务中心"),
    (["第一服务北京西山上品湾MOMΛ服务中心", "第一服务北京西山上品湾二期MOMΛ服务中心"], "第一服务北京西山上品湾MOMΛ服务中心"),
    (["第一服务北京上第MOMΛ服务中心", "第一服务北京IMOMΛ服务中心", "第一服务北京悦MOMΛ服务中心"], "第一服务北京上第MOMΛ服务中心"),
    (["第一服务北京MOMΛ万万树服务中心一期", "第一服务北京MOMΛ万万树服务中心二期"], "第一服务北京MOMΛ万万树服务中心"),
]


def sha256(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def parse_time(value):
    parsed = dt.datetime.fromisoformat(str(value).replace("Z", "+00:00"))
    return parsed if parsed.tzinfo else parsed.replace(tzinfo=dt.timezone(dt.timedelta(hours=8)))


def javascript_json(value):
    """Match JSON.stringify for the finite business-number shapes used by source rows."""
    if isinstance(value, float) and value.is_integer():
        return int(value)
    if isinstance(value, list):
        return [javascript_json(item) for item in value]
    if isinstance(value, dict):
        return {key: javascript_json(item) for key, item in value.items()}
    return value


def table_fingerprint(database, table):
    columns = [row[1] for row in database.execute(f"PRAGMA table_info({table})")]
    if not columns or table not in {"payment_centers", "collection_centers"}:
        raise ValueError("当前事实表指纹配置无效")
    rows = database.execute(f"SELECT * FROM {table} ORDER BY id").fetchall()
    return hashlib.sha256(json.dumps(rows, ensure_ascii=False, separators=(",", ":")).encode()).hexdigest()


def canonical_daily(payload):
    if payload.get("schemaVersion") != 1 or payload.get("reportId") != REPORT_ID or payload.get("region") != REPORT_REGION:
        raise ValueError("日报不是受控华北回款日报")
    rows = payload.get("rows")
    if not isinstance(rows, list) or len(rows) != 61:
        raise ValueError("官方日报必须为61条源记录")
    values = {}
    for row in rows:
        center, value = str(row.get("center", "")).strip(), row.get("dailyCollection")
        if not center or center in values or not isinstance(value, (int, float)):
            raise ValueError("官方日报存在空中心、重复中心或非法金额")
        values[center] = round(float(value), 2)
    for sources, target in MERGE_GROUPS:
        if any(source not in values for source in sources):
            raise ValueError(f"官方日报合并组不完整: {target}")
        merged = round(sum(values.pop(source) for source in sources), 2)
        values[target] = merged
    if len(values) != 56:
        raise ValueError(f"官方日报规范中心应为56条，实际{len(values)}条")
    return values


def validate(database, date, stage_dir, daily_report_path):
    if not __import__("re").fullmatch(r"\d{4}-\d{2}-\d{2}", date):
        raise ValueError("业务日期格式无效")
    stage = pathlib.Path(stage_dir).resolve(strict=True)
    if stage.is_symlink() or not stage.is_dir() or stage.parent.name != ".daily-stage" or not stage.name.startswith(date.replace("-", "")):
        raise ValueError("影子目录不在受控.daily-stage下或与业务日期不匹配")
    normalized_path = stage / f"p46-normalized-{date}.json"
    source_paths = {
        "aph": stage / "data" / f"APH决策_每日提取_{date}.json",
        "paymentDetail": stage / "data" / f"回款额明细_{date}.json",
        "lvzai": stage / "data" / f"收款统计_API_{date}.json",
        "collectionDetail": stage / "data" / f"绿仔收缴明细_{date}.json",
        "collectionSummary": stage / "data" / f"绿仔收款汇总_{date}.json",
    }
    detail_path, summary_path = source_paths["collectionDetail"], source_paths["collectionSummary"]
    backfill_detail_path = stage / "绿仔收缴明细.json"
    report_path = pathlib.Path(daily_report_path).resolve(strict=True)
    if report_path.parent != stage / "data":
        raise ValueError("次日官方日报复核文件不在影子目录data下")
    evidence_paths = [normalized_path, *source_paths.values(), backfill_detail_path, report_path]
    for path in evidence_paths:
        if path.is_symlink() or not path.is_file():
            raise ValueError(f"恢复证据不是常规文件: {path}")
    bundle = json.loads(normalized_path.read_text())
    detail = json.loads(detail_path.read_text())
    summary = json.loads(summary_path.read_text())
    report = json.loads(report_path.read_text())
    if bundle.get("schema_version") != 2 or bundle.get("business_date") != date:
        raise ValueError("规范化包版本或业务日期无效")
    claims = {item.get("key"): item for item in bundle.get("sources", []) if isinstance(item, dict)}
    if set(claims) != set(source_paths):
        raise ValueError("规范化包五源清单不完整")
    for key, path in source_paths.items():
        if claims[key].get("sha256") != sha256(path) or claims[key].get("size") != path.stat().st_size:
            raise ValueError(f"规范化包源文件{key}哈希或大小不一致")
    if sha256(backfill_detail_path) != claims["collectionDetail"].get("sha256"):
        raise ValueError("绿仔历史补录入口与规范化包哈希不一致")
    if detail.get("date") != date or detail.get("businessDate") != date or summary.get("date") != date:
        raise ValueError("绿仔历史截止日与恢复日期不一致")
    aph_time = parse_time(bundle.get("extracted_at"))
    collection_time = parse_time(detail.get("extractedAt"))
    if aph_time.date().isoformat() != date or collection_time < aph_time:
        raise ValueError("APH或绿仔提取时间顺序无效")
    if report.get("businessDate") != date or parse_time(report.get("extractedAt")) <= aph_time:
        raise ValueError("次日官方日报复核日期或时间无效")
    payment, snapshots, collections = bundle.get("payment_centers"), bundle.get("daily_snapshots"), bundle.get("collection_centers")
    if not isinstance(payment, list) or len(payment) != 56 or not isinstance(snapshots, list) or len(snapshots) != 56:
        raise ValueError("APH恢复证据必须包含56个中心和56条快照")
    if not isinstance(collections, list) or len(collections) != 35 or detail.get("rows") != collections:
        raise ValueError("绿仔恢复证据必须与35条归档明细逐字段一致")
    official = canonical_daily(report)
    snapshot_by_center = {row.get("center"): row for row in snapshots}
    payment_centers = {row.get("center") for row in payment}
    if len(snapshot_by_center) != 56 or set(snapshot_by_center) != payment_centers or set(official) != payment_centers:
        raise ValueError("三类恢复证据的规范中心集合不一致")
    for center, row in snapshot_by_center.items():
        if row.get("date") != date or row.get("business_date") != date or row.get("quality_status") != "verified" or row.get("source_status") != "available":
            raise ValueError(f"快照质量或日期无效: {center}")
        if abs(float(row.get("daily_collection")) - official[center]) > 0.001:
            raise ValueError(f"次日官方日报与原始日回款不一致: {center}")
        provenance = row.get("field_provenance")
        if isinstance(provenance, str):
            provenance = json.loads(provenance)
        if not isinstance(provenance, dict) or any(key not in provenance for key in ("annual_budget", "cumulative_budget", "cumulative_executed", "daily_collection")):
            raise ValueError(f"快照字段血缘不完整: {center}")
    current = {row[0] for row in database.execute("SELECT center FROM payment_centers")}
    if current != payment_centers:
        raise ValueError("当前中心集合与历史恢复证据不一致")
    if database.execute("SELECT COUNT(*) FROM daily_snapshots WHERE date=?", (date,)).fetchone()[0] != 0:
        raise ValueError("目标日期已存在快照，禁止覆盖")
    if database.execute("SELECT COUNT(*) FROM data_ingestion_batches WHERE business_date=? AND status='published'", (date,)).fetchone()[0] != 0:
        raise ValueError("目标日期已有正式P46批次，禁止恢复")
    latest = database.execute("SELECT MAX(business_date) FROM data_ingestion_batches WHERE status='published'").fetchone()[0]
    if not latest or latest <= date:
        raise ValueError("当前正式业务日必须晚于恢复日")
    previous = (dt.date.fromisoformat(date) - dt.timedelta(days=1)).isoformat()
    baseline = {row[0]: row[1] for row in database.execute("SELECT center,cumulative_executed FROM daily_snapshots WHERE date=? AND quality_status='verified'", (previous,))}
    if len(baseline) != 56 or set(baseline) != payment_centers:
        raise ValueError("恢复日前一日缺少56条可信基线")
    detail_total = round(sum(official.values()), 2)
    official_total = round(float(report.get("officialTotal")), 2)
    if abs(official_total - detail_total) > 0.05:
        raise ValueError("官方汇总与明细差异超过0.05万元")
    return {
        "bundle": bundle, "detail": detail, "report": report, "official": official,
        "paths": evidence_paths,
        "aphExtractedAt": bundle["extracted_at"], "collectionExtractedAt": detail["extractedAt"],
        "officialTotal": official_total, "detailTotal": detail_total, "latestBusinessDate": latest,
        "currentPaymentFingerprint": table_fingerprint(database, "payment_centers"),
        "currentCollectionFingerprint": table_fingerprint(database, "collection_centers"),
    }


def publish(database, date, evidence, archive_root, actor, note):
    if len(note.strip()) < 20:
        raise ValueError("恢复审计说明至少20个字符")
    archive = pathlib.Path(archive_root).resolve() / date
    digest = hashlib.sha256("".join(sha256(path) for path in evidence["paths"]).encode()).hexdigest()
    archive = archive / digest[:16]
    archive.mkdir(parents=True, exist_ok=True, mode=0o750)
    archived = {}
    for source in evidence["paths"]:
        target = archive / source.name
        if target.exists() and sha256(target) != sha256(source):
            raise ValueError("恢复归档目标哈希冲突")
        if not target.exists():
            shutil.copyfile(source, target)
        target.chmod(0o640)
        archived[source.name] = {"path": str(target), "sha256": sha256(target)}
    bundle, official, report = evidence["bundle"], evidence["official"], evidence["report"]
    normalized_sha = archived[f"p46-normalized-{date}.json"]["sha256"]
    detail_archive = archived["绿仔收缴明细.json"]
    with database:
        # Recheck fail-closed invariants inside the write transaction.
        if table_fingerprint(database, "payment_centers") != evidence["currentPaymentFingerprint"] or table_fingerprint(database, "collection_centers") != evidence["currentCollectionFingerprint"]:
            raise ValueError("预览后当前经营事实已变化，禁止补发")
        if database.execute("SELECT COUNT(*) FROM daily_snapshots WHERE date=?", (date,)).fetchone()[0]:
            raise ValueError("发布前目标日期已出现快照")
        result = database.execute("""INSERT INTO daily_collection_reconciliations
          (business_date,extracted_at,report_id,region,official_total,detail_total,source_row_count,publication_mode,
           payload_sha256,business_payload_sha256,status,validation_errors,created_by,published_by,published_at,confirm_note)
          VALUES(?,?,?,?,?,?,61,'snapshot_revision',?,?, 'published','[]',?,?,datetime('now','localtime'),?)""",
          (date, report["extractedAt"], REPORT_ID, REPORT_REGION, evidence["officialTotal"], evidence["detailTotal"],
           archived[pathlib.Path(evidence["paths"][-1]).name]["sha256"], archived[pathlib.Path(evidence["paths"][-1]).name]["sha256"], actor, actor, note))
        reconciliation_id = result.lastrowid
        insert_snapshot = database.cursor()
        insert_revision = database.cursor()
        for row in bundle["daily_snapshots"]:
            center = row["center"]
            provenance = row["field_provenance"] if isinstance(row["field_provenance"], dict) else json.loads(row["field_provenance"])
            provenance["daily_collection"] = {"source": "FineReport回款日报历史专项复核", "reportId": REPORT_ID, "businessDate": date, "extractedAt": report["extractedAt"], "dailyReconciliationId": reconciliation_id}
            provenance["historicalRecovery"] = {"normalizedSha256": normalized_sha, "aphExtractedAt": evidence["aphExtractedAt"], "collectionExtractedAt": evidence["collectionExtractedAt"], "recoveredWithoutReplacingCurrentFacts": True}
            insert_snapshot.execute("""INSERT INTO daily_snapshots
              (date,center,annual_budget,cumulative_budget,cumulative_executed,daily_collection,quality_status,quality_reason,source,source_status,business_date,last_validated_at,field_provenance)
              VALUES(?,?,?,?,?,?,'verified','',?,'available',?,?,?)""",
              (date, center, row["annual_budget"], row["cumulative_budget"], row["cumulative_executed"], official[center], row.get("source") or "FineReport三报表中心明细", date, report["extractedAt"], json.dumps(provenance, ensure_ascii=False, separators=(",", ":"))))
            insert_revision.execute("""INSERT INTO daily_collection_revision_rows
              (reconciliation_id,center,old_daily_collection,new_daily_collection,old_cumulative_budget,old_cumulative_executed,old_last_validated_at,old_field_provenance)
              VALUES(?,?,?,?,?,?,?,?)""", (reconciliation_id, center, row["daily_collection"], official[center], row["cumulative_budget"], row["cumulative_executed"], row.get("last_validated_at"), json.dumps(row["field_provenance"], ensure_ascii=False) if isinstance(row["field_provenance"], dict) else row["field_provenance"]))
        database.execute("""INSERT INTO collection_trend_backfills
          (business_date,extracted_at,source_file_name,archive_path,source_sha256,row_count,payload,validation_errors,status,created_by,published_by,published_at,confirm_note)
          VALUES(?,?,?,?,?,35,?,'[]','published',?,?,datetime('now','localtime'),?)""",
          (date, evidence["collectionExtractedAt"], "绿仔收缴明细.json", detail_archive["path"], detail_archive["sha256"], json.dumps(javascript_json(evidence["detail"]["rows"]), ensure_ascii=False, separators=(",", ":")), actor, actor, note))
        detail = {"businessDate": date, "normalizedSha256": normalized_sha, "dailyReconciliationId": reconciliation_id,
                  "archive": str(archive), "currentBusinessDatePreserved": evidence["latestBusinessDate"], "confirmNote": note}
        database.execute("INSERT INTO operation_logs(username,action,target,detail,ip) VALUES(?,?,?,?,?)",
                         (actor, "受控补发历史经营数据缺口", f"historical_gap:{date}", json.dumps(detail, ensure_ascii=False), "local-cli"))
        if database.execute("SELECT COUNT(*) FROM daily_snapshots WHERE date=?", (date,)).fetchone()[0] != 56:
            raise ValueError("恢复后快照行数不是56")
        if table_fingerprint(database, "payment_centers") != evidence["currentPaymentFingerprint"] or table_fingerprint(database, "collection_centers") != evidence["currentCollectionFingerprint"]:
            raise ValueError("补发过程改变了当前经营事实，事务已回滚")
    return {"ok": True, "businessDate": date, "snapshotRows": 56, "collectionRows": 35, "dailyReconciliationId": reconciliation_id, "archive": str(archive), "latestBusinessDatePreserved": evidence["latestBusinessDate"]}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--date", required=True)
    parser.add_argument("--db", required=True)
    parser.add_argument("--stage-dir", required=True)
    parser.add_argument("--daily-report", required=True)
    parser.add_argument("--archive-root", required=True)
    parser.add_argument("--actor", default="zhangye")
    parser.add_argument("--confirm-note", default="")
    parser.add_argument("--confirmation", default="")
    parser.add_argument("--publish", action="store_true")
    args = parser.parse_args()
    database = sqlite3.connect(args.db)
    evidence = validate(database, args.date, args.stage_dir, args.daily_report)
    preview = {key: evidence[key] for key in ("aphExtractedAt", "collectionExtractedAt", "officialTotal", "detailTotal", "latestBusinessDate")}
    preview.update({"ok": True, "mode": "preview", "businessDate": args.date, "snapshotRows": 56, "collectionRows": 35})
    if not args.publish:
        print(json.dumps(preview, ensure_ascii=False)); return
    if args.confirmation != CONFIRMATION:
        raise ValueError(f"发布必须输入确认短语：{CONFIRMATION}")
    backup = pathlib.Path(args.archive_root).resolve() / args.date / f"cockpit-before-{dt.datetime.now().strftime('%Y%m%d-%H%M%S')}.sqlite"
    backup.parent.mkdir(parents=True, exist_ok=True)
    target = sqlite3.connect(str(backup)); database.backup(target); target.close(); backup.chmod(0o600)
    result = publish(database, args.date, evidence, args.archive_root, args.actor, args.confirm_note)
    result["backup"] = str(backup)
    print(json.dumps(result, ensure_ascii=False))


if __name__ == "__main__":
    try: main()
    except Exception as error:
        print(json.dumps({"ok": False, "error": str(error)}, ensure_ascii=False), file=sys.stderr)
        sys.exit(1)
