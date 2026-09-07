const token = localStorage.getItem('cockpit_token') || localStorage.getItem('authToken') || localStorage.getItem('token') || ''
const user = (() => { try { return JSON.parse(localStorage.getItem('cockpit_user') || '{}') } catch { return {} } })()
if (!token) window.location.replace('/login?redirect=' + encodeURIComponent('/arrears/'))

const state = { projects: [], batches: [], overview: null, selectedBatch: null }
const categoryLabels = { service_dispute:'服务争议',billing_dispute:'账单争议',charge_dispute:'收费争议',vacancy:'房屋空置',payment_difficulty:'支付困难',financial_hardship:'支付困难',ownership_or_handover:'产权/交付问题',contact_barrier:'联系障碍',promised_payment:'已承诺缴费',legal_dispute:'法律争议',unknown:'待人工核验' }
const $ = id => document.getElementById(id)
function el(tag, text, className) { const node=document.createElement(tag); if(text!==undefined&&text!==null) node.textContent=String(text); if(className) node.className=className; return node }
function showToast(message, error=false){const box=$('toast');box.textContent=message;box.className='toast'+(error?' error':'');setTimeout(()=>box.classList.add('hidden'),5000)}
function todayLocal(){const date=new Date();return `${date.getFullYear()}-${String(date.getMonth()+1).padStart(2,'0')}-${String(date.getDate()).padStart(2,'0')}`}
async function api(path, options={}){
  const headers = new Headers(options.headers||{}); headers.set('Authorization',`Bearer ${token}`)
  if(options.body && !(options.body instanceof FormData)) headers.set('Content-Type','application/json')
  const response=await fetch(path,{...options,headers})
  if(response.status===401){localStorage.removeItem('cockpit_token');window.location.replace('/login?redirect='+encodeURIComponent('/arrears/'));throw new Error('登录已失效')}
  const type=response.headers.get('content-type')||''
  const body=type.includes('application/json')?await response.json():await response.blob()
  if(!response.ok) throw new Error(body?.error||`请求失败 HTTP ${response.status}`)
  return {body,response}
}
function statusBadge(value){const map={parsed:['已校验','warn'],blocked:['已阻断','bad'],analyzing:['AI分析中','warn'],analyzed:['AI完成','ok'],rule_only:['规则结果','warn'],revoked:['已撤回','bad'],ok:['正常','ok'],partial:['部分通过','warn'],rejected:['证据门禁拒绝','bad'],failed:['失败','bad']};const cfg=map[value]||[value||'待分析',''];return el('span',cfg[0],`status ${cfg[1]}`)}
function button(text, cls, handler){const node=el('button',text,cls);node.type='button';node.addEventListener('click',handler);return node}

