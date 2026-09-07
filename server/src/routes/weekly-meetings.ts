import { Router } from 'express'
import db from '../db.js'
import { denyScopedAccess, projectScopeWhere, serviceCenterScopeWhere } from '../auth.js'
import { logOperation } from '../audit.js'
import { buildWeeklyAgenda, mondayOfWeek, evaluateMeetingDiscipline, validateMeetingItem, validateMeetingTransition } from '../weekly-meeting.js'
import { serviceCenterValues } from '../service-center-access.js'


const router=Router()
const now=()=>new Date().toISOString()
const actor=(req:any)=>req.user?.username||'system'

router.use('/api/weekly-meetings',(req:any,res,next)=>{
  if(req.user?.role!=='admin'&&!serviceCenterValues(req.user).length)return denyScopedAccess(req,res,'当前账号未绑定有效服务中心')
  next()
})

function meetingDetail(id:number,req?:any){
  const meeting=db.prepare('SELECT * FROM weekly_meetings WHERE id=?').get(id) as any
  if(!meeting)return null
  const scope=req?serviceCenterScopeWhere(req,'project_name','i'):{clause:'',params:[]}
  const items=db.prepare(`SELECT i.id,i.meeting_id,i.source_type,i.source_id,i.source_signature,i.project_id,i.project_name,i.risk_type,i.issue,i.decision,i.owner,i.due_date,i.status,i.created_at,i.updated_at FROM weekly_meeting_items i WHERE i.meeting_id=? AND i.source_type NOT LIKE 'task-%'${scope.clause?` AND ${scope.clause}`:''} ORDER BY CASE i.source_type WHEN 'carryover' THEN 0 ELSE 1 END,i.id`).all(id,...scope.params)
  if(req?.user?.role!=='admin'&&!items.length)return null
  const safeMeeting=req?.user?.role==='admin'?meeting:{id:meeting.id,week_start:meeting.week_start,area:meeting.area,title:'本服务中心周度经营事项',status:meeting.status,created_at:meeting.created_at,updated_at:meeting.updated_at}
  return {...safeMeeting,items,discipline:evaluateMeetingDiscipline(items as any[])}
}

router.get('/api/weekly-meetings',(req,res)=>{
  const area=String(req.query.area||'华北'),scope=serviceCenterScopeWhere(req,'project_name','i')
  const rows=scope.clause
    ? db.prepare(`SELECT DISTINCT m.id,m.week_start,m.area,'本服务中心周度经营事项' title,m.status,m.created_at,m.updated_at FROM weekly_meetings m JOIN weekly_meeting_items i ON i.meeting_id=m.id WHERE m.area=? AND i.source_type NOT LIKE 'task-%' AND ${scope.clause} ORDER BY m.week_start DESC,m.id DESC LIMIT 30`).all(area,...scope.params)
    : db.prepare('SELECT * FROM weekly_meetings WHERE area=? ORDER BY week_start DESC,id DESC LIMIT 30').all(area)
  res.json({rows})
})

router.get('/api/weekly-meetings/:id',(req,res)=>{
  const detail=meetingDetail(Number(req.params.id),req);if(!detail)return res.status(404).json({error:'周会不存在或无权访问'});res.json(detail)
})

