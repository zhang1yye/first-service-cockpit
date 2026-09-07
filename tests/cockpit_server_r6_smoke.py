#!/usr/bin/env python3
"""在驾驶舱主机执行的 R6 只读烟测；不输出凭据。"""
import base64, hashlib, hmac, json, os, sqlite3, subprocess, time, urllib.request
from pathlib import Path

BASE = os.environ.get('COCKPIT_SMOKE_BASE', 'http://127.0.0.1:3002')
UNIT = os.environ.get('COCKPIT_SMOKE_UNIT', 'first-service-cockpit.service')
pid = subprocess.check_output(['systemctl', 'show', UNIT, '--property=MainPID', '--value'], text=True).strip()
env = {}
for item in Path(f'/proc/{pid}/environ').read_bytes().split(b'\0'):
    if b'=' in item:
        key, value = item.split(b'=', 1)
        env[key.decode(errors='ignore')] = value.decode(errors='ignore')
secret = env.get('JWT_SECRET', '')
if not secret:
    secret_file = Path(env.get('JWT_SECRET_FILE', '/etc/first-service/jwt-secret'))
    if secret_file.is_file(): secret = secret_file.read_text().strip()
if not secret: raise SystemExit('JWT secret unavailable')
db_path = Path(env.get('COCKPIT_DB_PATH', '/home/ubuntu/cockpit/cockpit.db'))
db = sqlite3.connect(f'file:{db_path}?mode=ro', uri=True)
user = db.execute("SELECT id,username,role,token_version FROM users WHERE role='admin' ORDER BY id LIMIT 1").fetchone()
db.close()
if not user: raise SystemExit('admin unavailable')

def enc(data): return base64.urlsafe_b64encode(data).rstrip(b'=').decode()
now = int(time.time())
header = enc(b'{"alg":"HS256","typ":"JWT"}')
payload = enc(json.dumps({'userId': user[0], 'username': user[1], 'role': user[2], 'tokenVersion': user[3] or 0, 'iat': now, 'exp': now + 600}, separators=(',', ':')).encode())
signature = enc(hmac.new(secret.encode(), f'{header}.{payload}'.encode(), hashlib.sha256).digest())
token = f'{header}.{payload}.{signature}'

def request(path):
    req = urllib.request.Request(BASE + path, headers={'Authorization': f'Bearer {token}'})
    with urllib.request.urlopen(req, timeout=20) as response:
        return response.status, json.load(response)

summary_status, summary = request('/api/summary')
collections_status, collections = request('/api/collections')
publication_status, publication = request('/api/data-sources/publication-status')
command_status, command = request('/api/command/data-reliability')
dates_status, dates = request('/api/daily/dates')
projects_status, projects = request('/api/project-profiles/summary')
assert all(status == 200 for status in [summary_status, collections_status, publication_status, command_status, dates_status, projects_status])
assert isinstance(collections, list) and len(collections) > 0
summary_rate = float(summary.get('collectionRate'))
detail_rate = float((collections[0].get('_lvzaiSummary') or {}).get('collectionRate'))
assert 0 <= summary_rate <= 1 and abs(summary_rate - detail_rate) < 1e-9
assert len(publication.get('sources') or []) == 3
assert len((command.get('publication') or {}).get('sources') or []) == 3
assert int((projects.get('totals') or {}).get('profiles') or 0) > 0

daily_evidence = {'dates': len(dates), 'status': 'no-date'}
if dates:
    latest = str(dates[0].get('date'))
    daily_status, daily = request(f'/api/daily?date={latest}')
    assert daily_status == 200
    source_status = daily.get('sourceStatus')
    if source_status == 'missing':
        assert daily.get('dailyTotal') is None
        assert all(row.get('daily') is None for row in daily.get('rows') or [])
    daily_evidence = {'dates': len(dates), 'latest': latest, 'sourceStatus': source_status, 'dailyTotalKnown': daily.get('dailyTotal') is not None}

secret = token = ''
print(json.dumps({
    'unit': UNIT,
    'collectionRows': len(collections),
    'collectionBusinessDate': summary.get('collectionBusinessDate'),
    'collectionRateRatio': summary_rate,
    'publication': {'code': publication.get('code'), 'businessDate': publication.get('businessDate'), 'officialBusinessDate': publication.get('officialBusinessDate')},
    'qualityCases': (command.get('qualityCases') or {}).get('total'),
    'projectProfiles': (projects.get('totals') or {}).get('profiles'),
    'daily': daily_evidence,
}, ensure_ascii=False))