function formatMoney(value){
  if(value===null||value===undefined||!Number.isFinite(Number(value)))return '—'
  const amount=Number(value);const sign=amount<0?'-':'';const absolute=Math.abs(amount)
  if(absolute>=10000)return `${sign}¥${(absolute/10000).toLocaleString('zh-CN',{minimumFractionDigits:2,maximumFractionDigits:2})}万`
  return `${sign}¥${absolute.toLocaleString('zh-CN',{minimumFractionDigits:2,maximumFractionDigits:2})}`
}
function formatPercent(value){return value===null||value===undefined||!Number.isFinite(Number(value))?'—':`${(Number(value)*100).toFixed(1)}%`}
function renderBreakdown(id, rows, kind='standard'){
  const list=$(id);list.replaceChildren();const values=rows||[]
  if(!values.length){list.append(el('div','当前有效批次暂无可展示结构','breakdown-empty'));return}
  const maximum=Math.max(1,...values.map(row=>Math.abs(Number(row.amount??0))||Number(row.resourceCount||0)))
  values.forEach(row=>{
    const amount=row.amount===null||row.amount===undefined?null:Number(row.amount);const value=Math.abs(amount??0)||Number(row.resourceCount||0)
    const item=el('div',null,'breakdown-item'+(amount!==null&&amount<0?' negative':''))
    const heading=el('div',null,'breakdown-heading');const label=el('span',kind==='cause'?(categoryLabels[row.cause]||row.cause||'待人工核验'):(row.label||row.key||'未分类'))
    const stats=el('strong',`${Number(row.resourceCount||0)}项 · ${formatMoney(amount)}`);heading.append(label,stats)
    const track=el('div',null,'breakdown-track');const bar=el('span',null,'breakdown-bar');bar.style.setProperty('--share',`${Math.max(3,Math.min(100,value/maximum*100))}%`);track.append(bar)
    item.append(heading,track);list.append(item)
  })
}
function renderOverview(){
  const overview=state.overview;const ready=Boolean(overview?.ready)
  const status=$('overviewStatus');status.textContent=ready?`有效数据 · ${overview.latestBusinessDate||'日期未知'}`:'暂无有效经营批次';status.className=`data-state ${ready?'ready':'unavailable'}`
  $('metricAmount').textContent=ready?formatMoney(overview.totalAmount):'—'
  $('metricAmountNote').textContent=ready?`金额完整率 ${formatPercent(overview.amountCompletenessRate)}`:'无有效金额事实'
  $('metricResources').textContent=ready?Number(overview.resourceCount||0).toLocaleString('zh-CN'):'—'
  $('metricCommunication').textContent=ready?`${Number(overview.missingCommunicationResourceCount||0)}项无匹配沟通记录（不等于未联系）`:'企小码覆盖不可用'
  $('metricProjects').textContent=ready?Number(overview.projectCount||0).toLocaleString('zh-CN'):'—'
  $('metricBatches').textContent=Number(overview?.effectiveBatchCount||0).toLocaleString('zh-CN')
  $('metricBatchNote').textContent=overview?.revokedBatchCount?`${overview.revokedBatchCount}个撤回批次已排除`:'同项目同日期只取最新'
  $('metricReview').textContent=ready?Number(overview.pendingReviewCount||0).toLocaleString('zh-CN'):'—'
  $('metricReviewNote').textContent=ready?`${Number(overview.confirmedReviewCount||0)}项已完成人工确认`:'人工复核状态不可用'
  $('metricDate').textContent=ready?(overview.latestBusinessDate||'—'):'—'
  $('metricAgeing').textContent=ready?`366天以上净额 ${formatMoney(overview.longAgeingAmount)}`:'长账龄金额不可用'
  $('qualityAmount').textContent=ready?formatPercent(overview.amountCompletenessRate):'—'
  $('qualityReview').textContent=ready?`${Number(overview.pendingReviewCount||0)}项`:'—'
  $('qualityCommunication').textContent=ready?`${Number(overview.missingCommunicationResourceCount||0)}项`:'—'
  const empty=$('overviewEmpty');const panels=$('overviewPanels')
  if(!ready){
    panels.classList.add('hidden');empty.classList.remove('hidden');empty.replaceChildren(el('span','00','empty-index'))
    const copy=el('div');copy.append(el('strong','暂无可用于经营分析的有效批次'));copy.append(el('p',overview?.revokedBatchCount?`当前仅有${overview.revokedBatchCount}个已撤回批次，已按真实性门禁排除。请在下方创建或恢复具备有效原始证据的正式批次。`:'请在下方上传欠费台账和企小码沟通记录，完成校验后再生成经营总览。'));empty.append(copy);return
  }
  empty.classList.add('hidden');panels.classList.remove('hidden')
  renderBreakdown('projectBreakdown',overview.projectBreakdown)
  renderBreakdown('areaBreakdown',overview.areaBreakdown)
  renderBreakdown('ageingBreakdown',overview.ageingBreakdown)
  renderBreakdown('feeBreakdown',overview.feeBreakdown)
  renderBreakdown('causeBreakdown',overview.causeBreakdown,'cause')
}
async function loadOverview(){
  const status=$('overviewStatus');status.textContent='数据读取中';status.className='data-state loading'
  const {body}=await api('/api/arrears/overview');state.overview=body;renderOverview()
}

