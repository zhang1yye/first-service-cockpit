#!/usr/bin/env python3
"""Rollback the R160 mode column after daily-only rows are removed/reverted."""

from __future__ import annotations

import argparse
import sqlite3
import sys


def rollback(database_path: str) -> None:
    connection = sqlite3.connect(database_path)
    try:
        columns = {row[1] for row in connection.execute("PRAGMA table_info(daily_collection_reconciliations)")}
        if "publication_mode" not in columns:
            return
        daily_only = connection.execute(
            "SELECT COUNT(*) FROM daily_collection_reconciliations WHERE publication_mode='daily_only'"
        ).fetchone()[0]
        if daily_only:
            raise RuntimeError(f"refusing rollback: {daily_only} daily_only reconciliation rows still exist")
        connection.execute("BEGIN IMMEDIATE")
        connection.execute("ALTER TABLE daily_collection_reconciliations DROP COLUMN publication_mode")
        connection.commit()
    except Exception:
        connection.rollback()
        raise
    finally:
        connection.close()


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("database")
    args = parser.parse_args()
    try:
        rollback(args.database)
    except Exception as error:
        print(str(error), file=sys.stderr)
        raise SystemExit(1)


if __name__ == "__main__":
    main()
