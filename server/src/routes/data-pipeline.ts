import { Router } from 'express'
import multer from 'multer'
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import db from '../db.js'
import { requireAdmin, requireDailyReconciliationAccess } from '../auth.js'
import { logOperation, logOperationStrict } from '../audit.js'
import { analyzeNormalizedBundle, deriveCollectionRowsFromArchive, evaluateCollectionArchiveConsistency, type NormalizedBundle } from '../data-pipeline.js'
import { calculateLiveCollectionContentSha256, parseStrictUtf8Json } from '../collection-quality.js'
import { evaluateBusinessDate } from '../business-date.js'
import { p46FixedEntriesMatch, prepareP46FixedEntryPublication, recoverP46FixedEntryPublication, type P46FixedEntry } from '../p46-fixed-entry-publication.js'
import { previewDailyReconciliation, publishDailyReconciliation } from '../daily-reconciliation.js'
import { loadPublishedP46Evidence } from '../published-p46-evidence.js'

const router=Router()
const upload=multer({dest:'/tmp/cockpit-p46/',limits:{fileSize:15*1024*1024,files:6}})
const fields=[{name:'normalized',maxCount:1},{name:'aph',maxCount:1},{name:'paymentDetail',maxCount:1},{name:'lvzai',maxCount:1},{name:'collectionDetail',maxCount:1},{name:'collectionSummary',maxCount:1}]
const archiveRoot=process.env.COCKPIT_RAW_ARCHIVE_DIR||path.join(process.cwd(),'data','raw')
const sha=(b:Buffer|string)=>crypto.createHash('sha256').update(b).digest('hex')
const actor=(req:any)=>req.user?.username||''
const p46Root=()=>process.env.COCKPIT_ROOT||path.join(process.env.HOME||'/home/ubuntu','cockpit')
recoverP46FixedEntryPublication(db,p46Root())
function files(req:any){return req.files as Record<string,Express.Multer.File[]>}
function cleanup(req:any){for(const xs of Object.values(files(req)||{}))for(const f of xs||[])try{fs.unlinkSync(f.path)}catch{}}
function parseJson(file:Express.Multer.File){return JSON.parse(fs.readFileSync(file.path,'utf8'))}
function batchView(r:any){return{...r,publishable:Boolean(r.publishable),source_files:JSON.parse(r.source_files||'[]'),validation_errors:JSON.parse(r.validation_errors||'[]'),summary:JSON.parse(r.summary||'{}')}}
const requiredArchiveKeys=['normalized','aph','paymentDetail','lvzai','collectionDetail','collectionSummary'] as const
type ArchiveKey=typeof requiredArchiveKeys[number]
type ArchivedSource={key:string;name:string;size:number;sha256:string;path:string}
const safeArchiveName=(key:string,name:string)=>`${key}-${path.basename(name).replace(/[^\w.\-\u4e00-\u9fa5]/g,'_')}`

function dailyComparisonBaseline(businessDate:string){
 const evidence=loadPublishedP46Evidence(db,{beforeDate:businessDate})
 if(!evidence)return null
 return{
  batchId:evidence.batchId,
  rows:evidence.bundle.payment_centers.map(row=>({center:row.center,cumulative_executed:row.cumulative_executed})),
 }
}

function storedRows(batchId:number,entityType:string){
 return (db.prepare('SELECT source_key,canonical_key,payload FROM data_ingestion_rows WHERE batch_id=? AND entity_type=? ORDER BY id').all(batchId,entityType) as any[]).map(row=>({
  source_key:String(row.source_key||''),canonical_key:String(row.canonical_key||''),payload:JSON.parse(row.payload),
 }))
}

function expectedStoredRows(bundle:NormalizedBundle,entityType:string){
 if(entityType==='payment_center')return bundle.payment_centers.map(row=>({source_key:row.center,canonical_key:row.center,payload:row}))
 if(entityType==='daily_snapshot')return bundle.daily_snapshots.map(row=>({source_key:`${row.date}:${row.center}`,canonical_key:row.center,payload:row}))
 return bundle.collection_centers.map(row=>({source_key:row.center,canonical_key:row.center,payload:row}))
}

