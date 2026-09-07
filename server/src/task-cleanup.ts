export type CleanupTask={id:number;project_name?:string;risk_type?:string;action?:string;status?:string;due_date?:string;owner?:string;result?:string;review_note?:string;event_count?:number;notification_count?:number;created_at?:string;[key:string]:any}
export function normalizeTaskKey(t:CleanupTask){const clean=(v:any)=>String(v||'').trim().toLowerCase().replace(/[\s，,。.!！；;：:、（）()\-—_·]/g,'').replace(/Λ/g,'a').replace(/mom[aα]/gi,'moma');return[clean(t.project_name),clean(t.risk_type),clean(t.action)].join('|')}
function score(t:CleanupTask){return(String(t.result||'').trim()?100:0)+(String(t.review_note||'').trim()?50:0)+Number(t.event_count||0)*10+Number(t.notification_count||0)*5}
export function buildTaskCleanupPreview(tasks:CleanupTask[],today:string){
 const buckets=new Map<string,CleanupTask[]>();for(const t of tasks){const k=normalizeTaskKey(t);buckets.set(k,[...(buckets.get(k)||[]),t])}
 const groups:any[]=[],unique:CleanupTask[]=[]
 buckets.forEach((rows,key)=>{const sorted=[...rows].sort((a,b)=>score(b)-score(a)||Number(a.id)-Number(b.id));unique.push(sorted[0]);if(sorted.length>1)groups.push({key,primary:sorted[0],duplicates:sorted.slice(1),reason:'同项目、风险类型和动作标准化后完全一致',evidenceScore:score(sorted[0])})})
 const overdue=unique.filter(t=>t.status!=='已完成'&&t.status!=='待复核'&&t.due_date&&t.due_date<today),waiting=unique.filter(t=>t.status==='待复核'),noOwner=unique.filter(t=>t.status!=='已完成'&&(!t.owner||t.owner==='待指定')),cont=unique.filter(t=>t.status!=='已完成'&&(!t.due_date||t.due_date>=today)&&t.status!=='待复核')
 return{groups,uniqueTasks:unique,summary:{activeBefore:tasks.length,uniqueAfter:unique.length,duplicateGroups:groups.length,duplicateRecords:tasks.length-unique.length,overdueAfter:overdue.length,continueAfter:cont.length,waitingReviewAfter:waiting.length,noOwnerAfter:noOwner.length}}
}
