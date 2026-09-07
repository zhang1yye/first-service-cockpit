import fs from 'node:fs'
import path from 'node:path'
import db from './db.js'
import { ARREARS_RAW_ROOT, assertArrearsArchiveRoot, controlledArrearsArchiveDir, verifyArrearsArchive } from './arrears-archive.js'

const RAW_ROOT = ARREARS_RAW_ROOT

type ArchiveRow = { id:number; encrypted_archive_dir:string; archive_delete_state:string; archive_deleted_at:string; archive_ledger_sha256:string; archive_communication_sha256:string }
function completeDeletion(row:ArchiveRow, action:string, now:Date):void{
  const archiveDir=controlledArrearsArchiveDir(row.encrypted_archive_dir,true)
  if(row.archive_delete_state!=='pending') db.prepare("UPDATE arrears_upload_batches SET archive_delete_state='pending' WHERE id=? AND archive_delete_state='active'").run(row.id)
  if(fs.existsSync(archiveDir)) fs.rmSync(archiveDir,{recursive:true,force:true})
  db.transaction(()=>{
    db.prepare("UPDATE arrears_upload_batches SET encrypted_archive_dir='',archive_deleted_at=datetime('now','localtime'),archive_delete_state='deleted' WHERE id=? AND archive_delete_state='pending'").run(row.id)
    db.prepare("INSERT INTO operation_logs (username,action,target,detail,ip) VALUES ('system',?,?,?, '')").run(action,`arrears-batch:${row.id}`,JSON.stringify({deletedAt:now.toISOString()}))
  })()
}

export async function reconcileArrearsArchives(now=new Date()):Promise<{orphansDeleted:number;pendingCompleted:number;missingBlocked:number;failed:number}>{
  let orphansDeleted=0,pendingCompleted=0,missingBlocked=0,failed=0
  try{assertArrearsArchiveRoot()}catch{console.warn('[arrears-reconcile-transient] archive_root_unavailable');return{orphansDeleted,pendingCompleted,missingBlocked,failed:1}}
  const known=new Set((db.prepare('SELECT id FROM arrears_upload_batches').all() as Array<{id:number}>).map(row=>String(row.id)))
  let entries:fs.Dirent[]
  try{entries=fs.readdirSync(RAW_ROOT,{withFileTypes:true})}catch{console.warn('[arrears-reconcile-transient] archive_root_unreadable');return{orphansDeleted,pendingCompleted,missingBlocked,failed:1}}
  for(const entry of entries){
    if(!entry.isDirectory())continue
    const candidate=entry.name.startsWith('.staging-') || (/^\d+$/.test(entry.name)&&!known.has(entry.name))
    const ageMs=now.getTime()-fs.statSync(path.join(RAW_ROOT,entry.name)).mtimeMs
    if(candidate && ageMs>60*60*1000){
      try{fs.rmSync(path.join(RAW_ROOT,entry.name),{recursive:true,force:true});orphansDeleted++}catch(error){failed++;console.error(`[arrears-reconcile-orphan:${entry.name}]`,error)}
    }
  }
  const pending=db.prepare("SELECT * FROM arrears_upload_batches WHERE archive_delete_state='pending'").all() as ArchiveRow[]
  for(const row of pending){try{completeDeletion(row,'完成欠费密文归档待删除恢复',now);pendingCompleted++}catch(error){failed++;console.error(`[arrears-reconcile-pending:${row.id}]`,error)}}
  const active=db.prepare("SELECT * FROM arrears_upload_batches WHERE archive_delete_state='active' AND archive_deleted_at='' ").all() as ArchiveRow[]
  for(const row of active){
    try{const integrity=await verifyArrearsArchive(row);if(!integrity.ok){if(integrity.transient){failed++;console.warn(`[arrears-reconcile-transient:${row.id}]`,integrity.code);continue}db.transaction(()=>{db.prepare("UPDATE arrears_upload_batches SET status='blocked',validation_errors=? WHERE id=?").run(JSON.stringify(['密文归档完整性失败，已由对账阻断']),row.id);db.prepare("INSERT INTO operation_logs (username,action,target,detail,ip) VALUES ('system','阻断密文归档完整性失败批次',?,?, '')").run(`arrears-batch:${row.id}`,JSON.stringify({reconciledAt:now.toISOString(),code:integrity.code}))})();missingBlocked++}}catch(error){failed++;console.error(`[arrears-reconcile-active:${row.id}]`,error)}
  }
  return{orphansDeleted,pendingCompleted,missingBlocked,failed}
}

export function purgeExpiredArrearsArchives(now=new Date()):{deleted:number;failed:number}{
  const today=now.toISOString().slice(0,10)
  const rows=db.prepare("SELECT * FROM arrears_upload_batches WHERE archive_deleted_at='' AND (archive_delete_state='pending' OR (archive_delete_state='active' AND retention_until<?))").all(today) as ArchiveRow[]
  let deleted=0,failed=0
  for(const row of rows){try{completeDeletion(row,'清理到期欠费密文归档',now);deleted++}catch(error){failed++;console.error(`[arrears-retention:${row.id}]`,error)}}
  return{deleted,failed}
}

export function startArrearsRetentionJob():void{
  const run=async()=>{const reconcile=await reconcileArrearsArchives(),purge=purgeExpiredArrearsArchives();if(Object.values(reconcile).some(Boolean)||purge.deleted||purge.failed)console.info('[arrears-retention]',{reconcile,purge})}
  void run().catch(error=>console.error('[arrears-retention-job]',error))
  const timer=setInterval(()=>void run().catch(error=>console.error('[arrears-retention-job]',error)),6*60*60*1000);timer.unref()
}