router.post('/api/weekly-meetings/prepare',(req,res)=>{
  const area=String(req.body?.area||'华北'),weekStart=mondayOfWeek(String(req.body?.week_start||new Date().toISOString().slice(0,10))),stamp=now()
  let meeting=db.prepare('SELECT * FROM weekly_meetings WHERE week_start=? AND area=?').get(weekStart,area) as any
  let created=false
  if(!meeting){const r=db.prepare('INSERT INTO weekly_meetings(week_start,area,title,status,created_by,created_at,updated_at) VALUES(?,?,?,?,?,?,?)').run(weekStart,area,`${area}${weekStart}周经营例会`,'draft',actor(req),stamp,stamp);meeting=db.prepare('SELECT * FROM weekly_meetings WHERE id=?').get(r.lastInsertRowid);created=true}
  const previousMeeting=db.prepare('SELECT id FROM weekly_meetings WHERE area=? AND week_start<? ORDER BY week_start DESC LIMIT 1').get(area,weekStart) as any
  const previousItems=previousMeeting?db.prepare(`SELECT i.id,i.project_name,i.issue,i.owner,i.due_date,i.status FROM weekly_meeting_items i WHERE i.meeting_id=? AND i.status!='closed' AND i.source_type NOT LIKE 'task-%'`).all(previousMeeting.id) as any[]:[]
  const projectScope=projectScopeWhere(req),projectClauses:string[]=[],projectParams:any[]=[]
  if(area!=='华北'&&area!=='全部'){projectClauses.push('area=?');projectParams.push(area)}
  if(projectScope.clause){projectClauses.push(projectScope.clause);projectParams.push(...projectScope.params)}
  const projects=db.prepare(`SELECT * FROM projects ${projectClauses.length?`WHERE ${projectClauses.join(' AND ')}`:''}`).all(...projectParams) as any[]
  const topRisks=projects.map(p=>{const collection=p.receivable>0?p.received*100/p.receivable:0,profit=p.ytd_income>0?(p.ytd_income-p.ytd_cost)*100/p.ytd_income:0;return{projectId:p.id,name:p.name,riskType:collection<85?'收费率':profit<8?'利润率':p.safety_incidents>0?'安全':'经营风险',reason:`收费率${collection.toFixed(1)}%，利润率${profit.toFixed(1)}%，安全事故${p.safety_incidents||0}起`,score:collection+profit-(p.safety_incidents||0)*10-(p.complaint_count||0)}}).sort((a,b)=>a.score-b.score).slice(0,5)
  const agenda=buildWeeklyAgenda({previousItems,topRisks})
  const insert=db.prepare(`INSERT OR IGNORE INTO weekly_meeting_items(meeting_id,source_type,source_id,source_signature,project_id,project_name,risk_type,issue,owner,due_date,linked_task_id,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
  const tx=db.transaction(()=>agenda.forEach(x=>insert.run(meeting.id,x.sourceType,x.sourceId,x.signature,x.projectId,x.projectName,x.riskType,x.issue,x.owner,x.dueDate||null,null,'open',stamp,stamp)));tx()
  const detail=meetingDetail(meeting.id);logOperation(req,created?'准备周会议程':'刷新周会议程',`weekly_meeting:${meeting.id}`,{weekStart,area,itemCount:detail?.items?.length||0})
  res.status(created?201:200).json({created,...detail})
})

router.put('/api/weekly-meetings/:meetingId/items/:itemId',(req,res)=>{
  const item=db.prepare('SELECT * FROM weekly_meeting_items WHERE id=? AND meeting_id=?').get(req.params.itemId,req.params.meetingId) as any;if(!item)return res.status(404).json({error:'议题不存在'})
  const meeting=db.prepare('SELECT * FROM weekly_meetings WHERE id=?').get(req.params.meetingId) as any;if(meeting?.status==='closed')return res.status(409).json({error:'周会已关闭，禁止修改议题'})
  const decision=String(req.body?.decision||'').trim(),owner=String(req.body?.owner??item.owner).trim(),dueDate=String(req.body?.due_date??item.due_date??'').trim();if(!decision)return res.status(400).json({error:'会议决策不能为空'})
  const itemError=validateMeetingItem({decision,owner,due_date:dueDate});if(itemError)return res.status(400).json({error:itemError})
  db.prepare("UPDATE weekly_meeting_items SET decision=?,owner=?,due_date=?,status='decided',updated_at=? WHERE id=?").run(decision,owner,dueDate||null,now(),item.id)
  logOperation(req,'记录周会议题决策',`weekly_meeting_item:${item.id}`,{meetingId:Number(req.params.meetingId),owner,dueDate});res.json(meetingDetail(Number(req.params.meetingId)))
})


router.post('/api/weekly-meetings/:id/status',(req,res)=>{
  const status=String(req.body?.status||''),summary=String(req.body?.summary||'').trim();if(!['held','closed'].includes(status))return res.status(400).json({error:'状态仅支持held或closed'})
  const detail=meetingDetail(Number(req.params.id));if(!detail)return res.status(404).json({error:'周会不存在'});const disciplineError=validateMeetingTransition(detail,status,summary,detail.items);if(disciplineError)return res.status(409).json({error:disciplineError,discipline:detail.discipline})
  const stamp=now();db.prepare(`UPDATE weekly_meetings SET status=?,summary=?,held_at=CASE WHEN ?='held' THEN COALESCE(held_at,?) ELSE held_at END,held_by=CASE WHEN ?='held' THEN ? ELSE held_by END,closed_at=CASE WHEN ?='closed' THEN ? ELSE closed_at END,closed_by=CASE WHEN ?='closed' THEN ? ELSE closed_by END,updated_at=? WHERE id=?`).run(status,summary,status,stamp,status,actor(req),status,stamp,status,actor(req),stamp,req.params.id)
  logOperation(req,status==='held'?'召开周度经营例会':'关闭周度经营例会',`weekly_meeting:${req.params.id}`,{summary});res.json(meetingDetail(Number(req.params.id)))
})

export default router
