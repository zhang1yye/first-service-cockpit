export type ForecastStatus='draft'|'submitted'|'area_approved'|'region_approved'|'rejected'|'locked'
export type ForecastAction='submit'|'area_approve'|'area_reject'|'region_approve'|'region_reject'|'lock'
const transitions:Record<ForecastStatus,Partial<Record<ForecastAction,ForecastStatus>>>={draft:{submit:'submitted'},submitted:{area_approve:'area_approved',area_reject:'rejected'},area_approved:{region_approve:'region_approved',region_reject:'rejected'},region_approved:{lock:'locked',region_reject:'rejected'},rejected:{submit:'submitted'},locked:{}}
export function transitionForecast(status:string,action:string){const next=transitions[status as ForecastStatus]?.[action as ForecastAction];if(!next)throw new Error(`预测状态不允许执行${action}：${status}`);return{previous:status as ForecastStatus,next,action:action as ForecastAction}}
const roleActions:Record<string,ForecastAction[]>={project_manager:['submit'],area_manager:['area_approve','area_reject'],region_manager:['region_approve','region_reject'],admin:['lock'],viewer:[]}
export function canWorkflowAction(role:string,action:string){return(roleActions[role]||[]).includes(action as ForecastAction)}
const requiredRole:Record<string,string>={submit:'project_manager',area_approve:'area_manager',area_reject:'area_manager',region_approve:'region_manager',region_reject:'region_manager',lock:'admin'}
export function validateForecastDiscipline(row:any,action:string,user:{username?:string;role?:string},note:string){
 const name=String(user?.username||'').trim(),role=String(user?.role||'')
 if(requiredRole[action]!==role)return`动作${action}必须由${requiredRole[action]||'指定'}角色执行`
 if(String(note||'').trim().length<4)return'本次动作必须填写不少于4个字的意见'
 if(!name)return'操作账号不能为空'
 if(action==='submit'){
  if(!String(row.owner||'').trim()||row.owner==='待指定')return'预测责任人不能为空'
  if(row.method==='unknown'||!Number.isFinite(Number(row.forecast_income))||!Number.isFinite(Number(row.forecast_cost)))return'缺少真实数据，预测不可提交'
  if(!String(row.data_source||'').trim())return'预测数据来源不能为空'
 }
 if(action.startsWith('area_')&&name===String(row.submitted_by||''))return'片区审核人不得与提交人相同'
 if(action.startsWith('region_')&&[row.submitted_by,row.area_reviewed_by].filter(Boolean).includes(name))return'地区审核人不得重复担任前序角色'
 if(action==='lock'&&[row.submitted_by,row.area_reviewed_by,row.region_reviewed_by].filter(Boolean).includes(name))return'冻结人不得重复担任提交或审核角色'
 return''
}
export const workflowLabel:Record<string,string>={draft:'草稿',submitted:'待片区审核',area_approved:'片区已通过',region_approved:'地区已确认',rejected:'已退回',locked:'已冻结'}
export const workflowRoleLabel:Record<string,string>={project_manager:'项目经理',area_manager:'片区负责人',region_manager:'地区负责人',admin:'驾驶舱管理员'}
