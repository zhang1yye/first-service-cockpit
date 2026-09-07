/**
 * P46 正式发布回执门禁。
 *
 * `data_ingestion_batches.status='published'` 只是批次状态；正式发布事务还必须原子写入
 * `data_ingestion_publications`。消费端同时核对业务日期、备份哈希和三类行数，避免仅改
 * 批次状态或残缺回执的记录进入项目目录、趋势和经营归档。
 */
import { OFFICIAL_COLLECTION_CENTER_COUNT } from './collection-quality.js'

export function formalP46PublicationPredicate(batchAlias: string): string {
  if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(batchAlias)) throw new Error('P46批次SQL别名无效')
  return `EXISTS (
    SELECT 1 FROM data_ingestion_publications publication
    WHERE publication.batch_id=${batchAlias}.id
      AND publication.business_date=${batchAlias}.business_date
      AND length(publication.backup_sha256)=64
      AND COALESCE(publication.published_at,'')<>''
      AND publication.payment_rows>0
      AND publication.collection_rows=${OFFICIAL_COLLECTION_CENTER_COUNT}
      AND publication.payment_rows=(SELECT COUNT(*) FROM data_ingestion_rows payment_rows
        WHERE payment_rows.batch_id=${batchAlias}.id AND payment_rows.entity_type='payment_center')
      AND publication.snapshot_rows=(SELECT COUNT(*) FROM data_ingestion_rows snapshot_rows
        WHERE snapshot_rows.batch_id=${batchAlias}.id AND snapshot_rows.entity_type='daily_snapshot')
      AND publication.collection_rows=(SELECT COUNT(*) FROM data_ingestion_rows collection_rows
        WHERE collection_rows.batch_id=${batchAlias}.id AND collection_rows.entity_type='collection_center')
  )`
}
