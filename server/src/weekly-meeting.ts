import crypto from 'node:crypto'

type AgendaInput={previousItems:any[];topRisks:any[]}

export function mondayOfWeek(dateText:string){
  const d=new Date(`${dateText}T00:00:00Z`)
  const day=d.getUTCDay()||7
  d.setUTCDate(d.getUTCDate()-day+1)
  return d.toISOString().slice(0,10)
}

function item(sourceType:string,sourceId:string,data:any){
  const signature=crypto.createHash('sha256').update(`${sourceType}|${sourceId}`).digest('hex')
  return {sourceType,sourceId,signature,...data}
}

export function buildWeeklyAgenda({previousItems,topRisks}:AgendaInput){
  const rows:any[]=[]
  for(const p of previousItems.filter(x=>x.status!=='closed'))rows.push(item('carryover',String(p.id),{projectId:null,projectName:p.project_name||'',riskType:'上周遗留',issue:p.issue||'上周待讨论事项',owner:p.owner||'',dueDate:p.due_date||'',priority:0}))
  for(const r of topRisks)rows.push(item('top-risk',String(r.projectId),{projectId:r.projectId||null,projectName:r.name||'',riskType:r.riskType||'经营风险',issue:r.reason||'TOP风险项目',owner:'',dueDate:'',priority:1}))
  const seen=new Set<string>()
  return rows.filter(row=>!seen.has(row.signature)&&(seen.add(row.signature),true)).sort((a,b)=>a.priority-b.priority)
}

export function validateMeetingItem(item:any){
 const decision=String(item?.decision||'').trim(),owner=String(item?.owner||'').trim(),due=String(item?.due_date||'').trim()
 if(decision.length<5)return'会议决策不少于5个字'
 if(!owner||owner==='待指定')return'责任人不能为空或待指定'
 if(!/^\d{4}-\d{2}-\d{2}$/.test(due))return'截止日期必须为YYYY-MM-DD'
 return''
}
export function evaluateMeetingDiscipline(items:any[]){
 const total=items.length,decided=items.filter(x=>!validateMeetingItem(x)).length
 return{total,decided,complete:decided,missingDecision:total-decided,completionRate:total?decided*100/total:0,compliant:total>0&&decided===total}
}
export function validateMeetingTransition(meeting:any,next:string,summary:string,items:any[]){
 const text=String(summary||'').trim(),d=evaluateMeetingDiscipline(items)
 if(text.length<10)return'会议总结不少于10个字'
 if(next==='held'){
  if(meeting?.status!=='draft')return'只有草稿周会可以记录召开'
  if(d.decided<1)return'至少完成1项会议决策、责任人和截止日期后才能记录召开'
  return''
 }
 if(next==='closed'){
  if(meeting?.status!=='held')return'只有已召开的周会可以关闭'
  if(!d.compliant)return`仍有${d.missingDecision}项未完成会议决策，不能关闭`
  return''
 }
 return'不支持的周会状态动作'
}
