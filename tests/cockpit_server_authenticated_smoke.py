#!/usr/bin/env python3
"""Run on a cockpit server host; emits only non-secret business/API evidence."""
import base64
import hashlib
import hmac
import json
import os
import sqlite3
import subprocess
import time
import urllib.error
import urllib.request
from pathlib import Path

BASE=os.environ.get('COCKPIT_SMOKE_BASE','http://127.0.0.1:3002')
UNIT=os.environ.get('COCKPIT_SMOKE_UNIT','first-service-cockpit.service')
EXPECTED_RATE_RAW=os.environ.get('COCKPIT_SMOKE_RATE')
EXPECTED_DATE=os.environ.get('COCKPIT_SMOKE_DATE')
EXPECTED_FORMAL_DATE=os.environ.get('COCKPIT_SMOKE_FORMAL_DATE')
EXPECTED_QUALITY_CASES_RAW=os.environ.get('COCKPIT_SMOKE_QUALITY_CASES')
EXPECTED_METHOD=os.environ.get('COCKPIT_SMOKE_METHOD')
EXPECTED_RATE=float(EXPECTED_RATE_RAW) if EXPECTED_RATE_RAW else None
EXPECTED_QUALITY_CASES=int(EXPECTED_QUALITY_CASES_RAW) if EXPECTED_QUALITY_CASES_RAW else None

pid=subprocess.check_output(['systemctl','show',UNIT,'--property=MainPID','--value'],text=True).strip()
if not pid or pid=='0': raise SystemExit(f'unit has no MainPID: {UNIT}')
env={}
for item in Path(f'/proc/{pid}/environ').read_bytes().split(b'\0'):
    if b'=' in item:
        key,value=item.split(b'=',1)
        env[key.decode(errors='ignore')]=value.decode(errors='ignore')
secret=env.get('JWT_SECRET','')
if not secret:
    secret_file=Path(env.get('JWT_SECRET_FILE','/etc/first-service/jwt-secret'))
    if secret_file.is_file(): secret=secret_file.read_text().strip()
if not secret: raise SystemExit('JWT secret unavailable')
db_path=Path(env.get('COCKPIT_DB_PATH','/home/ubuntu/cockpit/cockpit.db'))
db=sqlite3.connect(f'file:{db_path}?mode=ro',uri=True)
row=db.execute("SELECT id,username,role,token_version FROM users WHERE role='admin' ORDER BY id LIMIT 1").fetchone()
db.close()
if not row: raise SystemExit('admin unavailable')

def enc(data): return base64.urlsafe_b64encode(data).rstrip(b'=').decode()
now=int(time.time())
header=enc(b'{"alg":"HS256","typ":"JWT"}')
payload=enc(json.dumps({'userId':row[0],'username':row[1],'role':row[2],'tokenVersion':row[3] or 0,'iat':now,'exp':now+600},separators=(',',':')).encode())
signature=enc(hmac.new(secret.encode(),f'{header}.{payload}'.encode(),hashlib.sha256).digest())
token=f'{header}.{payload}.{signature}'

def request(path):
    req=urllib.request.Request(BASE+path,headers={'Authorization':f'Bearer {token}'})
    try:
        with urllib.request.urlopen(req,timeout=20) as response:
            return response.status,json.load(response)
    except urllib.error.HTTPError as error:
        return error.code,json.loads(error.read().decode())

summary_status,summary=request('/api/summary')
collections_status,collections=request('/api/collections')
alerts_status,alerts=request('/api/alerts')
report_status,report=request('/api/ai/monthly-report')
publication_status,publication=request('/api/data-sources/publication-status')
command_status,command=request('/api/command/data-reliability')
quality_status,quality=request('/api/admin/quality-cases')
gate_status,gate=request('/api/data-quality/project-gate')
assert summary_status==200 and collections_status==200
assert isinstance(collections,list) and len(collections)==35
assert summary.get('collectionPublicationStatus')=='published'
business_date=str(summary.get('collectionBusinessDate') or '')
assert len(business_date)==10 and business_date[4]=='-' and business_date[7]=='-'
if EXPECTED_DATE: assert business_date==EXPECTED_DATE
methodology=str(summary.get('collectionMethodologyVersion') or '')
assert methodology
if EXPECTED_METHOD: assert methodology==EXPECTED_METHOD
summary_rate=float(summary.get('collectionRate'))
assert 0 <= summary_rate <= 1
if EXPECTED_RATE is not None: assert abs(summary_rate-EXPECTED_RATE)<1e-9
public_summary=collections[0].get('_lvzaiSummary',{})
assert public_summary.get('publicationStatus')=='published'
detail_rate=float(public_summary.get('collectionRate'))
assert 0 <= detail_rate <= 1
assert abs(detail_rate-summary_rate)<1e-9
assert alerts_status in (200,409) and report_status in (200,409)
if alerts_status==409: assert alerts.get('code')=='PROJECT_DATA_QUALITY_BLOCKED'
if report_status==409: assert report.get('code')=='PROJECT_DATA_QUALITY_BLOCKED'
assert publication_status==200 and command_status==200 and quality_status==200 and gate_status==200
assert publication.get('code') in ('partial','complete')
assert publication.get('businessDate')==business_date
official_date=str(publication.get('officialBusinessDate') or '')
assert len(official_date)==10 and official_date[4]=='-' and official_date[7]=='-'
assert official_date<=business_date
if EXPECTED_FORMAL_DATE: assert official_date==EXPECTED_FORMAL_DATE
assert len(publication.get('sources') or [])==3
assert command.get('publication',{}).get('code')==publication.get('code')
responsibilities=command.get('qualityCases') or {}
quality_summary=quality.get('summary') or {}
quality_rows=quality.get('rows') or []
assert quality_summary.get('total')==len(quality_rows)
assert responsibilities.get('total')==quality_summary.get('active')
if EXPECTED_QUALITY_CASES is not None: assert len(quality_rows)==EXPECTED_QUALITY_CASES
assert quality_summary.get('overdue')==sum(1 for row in quality_rows if (row.get('timing') or {}).get('isOverdue') is True)
assert gate.get('status') in ('ready','blocked')
assert gate.get('ready') is (gate.get('status')=='ready')
if not gate.get('ready'): assert gate.get('code')=='PROJECT_DATA_QUALITY_BLOCKED' and gate.get('reasons')
secret=''; token=''
print(json.dumps({'unit':UNIT,'summaryStatus':summary_status,'collectionsStatus':collections_status,'collectionRows':len(collections),'collectionRateRatio':summary_rate,'displayPercent':round(summary_rate*100,2),'detailSummaryRateRatio':detail_rate,'businessDate':business_date,'publicationStatus':summary.get('collectionPublicationStatus'),'methodologyVersion':methodology,'r5Publication':{'status':publication_status,'code':publication.get('code'),'businessDate':publication.get('businessDate'),'officialBusinessDate':publication.get('officialBusinessDate'),'sources':len(publication.get('sources') or [])},'projectGate':{'status':gate_status,'code':gate.get('code'),'ready':gate.get('ready'),'reasons':gate.get('reasons')},'qualityResponsibilities':{'status':quality_status,'total':quality_summary.get('total'),'active':quality_summary.get('active'),'unassigned':quality_summary.get('unassigned'),'overdue':quality_summary.get('overdue')},'commandReliabilityStatus':command_status,'alerts':{'status':alerts_status,'code':alerts.get('code')},'monthlyReport':{'status':report_status,'code':report.get('code')}},ensure_ascii=False))
