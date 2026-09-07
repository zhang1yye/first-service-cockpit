import type Database from 'better-sqlite3'
import { publishedBatchDailyConflict } from './daily-cross-field-conflict.js'
import { hasCurrentPublishedDailyReconciliation } from './daily-reconciliation.js'
import { formalP46PublicationPredicate } from './formal-p46-publication.js'

export function unresolvedPublishedDailyConflict(database: Database.Database, businessDate: string): string | null {
  const formalPublication = formalP46PublicationPredicate('batch')
  const batch = database.prepare(`SELECT batch.id,batch.summary FROM data_ingestion_batches batch
    WHERE batch.business_date=? AND batch.status='published'
      AND length(batch.batch_sha256)=64 AND COALESCE(batch.published_at,'')<>''
      AND ${formalPublication}
    ORDER BY id DESC LIMIT 1`).get(businessDate) as { id: number; summary: string } | undefined
  const conflict = publishedBatchDailyConflict(batch)
  return conflict && !hasCurrentPublishedDailyReconciliation(database, businessDate) ? conflict : null
}