function revalidateStoredPreview(batch:any){
 const errors:string[]=[]
 let archived:ArchivedSource[]=[]
 try{
  const parsed=JSON.parse(batch.source_files||'[]')
  if(!Array.isArray(parsed))throw new Error('不是数组')
  archived=parsed
 }catch(error:unknown){return{errors:[`六源归档清单无效：${error instanceof Error?error.message:String(error)}`]}}
 const keyCounts=new Map<string,number>()
 for(const file of archived)keyCounts.set(String(file?.key||''),(keyCounts.get(String(file?.key||''))||0)+1)
 const missing=requiredArchiveKeys.filter(key=>keyCounts.get(key)!==1)
 const unexpected=[...keyCounts.keys()].filter(key=>!requiredArchiveKeys.includes(key as ArchiveKey))
 if(archived.length!==requiredArchiveKeys.length||missing.length||unexpected.length){
  errors.push(`六源归档清单必须且只能包含${requiredArchiveKeys.join('、')}；缺失或重复=${missing.join('、')||'无'}；额外=${unexpected.join('、')||'无'}`)
  return{errors}
 }
 const byKey=new Map(archived.map(file=>[file.key,file]))
 const actualFiles:ArchivedSource[]=[]
 const controlledDateDir=path.resolve(archiveRoot,batch.business_date)
 const controlledArchiveDir=path.resolve(String(batch.archive_dir||''))
 if(path.dirname(controlledArchiveDir)!==controlledDateDir||!/^[a-f0-9]{16}$/.test(path.basename(controlledArchiveDir))){
  return{errors:['六源归档目录不在预览受控业务日期目录内']}
 }
 for(const key of requiredArchiveKeys){
  const file=byKey.get(key)!
  if(typeof file.name!=='string'||!file.name||typeof file.path!=='string'||!file.path){errors.push(`源文件${key}归档清单字段不完整`);continue}
  const expectedPath=path.resolve(controlledArchiveDir,safeArchiveName(key,file.name))
  if(path.resolve(file.path)!==expectedPath){errors.push(`源文件${key}归档路径与预览确定性路径不一致`);continue}
  try{
   const stat=fs.lstatSync(file.path)
   if(!stat.isFile()||stat.isSymbolicLink())throw new Error('不是受控普通文件')
   const content=fs.readFileSync(file.path),actualSha=sha(content)
   if(!Number.isSafeInteger(file.size)||file.size!==content.length)errors.push(`源文件${key}归档大小与清单不一致`)
   if(!/^[a-f0-9]{64}$/.test(String(file.sha256||''))||file.sha256!==actualSha)errors.push(`源文件${key}归档SHA与清单不一致`)
   actualFiles.push({...file,size:content.length,sha256:actualSha})
  }catch(error:unknown){errors.push(`源文件${key}归档读取失败：${error instanceof Error?error.message:String(error)}`)}
 }
 if(errors.length)return{errors}
 const recomputedBatchSha=sha(actualFiles.sort((left,right)=>left.key.localeCompare(right.key)).map(file=>file.sha256).join(':'))
 if(!/^[a-f0-9]{64}$/.test(String(batch.batch_sha256||''))||batch.batch_sha256!==recomputedBatchSha)errors.push('六源批次SHA重算值与存量预览批次SHA不一致')
 const expectedArchiveDir=path.resolve(controlledDateDir,recomputedBatchSha.slice(0,16))
 if(path.resolve(String(batch.archive_dir||''))!==expectedArchiveDir)errors.push('六源归档目录与预览确定性目录不一致')
 if(errors.length)return{errors}
 try{
  const normalized=parseStrictUtf8Json(fs.readFileSync(byKey.get('normalized')!.path),'规范化包JSON') as NormalizedBundle
  const aphPayload=parseStrictUtf8Json(fs.readFileSync(byKey.get('aph')!.path),'APH来源JSON') as any
  const collectionDetail=parseStrictUtf8Json(fs.readFileSync(byKey.get('collectionDetail')!.path),'绿仔明细JSON')
  const collectionSummary=parseStrictUtf8Json(fs.readFileSync(byKey.get('collectionSummary')!.path),'绿仔汇总JSON')
  if(normalized.business_date!==batch.business_date)errors.push('规范化包业务日期与存量预览批次不一致')
  if(normalized.extracted_at!==batch.extracted_at)errors.push('规范化包提取时间与存量预览批次不一致')
  const claimedSources=new Map((normalized.sources||[]).map(source=>[source.key,source]))
  const normalizedSourceKeys=(normalized.sources||[]).map(source=>source.key)
  const expectedSourceKeys=requiredArchiveKeys.filter(key=>key!=='normalized')
  if(normalizedSourceKeys.length!==expectedSourceKeys.length||claimedSources.size!==expectedSourceKeys.length||expectedSourceKeys.some(key=>!claimedSources.has(key)))errors.push('规范化包源文件清单键或数量与预览规范不一致')
  for(const actual of actualFiles.filter(file=>file.key!=='normalized')){
   const claimed=claimedSources.get(actual.key)
   if(!claimed||claimed.name!==actual.name||claimed.size!==actual.size||claimed.sha256!==actual.sha256)errors.push(`规范化包源文件${actual.key}证据与六源归档不一致`)
  }
  if(claimedSources.size!==requiredArchiveKeys.length-1)errors.push('规范化包源文件清单数量与六源归档不一致')
  if(normalized.business_date!==aphPayload.businessDate||JSON.stringify(normalized.source_layers||{})!==JSON.stringify(aphPayload.sourceLayers||{})||JSON.stringify(normalized.reconciliations||{})!==JSON.stringify(aphPayload.reconciliations||{}))errors.push('APH来源层或勾稽结果与归档规范化包不一致')
  errors.push(...evaluateCollectionArchiveConsistency(normalized,collectionDetail,collectionSummary))
  const current=db.prepare('SELECT area,center,annual_budget,cumulative_budget,cumulative_executed,same_period,collection_rate FROM payment_centers ORDER BY center').all() as any[]
  const baseline=dailyComparisonBaseline(normalized.business_date)
  const analysis=analyzeNormalizedBundle(normalized,current,{minimumCenters:40,dailyComparisonBaseline:baseline?.rows||[]})
  analysis.dailyReview.baselineBatchId=baseline?.batchId||null
  errors.push(...analysis.errors.map(error=>`规范化包真实性门禁：${error}`))
  if(Number(batch.row_count)!==normalized.payment_centers.length||Number(batch.mapped_count)!==Number(normalized.lvzai?.mapped_regions||0)||Number(batch.unmapped_count)!==Number(normalized.lvzai?.unmapped_centers?.length||0))errors.push('存量预览批次行数或绿仔映射计数与归档规范化包不一致')
  for(const entityType of ['payment_center','daily_snapshot','collection_center']){
   const stored=storedRows(batch.id,entityType),expected=expectedStoredRows(normalized,entityType)
   if(!isDeepStrictEqual(stored,expected))errors.push(`存量预览${entityType}逐行逐字段与归档规范化包不一致`)
  }
  return{errors,bundle:normalized,analysis,collectionRows:deriveCollectionRowsFromArchive(collectionDetail)}
 }catch(error:unknown){return{errors:[...errors,`存量预览归档重验证失败：${error instanceof Error?error.message:String(error)}`]}}
}
function p46FixedEntryDefinitions(batch:any,who:string,publishedAt:string):P46FixedEntry[]{
 const archived=JSON.parse(batch.source_files||'[]') as any[]
 const required=new Map(['aph','collectionDetail','collectionSummary'].map(key=>[key,archived.find(x=>x.key===key)]))
 for(const [key,file] of required){
  if(!file?.path||!fs.existsSync(file.path))throw new Error(`${key}归档源文件不存在，禁止正式发布`)
  const actualSha=sha(fs.readFileSync(file.path))
  if(file.sha256&&file.sha256!==actualSha)throw new Error(`${key}归档源文件SHA与批次证据不一致`)
 }
 const detailContent=fs.readFileSync(required.get('collectionDetail').path)
 const summaryContent=fs.readFileSync(required.get('collectionSummary').path)
 const detail=parseStrictUtf8Json(detailContent,'绿仔明细JSON') as Record<string,unknown>
 const summary=parseStrictUtf8Json(summaryContent,'绿仔汇总JSON') as Record<string,unknown>
 const batchDate=evaluateBusinessDate(batch.business_date,'P46正式批次业务日期')
 const detailDate=evaluateBusinessDate(detail?.date||detail?.businessDate,'绿仔明细业务日期')
 const summaryDate=evaluateBusinessDate(summary?.date||summary?.businessDate,'绿仔汇总业务日期')
 const dateErrors=[...batchDate.reasons,...detailDate.reasons,...summaryDate.reasons]
 if(dateErrors.length)throw new Error(dateErrors.join('；'))
 if(detailDate.date!==batchDate.date||summaryDate.date!==batchDate.date)throw new Error('绿仔明细、汇总业务日期必须与P46正式批次一致')
 const receipt=JSON.stringify({
  schemaVersion:2,ok:true,state:'published',date:batch.business_date,batchId:`p46-${batch.id}`,
  p46BatchSha256:String(batch.batch_sha256||'').toLowerCase(),
  collectionContentSha256:calculateLiveCollectionContentSha256(detailContent,summaryContent),
  publishedBy:who,publishedAt,finishedAt:publishedAt,
  message:'P46受控批次已发布，回执已绑定绿仔明细与汇总原文字节域',
 },null,2)
 const definitions=[
  {targetName:'APH决策_每日提取.json',content:fs.readFileSync(required.get('aph').path)},
  {targetName:'绿仔收缴明细.json',content:detailContent},
  {targetName:'绿仔收款汇总.json',content:summaryContent},
  {targetName:'绿仔同步状态.json',content:Buffer.from(receipt,'utf8')},
  ]
  return definitions
  }
  function prepareP46FixedEntries(batch:any,who:string,publishedAt:string){
  return prepareP46FixedEntryPublication(db,p46Root(),Number(batch.id),p46FixedEntryDefinitions(batch,who,publishedAt))
  }
  function reconcilePublishedP46FixedEntries(batch:any){
  const definitions=p46FixedEntryDefinitions(batch,batch.published_by,batch.published_at)
  if(p46FixedEntriesMatch(p46Root(),definitions))return false
  const fixedEntries=prepareP46FixedEntryPublication(db,p46Root(),Number(batch.id),definitions)
  try{fixedEntries.install();fixedEntries.settle();return true}catch(error){fixedEntries.settle();throw error}
  }