async function loadProjects(){
  const {body}=await api('/api/arrears/projects'); state.projects=body.rows||[]
  const select=$('projectId'); select.replaceChildren(el('option','请选择当前账号有权访问的项目'))
  select.firstChild.value=''
  state.projects.forEach(project=>{const option=el('option',`${project.area||'未分区'} · ${project.name}`);option.value=project.id;select.append(option)})
}
async function loadBatches(){
  const {body}=await api('/api/arrears/batches');state.batches=body.rows||[];renderBatches()
}
async function refreshWorkspace(){await Promise.all([loadOverview(),loadBatches()])}
function renderBatches(){
  const tbody=$('batchRows');tbody.replaceChildren()
  if(!state.batches.length){const tr=el('tr');const td=el('td','尚无上传批次','empty');td.colSpan=6;tr.append(td);tbody.append(tr);return}
  state.batches.forEach(batch=>{
    const tr=el('tr')
    const id=el('td',`#${batch.id}`);id.dataset.label='批次';id.append(el('small',batch.created_at||''))
    const project=el('td',batch.project_name);project.dataset.label='项目/业务日期';project.append(el('small',`业务日期 ${batch.business_date}`))
    const size=el('td',`${batch.matched_resources}项资源`);size.dataset.label='数据规模';size.append(el('small',`${batch.ledger_rows}条台账 · ${batch.communication_rows}条沟通`))
    const validation=el('td');validation.dataset.label='校验';validation.append(batch.unmatched_communication_rows?statusBadge('partial'):statusBadge('ok'));validation.append(el('small',batch.unmatched_communication_rows?`${batch.unmatched_communication_rows}条沟通未匹配`:'资源编码校验通过'))
    const ai=el('td');ai.dataset.label='AI状态';ai.append(statusBadge(batch.status));if(batch.ai_model)ai.append(el('small',batch.ai_model))
    const actions=el('td');actions.dataset.label='操作';const wrap=el('div',null,'actions');wrap.append(button('查看','secondary',()=>viewBatch(batch.id)))
    if(['parsed','rule_only','analyzed'].includes(batch.status))wrap.append(button(batch.status==='analyzed'?'重新分析':'云端AI分析','primary',()=>analyzeBatch(batch.id)))
    if(batch.status!=='revoked')wrap.append(button('撤回','danger',()=>revokeBatch(batch.id)))
    else { wrap.append(button('恢复批次','secondary',()=>restoreBatch(batch.id))); if(!batch.archive_deleted_at)wrap.append(button('删除原始密文','danger',()=>deleteArchive(batch.id))) }
    actions.append(wrap);tr.append(id,project,size,validation,ai,actions);tbody.append(tr)
  })
}
async function viewBatch(id){
  try{const {body}=await api(`/api/arrears/batches/${id}`);state.selectedBatch=body;$('resultPanel').classList.remove('hidden');$('resultTitle').textContent=`批次 #${id} · ${body.batch.project_name}`;renderResults(body);$('resultPanel').scrollIntoView({behavior:'smooth',block:'start'})}catch(error){showToast(error.message,true)}
}
function renderResults(payload){
  const summary=$('resultSummary');summary.replaceChildren()
  const rows=payload.rows||[];const total=rows.length;const ai=rows.filter(x=>x.analysis_status==='ai_analyzed').length;const reviewed=rows.filter(x=>x.human_status!=='pending').length
  ;[`资源 ${total}项`,`AI有效归因 ${ai}项`,`人工复核 ${reviewed}项`,payload.batch.archive_deleted_at?`原始密文已于 ${payload.batch.archive_deleted_at} 清理`:`原始文件密文保留至 ${payload.batch.retention_until||'—'}`].forEach(x=>summary.append(el('span',x)))
  const list=$('resultRows');list.replaceChildren()
  if(!rows.length){list.append(el('div','暂无结果','empty'));return}
  rows.forEach(row=>{
    const card=el('article',null,'result-card')
    const resource=el('div');resource.append(el('h3',row.resource_masked));resource.append(el('p',`证据化资源 ${row.resource_ref}`))
    const rule=el('div');rule.append(el('h3','规则归类'));rule.append(el('p',categoryLabels[row.rule_category]||row.rule_category));rule.append(el('p',`置信度 ${Math.round(Number(row.rule_confidence||0)*100)}%`,'confidence'));const ruleRefs=el('div',null,'evidence');(row.rule_evidence_json||[]).forEach(ref=>ruleRefs.append(el('code',ref)));rule.append(ruleRefs)
    const ai=el('div');ai.append(el('h3','云端AI推断'));if(row.ai_category){ai.append(el('p',`${categoryLabels[row.ai_category]||row.ai_category} · ${Math.round(Number(row.ai_confidence||0)*100)}%`,'confidence'));ai.append(el('p',row.ai_reason));const refs=el('div',null,'evidence');(row.ai_evidence_json||[]).forEach(ref=>refs.append(el('code',ref)));ai.append(refs)}else{ai.append(el('p',row.analysis_status==='ai_rejected'?'AI结果未通过证据门禁':'尚未执行AI分析'))}(row.data_notes_json||[]).forEach(note=>ai.append(el('p',note,'status warn')))
    const review=el('div',null,'review-box');const select=el('select');Object.entries(categoryLabels).forEach(([key,label])=>{const option=el('option',label);option.value=key;select.append(option)});select.value=row.human_category||row.ai_category||row.rule_category||'unknown';const note=el('input');note.placeholder='人工核验说明';note.value=row.human_note||'';review.append(select,note,button(row.human_status==='confirmed'?'已确认':'确认归因','secondary',()=>reviewResult(row.id,'confirmed',select.value,note.value)),button('驳回','danger',()=>reviewResult(row.id,'rejected',select.value,note.value)))
    card.append(resource,rule,ai,review);list.append(card)
  })
}
async function analyzeBatch(id){
  try{showToast('云端AI正在按证据分批分析，请稍候…');const {body}=await api(`/api/arrears/batches/${id}/analyze`,{method:'POST',body:'{}'});showToast(`分析完成：${body.accepted}项通过，${body.rejected}项被证据门禁拒绝`);await refreshWorkspace();await viewBatch(id)}catch(error){showToast(error.message,true);await refreshWorkspace()}
}
async function reviewResult(id,status,category,note){
  if(!note.trim()){showToast('请填写人工核验说明',true);return}
  try{await api(`/api/arrears/results/${id}/review`,{method:'PUT',body:JSON.stringify({status,category,note})});showToast(status==='confirmed'?'已确认归因':'已驳回AI归因');await loadOverview();await viewBatch(state.selectedBatch.batch.id)}catch(error){showToast(error.message,true)}
}
async function revokeBatch(id){
  const note=window.prompt('请输入撤回原因。撤回后停止分析，密文原件在保留期内可审计恢复。')
  if(!note)return
  try{await api(`/api/arrears/batches/${id}/revoke`,{method:'POST',body:JSON.stringify({note})});showToast('批次已撤回');await refreshWorkspace();if(state.selectedBatch?.batch?.id===id)$('resultPanel').classList.add('hidden')}catch(error){showToast(error.message,true)}
}
async function restoreBatch(id){
  const note=window.prompt('请输入恢复原因。恢复后批次回到待分析状态。');if(!note)return
  try{await api(`/api/arrears/batches/${id}/restore`,{method:'POST',body:JSON.stringify({note})});showToast('批次已恢复');await refreshWorkspace();await viewBatch(id)}catch(error){showToast(error.message,true)}
}
async function deleteArchive(id){
  const note=window.prompt('此操作只删除加密原文件且不可恢复，分析记录与审计仍保留。请输入删除原因：');if(!note||!window.confirm('确认永久删除该批次的加密原文件？'))return
  try{await api(`/api/arrears/batches/${id}/archive`,{method:'DELETE',body:JSON.stringify({note})});showToast('加密原文件已删除');await refreshWorkspace();await viewBatch(id)}catch(error){showToast(error.message,true)}
}
async function downloadTemplate(kind){
  try{const {body,response}=await api(`/api/arrears/templates/${kind}`);const disposition=response.headers.get('content-disposition')||'';const match=disposition.match(/filename\*=UTF-8''([^;]+)/i);const filename=match?decodeURIComponent(match[1]):`${kind}.xlsx`;const url=URL.createObjectURL(body);const link=document.createElement('a');link.href=url;link.download=filename;link.click();URL.revokeObjectURL(url)}catch(error){showToast(error.message,true)}
}
$('uploadForm').addEventListener('submit',async event=>{
  event.preventDefault();const submit=$('uploadButton');submit.disabled=true;submit.textContent='上传校验中…'
  try{const form=new FormData();form.set('projectId',$('projectId').value);form.set('businessDate',$('businessDate').value);form.set('ledger',$('ledgerFile').files[0]);form.set('communications',$('communicationFile').files[0]);const {body}=await api('/api/arrears/batches',{method:'POST',body:form});showToast(`批次#${body.batchId}已建立：${body.matchedResources}项资源，等待AI分析`);event.target.reset();$('businessDate').value=todayLocal();await refreshWorkspace();await viewBatch(body.batchId)}catch(error){showToast(error.message,true)}finally{submit.disabled=false;submit.textContent='上传并校验'}
})
document.querySelectorAll('[data-template]').forEach(node=>node.addEventListener('click',()=>downloadTemplate(node.dataset.template)))
$('refreshButton').addEventListener('click',()=>refreshWorkspace().catch(error=>showToast(error.message,true)))
$('overviewRefresh').addEventListener('click',()=>refreshWorkspace().catch(error=>showToast(error.message,true)))
$('closeResults').addEventListener('click',()=>$('resultPanel').classList.add('hidden'))
$('businessDate').value=todayLocal()
$('userLabel').textContent=user.displayName||user.username||'当前账号'
Promise.all([loadProjects(),refreshWorkspace()]).catch(error=>{const status=$('overviewStatus');status.textContent='经营数据读取失败';status.className='data-state failed';showToast(error.message,true)})

