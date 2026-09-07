#!/usr/bin/env python3
import argparse,datetime,hashlib,json,pathlib,re,sqlite3

def norm(s):
 s=(s or '').replace('MOMA','MOMΛ').replace('ΜΟΜΛ','MOMΛ').replace('MOM∧','MOMΛ').replace('·','')
 s=re.sub(r'第一服务|第一物业|第一酒店','',s);s=re.sub(r'服务中心|体验中心','',s);s=re.sub(r'[-－].*$','',s);s=re.sub(r'停车场.*$','',s);s=re.sub(r'[(（].*$','',s);s=re.sub(r'一期|二期','',s);return s.strip()
ALIASES={'北京IMOMΛ':'北京上第MOMΛ','北京悦MOMΛ':'北京上第MOMΛ','北京满庭芳园':'满庭青云','北京青云大厦':'满庭青云','青云大厦':'满庭青云','营口林昌天铂院子':'营口天铂院子','中行项目部':'北京中行项目部','满庭芳园':'满庭青云','万国城MOMΛ':'北京万国城MOMΛ','通州万国城':'北京通州万国城MOMΛ'}
def sha(p):return hashlib.sha256(p.read_bytes()).hexdigest()
def main():
 ap=argparse.ArgumentParser();ap.add_argument('--date',required=True);ap.add_argument('--db',required=True);ap.add_argument('--source-dir',required=True);ap.add_argument('--community-map',required=True);ap.add_argument('--output',required=True);a=ap.parse_args()
 src=pathlib.Path(a.source_dir);aph=src/f'APH决策_每日提取_{a.date}.json';detail=src/f'回款额明细_{a.date}.json';lv=src/f'收款统计_API_{a.date}.json';collection_detail=src/f'绿仔收缴明细_{a.date}.json';collection_summary=src/f'绿仔收款汇总_{a.date}.json'
 for p in [aph,detail,lv,collection_detail,collection_summary]:
  if not p.is_file():raise SystemExit(f'缺少源文件: {p}')
 aphj=json.loads(aph.read_text());details=json.loads(detail.read_text());lvj=json.loads(lv.read_text());collection_detail_json=json.loads(collection_detail.read_text());collection_summary_json=json.loads(collection_summary.read_text())
 collection_rows=collection_detail_json.get('rows') if isinstance(collection_detail_json,dict) else None
 if aphj.get('date')!=a.date or len(details)<40 or lvj.get('result') is not True or not isinstance(collection_rows,list) or len(collection_rows)!=35 or collection_detail_json.get('businessDate')!=a.date or collection_summary_json.get('date')!=a.date:raise SystemExit('源文件日期、行数或绿仔接口状态不合格')
 c=sqlite3.connect(a.db);c.row_factory=sqlite3.Row
 pay=[dict(x) for x in c.execute('SELECT area,center,annual_budget,cumulative_budget,cumulative_executed,same_period,collection_rate FROM payment_centers ORDER BY center')]
 daily=[dict(x) for x in c.execute('SELECT date,center,annual_budget,cumulative_budget,cumulative_executed,daily_collection,quality_status,quality_reason,source,source_status,business_date,last_validated_at,field_provenance FROM daily_snapshots WHERE date=? ORDER BY center',(a.date,))]
 if len(pay)<40 or len(daily)!=len(pay):raise SystemExit(f'规范化数据库行数异常 payment={len(pay)} daily={len(daily)}')
 md=pathlib.Path(a.community_map).read_text();ridmap={}
 for line in md.splitlines():
  cells=[x.strip() for x in line.strip().strip('|').split('|')]
  if len(cells)>=3 and re.fullmatch(r'[0-9a-z]{10,}',cells[2] or ''):ridmap[cells[2]]={'green_center':cells[0],'community':cells[1]}
 ridmap.update({'202006220924530758a':{'green_center':'万国城MOMΛ服务中心','community':'万国城停车场东城'},'2020062209240481972':{'green_center':'万国城MOMΛ服务中心','community':'万国城停车场'}})
 source_regions={str(r.get('regonId')):r.get('regionName') for r in lvj.get('data',[]) if r.get('regonId') and r.get('regionName')}
 canonical={norm(x['center']):x['center'] for x in pay};mapped={};outside=[];unmapped=[]
 for rid,name in sorted(source_regions.items()):
  ref=ridmap.get(rid)
  if not ref:unmapped.append(name);continue
  g=ref['green_center'];key=ALIASES.get(norm(g),norm(g));hit=canonical.get(key)
  if not hit:
   candidates=[v for k,v in canonical.items() if key and (key in k or k in key)]
   hit=candidates[0] if len(candidates)==1 else None
  if hit:mapped[rid]=hit
  else:outside.append({'region_id':rid,'community':name,'green_center':g,'reason':'当前FineReport 56中心无对应项，保留原始数据但不发布'})
 source_specs=[('aph',aph,f'aph-{a.date}.json'),('paymentDetail',detail,f'payment-detail-{a.date}.json'),('lvzai',lv,f'lvzai-{a.date}.json'),('collectionDetail',collection_detail,f'collection-detail-{a.date}.json'),('collectionSummary',collection_summary,f'collection-summary-{a.date}.json')]
 sources=[{'key':key,'name':name,'size':source.stat().st_size,'sha256':sha(source)} for key,source,name in source_specs]
 out={'schema_version':2,'business_date':a.date,'extracted_at':aphj.get('extractedAt'),'source_status':aphj.get('sourceStatus'),'last_validated_at':aphj.get('lastValidatedAt'),'field_provenance':aphj.get('fieldProvenance'),'source_layers':aphj.get('sourceLayers'),'reconciliations':aphj.get('reconciliations'),'sources':sources,'payment_centers':pay,'daily_snapshots':daily,'collection_centers':collection_rows,'collection_summary':collection_summary_json,'lvzai':{'raw_rows':len(lvj.get('data',[])),'source_regions':len(source_regions),'mapped_regions':len(mapped),'canonical_centers':len(set(mapped.values())),'unmapped_centers':sorted(set(unmapped)),'outside_current_scope':outside,'mapping':mapped}}
 pathlib.Path(a.output).write_text(json.dumps(out,ensure_ascii=False,indent=2));print(json.dumps({'output':a.output,'payment_centers':len(pay),'daily_snapshots':len(daily),'daily_total':round(sum(float(x['daily_collection'] or 0) for x in daily),2),'lvzai_source_regions':len(source_regions),'lvzai_mapped_regions':len(mapped),'lvzai_outside_scope':len(outside),'lvzai_unmapped':len(unmapped)},ensure_ascii=False))
if __name__=='__main__':main()
