#!/usr/bin/env python3
import json,os,shutil,sqlite3,subprocess,urllib.request,datetime,ssl,socket
from pathlib import Path
ROOT=Path(os.environ.get('COCKPIT_ROOT','/home/ubuntu/cockpit'));OUT=ROOT/'runtime/production-monitor-status.json';OUT.parent.mkdir(parents=True,exist_ok=True)
def cmd(args):
 try:return subprocess.run(args,text=True,capture_output=True,timeout=20)
 except Exception as e:return type('R',(),{'returncode':1,'stdout':'','stderr':str(e)})()
def url(url):
 try:
  with urllib.request.urlopen(url,timeout=15) as r:return r.status
 except Exception:return 0
now=datetime.datetime.now(datetime.timezone.utc);fail=[];warn=[]
service=cmd(['systemctl','is-active','first-service-cockpit']).stdout.strip();main=cmd(['systemctl','show','first-service-cockpit','-p','MainPID','--value']).stdout.strip();ss=cmd(['ss','-ltnp','sport = :3002']).stdout
listeners=max(0,len([x for x in ss.splitlines() if 'LISTEN' in x]));owner='systemd' if main and main!='0' and f'pid={main}' in ss else ('none' if listeners==0 else 'foreign')
ready=url('http://127.0.0.1:3002/api/health/ready');https=url('https://www.firstcare.cloud/api/health/ready');disk=shutil.disk_usage('/');disk_pct=round(disk.used*100/disk.total,1)
tls_days=None
try:
 ctx=ssl.create_default_context()
 with socket.create_connection(('www.firstcare.cloud',443),timeout=10) as s:
  with ctx.wrap_socket(s,server_hostname='www.firstcare.cloud') as t:
   exp=datetime.datetime.strptime(t.getpeercert()['notAfter'],'%b %d %H:%M:%S %Y %Z').replace(tzinfo=datetime.timezone.utc);tls_days=(exp-now).days
except Exception:fail.append('TLS证书读取失败')
if service!='active':fail.append('systemd服务非active')
if listeners!=1 or owner!='systemd':fail.append(f'3002监听异常：{listeners}/{owner}')
if ready!=200:fail.append(f'本机ready={ready}')
if https!=200:fail.append(f'HTTPS ready={https}')
if disk_pct>=90:fail.append(f'磁盘使用率{disk_pct}%')
elif disk_pct>=80:warn.append(f'磁盘使用率{disk_pct}%')
if tls_days is not None and tls_days<=14:fail.append(f'TLS证书仅剩{tls_days}天')
elif tls_days is not None and tls_days<=45:warn.append(f'TLS证书仅剩{tls_days}天，且自动续期需复核')
def readj(p):
 try:return json.loads(Path(p).read_text())
 except:return None
backup=readj(ROOT/'backups/status/backup-status.json');offsite=readj(ROOT/'runtime/offsite-backup-status.json')
def age(x,k='finished_at'):
 try:return round((now-datetime.datetime.fromisoformat(str(x[k]).replace('Z','+00:00'))).total_seconds()/3600,1)
 except:return None
backup_age=age(backup or {});offsite_age=age(offsite or {})
if backup_age is None or backup_age>26:fail.append('本机备份超过26小时或无记录')
if offsite_age is None:warn.append('异地备份尚无成功记录')
elif offsite_age>30:fail.append(f'异地备份超过30小时：{offsite_age}h')
try:
 c=sqlite3.connect(ROOT/'cockpit.db');archives=c.execute('select count(*) from formal_output_archives').fetchone()[0];c.close()
except Exception:archives=None;fail.append('数据库不可读')
status='failure' if fail else ('warning' if warn else 'success');payload={'checked_at':now.isoformat(),'status':status,'service_active':service,'main_pid':main,'listener_count':listeners,'listener_owner':owner,'ready_status':ready,'https_status':https,'tls_days_remaining':tls_days,'disk_percent':disk_pct,'backup_age_hours':backup_age,'offsite_age_hours':offsite_age,'formal_archive_count':archives,'failures':fail,'warnings':warn,'alert_delivery':'disabled' if not os.environ.get('COCKPIT_ALERT_WEBHOOK') else 'not-triggered'}
prev=readj(OUT);OUT.write_text(json.dumps(payload,ensure_ascii=False,indent=2))
webhook=os.environ.get('COCKPIT_ALERT_WEBHOOK','')
if webhook and fail and (not prev or prev.get('status')!='failure' or prev.get('failures')!=fail):
 try:
  req=urllib.request.Request(webhook,data=json.dumps({'msgtype':'text','text':{'content':'华北驾驶舱生产告警：'+'；'.join(fail)}}).encode(),headers={'Content-Type':'application/json'});urllib.request.urlopen(req,timeout=10);payload['alert_delivery']='sent';OUT.write_text(json.dumps(payload,ensure_ascii=False,indent=2))
 except Exception as e:payload['alert_delivery']='failed';payload['alert_error']=str(e)[:200];OUT.write_text(json.dumps(payload,ensure_ascii=False,indent=2))
print(json.dumps(payload,ensure_ascii=False))
raise SystemExit(1 if fail else 0)