router.post('/api/data-pipeline/preview',requireAdmin,upload.fields(fields),(req,res)=>{
 try{
  const f=files(req);for(const name of ['normalized','aph','paymentDetail','lvzai','collectionDetail','collectionSummary'])if(!f?.[name]?.[0])return res.status(400).json({error:`缺少${name}源文件`})
  const bundle=parseJson(f.normalized[0]) as NormalizedBundle
  const aphPayload=parseJson(f.aph[0]) as any
  const collectionDetail=parseStrictUtf8Json(fs.readFileSync(f.collectionDetail[0].path),'绿仔明细JSON')
  const collectionSummary=parseStrictUtf8Json(fs.readFileSync(f.collectionSummary[0].path),'绿仔汇总JSON')
  const sourceFiles=Object.entries(f).map(([key,v])=>{const file=v[0],buf=fs.readFileSync(file.path);return{key,name:file.originalname,size:buf.length,sha256:sha(buf)}}).sort((a,b)=>a.key.localeCompare(b.key))
  const batchSha=sha(sourceFiles.map(x=>x.sha256).join(':'))
  const current=db.prepare('SELECT area,center,annual_budget,cumulative_budget,cumulative_executed,same_period,collection_rate FROM payment_centers ORDER BY center').all() as any[]
  const baseline=dailyComparisonBaseline(bundle.business_date)
  const analysis=analyzeNormalizedBundle(bundle,current,{minimumCenters:40,dailyComparisonBaseline:baseline?.rows||[]})
  analysis.dailyReview.baselineBatchId=baseline?.batchId||null
  const claimedSources=new Map((bundle.sources||[]).map(x=>[x.key,x]))
  for(const actual of sourceFiles.filter(x=>x.key!=='normalized')){
   const claimed=claimedSources.get(actual.key)
   if(!claimed||claimed.sha256!==actual.sha256||claimed.size!==actual.size)analysis.errors.push(`源文件${actual.key}的SHA或大小与规范化包不一致`)
  }
  if(bundle.business_date!==aphPayload.businessDate||JSON.stringify(bundle.source_layers||{})!==JSON.stringify(aphPayload.sourceLayers||{})||JSON.stringify(bundle.reconciliations||{})!==JSON.stringify(aphPayload.reconciliations||{}))analysis.errors.push('APH来源层或勾稽结果在规范化过程中发生变化')
  analysis.errors.push(...evaluateCollectionArchiveConsistency(bundle,collectionDetail,collectionSummary))
  analysis.publishable=analysis.errors.length===0
  const persistRows=(batchId:number)=>{
   const ins=db.prepare('INSERT INTO data_ingestion_rows(batch_id,entity_type,source_key,canonical_key,mapping_method,change_type,changed_fields,payload) VALUES(?,?,?,?,?,?,?,?)')
   const changes=new Map(analysis.diff.changes.map((x:any)=>[x.center,x]))
   for(const row of bundle.payment_centers){const c:any=changes.get(row.center);ins.run(batchId,'payment_center',row.center,row.center,'exact',c?.type||'unchanged',JSON.stringify(c?.changed_fields||[]),JSON.stringify(row))}
   for(const row of bundle.daily_snapshots)ins.run(batchId,'daily_snapshot',`${row.date}:${row.center}`,row.center,'exact','snapshot',JSON.stringify([]),JSON.stringify(row))
   for(const row of bundle.collection_centers)ins.run(batchId,'collection_center',row.center,row.center,'official-35','snapshot',JSON.stringify([]),JSON.stringify(row))
  }
  const existing=db.prepare('SELECT * FROM data_ingestion_batches WHERE batch_sha256=?').get(batchSha) as any
  if(existing){
   if(existing.status==='published')return res.json({idempotent:true,batch:batchView(existing)})
   db.transaction(()=>{
    db.prepare('DELETE FROM data_ingestion_rows WHERE batch_id=?').run(existing.id)
    db.prepare('UPDATE data_ingestion_batches SET status=?,publishable=?,row_count=?,mapped_count=?,unmapped_count=?,validation_errors=?,summary=? WHERE id=?').run(analysis.publishable?'previewed':'blocked',analysis.publishable?1:0,bundle.payment_centers.length,bundle.lvzai?.mapped_regions||0,bundle.lvzai?.unmapped_centers?.length||0,JSON.stringify(analysis.errors),JSON.stringify(analysis),existing.id)
    persistRows(existing.id)
   })()
   const refreshed=db.prepare('SELECT * FROM data_ingestion_batches WHERE id=?').get(existing.id) as any
   return res.json({idempotent:true,reanalyzed:true,batch:batchView(refreshed)})
  }
  const archiveDir=path.join(archiveRoot,bundle.business_date,batchSha.slice(0,16));fs.mkdirSync(archiveDir,{recursive:true,mode:0o750})
  const archived=sourceFiles.map(meta=>{const file=f[meta.key][0],dest=path.join(archiveDir,safeArchiveName(meta.key,file.originalname));fs.copyFileSync(file.path,dest);fs.chmodSync(dest,0o640);return{...meta,path:dest}})
  let batchId=0
  db.transaction(()=>{
   const r=db.prepare(`INSERT INTO data_ingestion_batches(source_key,business_date,extracted_at,batch_sha256,source_files,archive_dir,status,publishable,row_count,mapped_count,unmapped_count,validation_errors,summary,created_by) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run('aph-finereport-lvzai',bundle.business_date,bundle.extracted_at,batchSha,JSON.stringify(archived),archiveDir,analysis.publishable?'previewed':'blocked',analysis.publishable?1:0,bundle.payment_centers.length,bundle.lvzai?.mapped_regions||0,bundle.lvzai?.unmapped_centers?.length||0,JSON.stringify(analysis.errors),JSON.stringify(analysis),actor(req));batchId=Number(r.lastInsertRowid)
   persistRows(batchId)
  })()
  const batch=db.prepare('SELECT * FROM data_ingestion_batches WHERE id=?').get(batchId) as any
  logOperation(req,'生成真实数据批次预览',`data_ingestion_batch:${batchId}`,{businessDate:bundle.business_date,batchSha,rowCount:bundle.payment_centers.length,publishable:analysis.publishable,errors:analysis.errors})
  res.json({idempotent:false,batch:batchView(batch)})
 }catch(e:any){res.status(400).json({error:`批次预览失败：${e.message}`})}finally{cleanup(req)}
})

router.get('/api/data-pipeline/batches',requireAdmin,(_req,res)=>{
 const rows=(db.prepare('SELECT * FROM data_ingestion_batches ORDER BY id DESC LIMIT 30').all() as any[]).map(batchView)
 res.json({rows})
})
router.get('/api/data-pipeline/batches/:id',requireAdmin,(req,res)=>{
 const batch=db.prepare('SELECT * FROM data_ingestion_batches WHERE id=?').get(req.params.id) as any
 if(!batch)return res.status(404).json({error:'批次不存在'})
 const changes=db.prepare("SELECT entity_type,source_key,canonical_key,mapping_method,change_type,changed_fields FROM data_ingestion_rows WHERE batch_id=? AND change_type!='unchanged' ORDER BY entity_type,source_key LIMIT 200").all(req.params.id) as any[]
 res.json({batch:batchView(batch),changes:changes.map(x=>({...x,changed_fields:JSON.parse(x.changed_fields||'[]')}))})
})

router.post('/api/data-pipeline/daily-reconciliations/preview',requireDailyReconciliationAccess,(req,res)=>{
 try{
  const batch=previewDailyReconciliation(db,req.body,actor(req))
  logOperation(req,'生成历史日报专项复核预览',`daily_collection_reconciliation:${batch.id}`,{
   businessDate:batch.businessDate,officialTotal:batch.officialTotal,detailTotal:batch.detailTotal,
   sourceRowCount:batch.sourceRowCount,publication_mode:batch.publicationMode,zeroValueAudit:batch.zeroValueAudit,
   totalDifference:batch.totalDifference,totalDifferenceAudit:batch.totalDifferenceAudit,
   publishable:batch.publishable,errors:batch.validationErrors,
  })
  res.status(batch.status==='blocked'?409:200).json({batch})
 }catch(error:unknown){res.status(400).json({error:`历史日报专项复核预览失败：${error instanceof Error?error.message:String(error)}`})}
})

router.get('/api/data-pipeline/daily-reconciliations',requireAdmin,(_req,res)=>{
 const rows=(db.prepare(`SELECT id,business_date AS businessDate,extracted_at AS extractedAt,
  report_id AS reportId,region,official_total AS officialTotal,detail_total AS detailTotal,
  source_row_count AS sourceRowCount,publication_mode AS publicationMode,payload_sha256 AS payloadSha256,status,
  validation_errors AS validationErrors,supersedes_id AS supersedesId,created_by AS createdBy,
  created_at AS createdAt,published_by AS publishedBy,published_at AS publishedAt,confirm_note AS confirmNote,
  zero_value_confirmed AS zeroValueConfirmed,zero_value_confirm_note AS zeroValueConfirmNote,
  total_difference_confirmed AS totalDifferenceConfirmed,total_difference_confirm_note AS totalDifferenceConfirmNote
  FROM daily_collection_reconciliations ORDER BY id DESC LIMIT 30`).all() as any[]).map(row=>({
   ...row,publishable:row.status==='previewed'&&JSON.parse(row.validationErrors||'[]').length===0,
   validationErrors:JSON.parse(row.validationErrors||'[]'),
   zeroValueAudit:Number(row.detailTotal)===0?(Number(row.zeroValueConfirmed)===1?'business_confirmed':'requires_business_confirmation'):'not_applicable',
   totalDifference:Math.round((Number(row.officialTotal)-Number(row.detailTotal)+Number.EPSILON)*100)/100,
   totalDifferenceAudit:Math.abs(Number(row.officialTotal)-Number(row.detailTotal))>0.011
    ?(Number(row.totalDifferenceConfirmed)===1?'business_confirmed':'requires_business_confirmation'):'not_applicable',
  }))
 res.json({rows})
})

router.post('/api/data-pipeline/daily-reconciliations/:id/publish',requireDailyReconciliationAccess,(req,res)=>{
 const confirmNote=String(req.body?.confirmNote||'').trim()
 const zeroValueConfirmation={confirmed:req.body?.zeroValueConfirmed===true,note:String(req.body?.zeroValueConfirmNote||'').trim()}
 const totalDifferenceConfirmation={confirmed:req.body?.totalDifferenceConfirmed===true,note:String(req.body?.totalDifferenceConfirmNote||'').trim()}
 const requester=(req as any).user as {role?:string}|undefined
 if(zeroValueConfirmation.confirmed&&requester?.role!=='admin'){
  return res.status(403).json({error:'全零日报只能由管理员完成业务确认，自动化身份不得代为确认'})
 }
 if(totalDifferenceConfirmation.confirmed&&requester?.role!=='admin'){
  return res.status(403).json({error:'官方汇总与明细差异只能由管理员完成业务确认，自动化身份不得代为确认'})
 }
 try{
  let batch:ReturnType<typeof publishDailyReconciliation>
  db.transaction(()=>{
   const existing=db.prepare(`SELECT status,confirm_note,zero_value_confirm_note,total_difference_confirm_note
    FROM daily_collection_reconciliations WHERE id=?`).get(Number(req.params.id)) as any
   const reuseExistingConfirmation=existing?.status==='published'
   batch=publishDailyReconciliation(db,Number(req.params.id),actor(req),confirmNote,zeroValueConfirmation,totalDifferenceConfirmation)
   const persisted=db.prepare(`SELECT confirm_note,zero_value_confirm_note,total_difference_confirm_note
    FROM daily_collection_reconciliations WHERE id=?`).get(batch.id) as any
   logOperationStrict(req,'发布历史日报专项复核',`daily_collection_reconciliation:${batch.id}`,{
    businessDate:batch.businessDate,officialTotal:batch.officialTotal,detailTotal:batch.detailTotal,
    sourceRowCount:batch.sourceRowCount,publication_mode:batch.publicationMode,zeroValueAudit:batch.zeroValueAudit,
    totalDifference:batch.totalDifference,totalDifferenceAudit:batch.totalDifferenceAudit,
    confirmNote:String(persisted?.confirm_note??''),
    zeroValueConfirmNote:String(persisted?.zero_value_confirm_note??''),
    totalDifferenceConfirmNote:String(persisted?.total_difference_confirm_note??''),
    confirmationDisposition:reuseExistingConfirmation?'reuse_existing_confirmation':'request_confirmation',
   })
  })()
  res.json({batch:batch!})
 }catch(error:unknown){
  const message=error instanceof Error?error.message:String(error)
  const status=/不存在/.test(message)?404:/不可发布|已变化|至少[0-9]+个字符|全零官方日报|官方汇总与明细差异/.test(message)?409:400
  res.status(status).json({error:`历史日报专项复核发布失败：${message}`})
 }
})

function ensureP46SyncRuns(batch:any,who:string,publishedAt:string,compensated=false){
 const sourceNames=new Map((db.prepare("SELECT source_key,name FROM data_sources WHERE source_key IN ('aph','finereport','lvzai')").all() as any[]).map(row=>[row.source_key,row.name]))
 const counts=new Map((db.prepare("SELECT entity_type,COUNT(*) AS n FROM data_ingestion_rows WHERE batch_id=? GROUP BY entity_type").all(batch.id) as any[]).map(row=>[row.entity_type,Number(row.n)]))
 const existing=new Set((db.prepare("SELECT source_key,detail FROM data_source_sync_runs WHERE run_type='p46-publish' AND source_key IN ('aph','finereport','lvzai')").all() as any[]).filter(row=>{try{return Number(JSON.parse(row.detail||'{}').batchId)===Number(batch.id)}catch{return false}}).map(row=>row.source_key))
 const auditRows=[
  {key:'aph',count:counts.get('payment_center')||0},
  {key:'finereport',count:counts.get('daily_snapshot')||0},
  {key:'lvzai',count:counts.get('collection_center')||0},
 ]
 const insertRun=db.prepare(`INSERT INTO data_source_sync_runs
  (source_key,source_name,run_type,status,health,message,detail,duration_ms,rows_read,rows_written,rows_rejected,operator,started_at,finished_at)
  VALUES(?,?,'p46-publish','success','ok',?,?,0,?,?,0,?,?,?)`)
 for(const run of auditRows){
  if(existing.has(run.key))continue
  insertRun.run(run.key,sourceNames.get(run.key)||run.key,compensated?'P46存量发布审计补偿成功':'P46受控批次发布成功',
   JSON.stringify({batchId:batch.id,businessDate:batch.business_date,batchSha256:batch.batch_sha256,extractedAt:batch.extracted_at,...(compensated?{auditCompensated:true}: {})}),
   run.count,run.count,batch.published_by||who,publishedAt,publishedAt)
 }
}

router.post('/api/data-pipeline/batches/:id/publish',requireAdmin,(req,res)=>{
 const note=String(req.body?.confirmNote||'').trim();if(note.length<5)return res.status(400).json({error:'请填写至少5个字的发布确认说明'})
 const batch=db.prepare('SELECT * FROM data_ingestion_batches WHERE id=?').get(req.params.id) as any
 if(!batch)return res.status(404).json({error:'批次不存在'})
 const batchBusinessDate=evaluateBusinessDate(batch.business_date,'P46正式批次业务日期')
 if(batchBusinessDate.reasons.length)return res.status(409).json({error:batchBusinessDate.reasons.join('；')})
 if(batch.status!=='published'&&(batch.status!=='previewed'||!batch.publishable))return res.status(409).json({error:'批次未通过校验，禁止发布'})
 const verification=revalidateStoredPreview(batch)
 if(verification.errors.length)return res.status(409).json({error:verification.errors.join('；'),validationErrors:verification.errors})
 if(batch.status!=='published'){
  let previewSummary:any
  try{previewSummary=JSON.parse(batch.summary||'{}')}catch{return res.status(409).json({error:'存量预览摘要JSON无效，请重新预览后再发布'})}
  const previewBaselineId=Number(previewSummary?.dailyReview?.baselineBatchId)||null
  const verifiedBaselineId=verification.analysis?.dailyReview?.baselineBatchId||null
  if(previewBaselineId!==verifiedBaselineId)return res.status(409).json({error:`累计基线批次已变化（预览=${previewBaselineId??'无'}，发布重验=${verifiedBaselineId??'无'}），请重新预览后再发布`})
 }
 if(batch.status==='published'){
  const fixedEntriesRepaired=reconcilePublishedP46FixedEntries(batch)
  db.transaction(()=>{
   ensureP46SyncRuns(batch,actor(req),batch.published_at,true)
   logOperationStrict(req,'确认真实经营数据批次发布状态',`data_ingestion_batch:${batch.id}`,{
    businessDate:batch.business_date,batchSha256:batch.batch_sha256,auditCompensated:true,idempotent:true,fixedEntriesRepaired,
   })
  })()
  return res.json({idempotent:true,batch:batchView(batch)})
 }
 const pay=verification.bundle!.payment_centers
 const daily=verification.bundle!.daily_snapshots
 // 正式事实直接从已重验的归档绿仔原文派生；规范化包只作为逐字段一致性证明。
 const collections=verification.collectionRows!
 const backup={payment_centers:db.prepare('SELECT * FROM payment_centers ORDER BY id').all(),daily_snapshots:db.prepare('SELECT * FROM daily_snapshots WHERE date=? ORDER BY id').all(batch.business_date),collection_centers:db.prepare('SELECT * FROM collection_centers ORDER BY id').all()}
 const backupPayload=JSON.stringify(backup),backupSha=sha(backupPayload),who=actor(req)
 const publishedAt=(db.prepare("SELECT datetime('now','localtime') AS value").get() as any).value as string
 let fixedEntries:ReturnType<typeof prepareP46FixedEntries>|null=null
 try{
  fixedEntries=prepareP46FixedEntries(batch,who,publishedAt)
  db.transaction(()=>{
  db.prepare('DELETE FROM payment_centers').run()
  const ip=db.prepare('INSERT INTO payment_centers(area,center,annual_budget,cumulative_budget,cumulative_executed,same_period,collection_rate) VALUES(?,?,?,?,?,?,?)')
  for(const r of pay)ip.run(r.area,r.center,r.annual_budget,r.cumulative_budget,r.cumulative_executed,r.same_period,r.collection_rate)
  db.prepare('DELETE FROM daily_snapshots WHERE date=?').run(batch.business_date)
  const sourceFiles=JSON.parse(batch.source_files||'[]')
  const validatedAt=new Date().toISOString()
  const id=db.prepare(`INSERT INTO daily_snapshots
    (date,center,annual_budget,cumulative_budget,cumulative_executed,daily_collection,quality_status,quality_reason,source,source_status,business_date,last_validated_at,field_provenance)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`)
  for(const r of daily){
   let provenance:string
   if(typeof r.field_provenance==='string'){
    try{JSON.parse(r.field_provenance);provenance=r.field_provenance}catch{throw new Error(`快照${r.center}字段血缘JSON无效，事务已回滚`)}
   }else provenance=JSON.stringify(r.field_provenance||{batchId:batch.id,batchSha256:batch.batch_sha256,sourceFiles:sourceFiles.map((x:any)=>({key:x.key,sha256:x.sha256}))})
   id.run(r.date,r.center,r.annual_budget,r.cumulative_budget,r.cumulative_executed,r.daily_collection,'verified','',r.source||'FineReport三报表中心明细',r.source_status||'available',batch.business_date,r.last_validated_at||validatedAt,provenance)
  }
  db.prepare('DELETE FROM collection_centers').run()
  const ic=db.prepare('INSERT INTO collection_centers(area,center,receivable,received,overdue30,overdue90) VALUES(?,?,?,?,NULL,NULL)')
  for(const r of collections)ic.run(r.area,r.center,r.receivable,r.received)
  const counts={p:(db.prepare('SELECT COUNT(*) n FROM payment_centers').get() as any).n,d:(db.prepare('SELECT COUNT(*) n FROM daily_snapshots WHERE date=?').get(batch.business_date) as any).n,c:(db.prepare('SELECT COUNT(*) n FROM collection_centers').get() as any).n}
  if(counts.p!==pay.length||counts.d!==daily.length||counts.c!==collections.length||counts.c!==35)throw new Error('发布后行数校验失败，事务已回滚')
  db.prepare('INSERT INTO data_ingestion_publications(batch_id,business_date,backup_payload,backup_sha256,payment_rows,snapshot_rows,collection_rows,published_by) VALUES(?,?,?,?,?,?,?,?)').run(batch.id,batch.business_date,backupPayload,backupSha,pay.length,daily.length,collections.length,who)
  db.prepare("UPDATE data_ingestion_batches SET status='published',published_by=?,published_at=?,confirm_note=? WHERE id=?").run(who,publishedAt,note,batch.id)
  db.prepare("UPDATE data_sources SET status='已连接',last_sync_at=?,updated_at=? WHERE source_key IN ('aph','finereport','lvzai')").run(batch.extracted_at,publishedAt)
  ensureP46SyncRuns(batch,who,publishedAt)
  logOperationStrict(req,'发布真实经营数据批次',`data_ingestion_batch:${batch.id}`,{
   businessDate:batch.business_date,paymentRows:pay.length,snapshotRows:daily.length,
   collectionRows:collections.length,backupSha256:backupSha,confirmNote:note,
  })
   // 固定入口先写持久恢复日志再逐文件原子替换；SQLite提交后由settle完成对账。
   fixedEntries!.install()
  })()
  if(process.env.NODE_ENV==='test'&&process.env.COCKPIT_TEST_CRASH_AFTER_SQLITE_COMMIT==='1')process.kill(process.pid,'SIGKILL')
  fixedEntries.settle()
 }catch(error){fixedEntries?.settle();throw error}
 const out=db.prepare('SELECT * FROM data_ingestion_batches WHERE id=?').get(batch.id) as any
 res.json({idempotent:false,batch:batchView(out),publication:{paymentRows:pay.length,snapshotRows:daily.length,collectionRows:collections.length,backupSha256:backupSha}})
})
export default router
