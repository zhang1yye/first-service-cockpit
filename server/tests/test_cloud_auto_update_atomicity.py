from pathlib import Path
import unittest

ROOT = Path('/home/ubuntu/cockpit/scripts')

class AutoUpdateAtomicityTest(unittest.TestCase):
    def text(self, name):
        return (ROOT / name).read_text(encoding='utf-8')

    def test_lvzai_login_reuses_linux_chromium(self):
        text = self.text('lvzai-login.py')
        self.assertIn('def chromium_executable', text)
        self.assertIn('executable_path=chromium_executable()', text)
        self.assertNotIn('~/Library/Caches/ms-playwright', text)
        self.assertLess(
            text.index('~/.cache/agent-browser/chrome/*/chrome-linux64/chrome'),
            text.index('/usr/bin/chromium-browser'),
            '受控Chrome for Testing必须优先于可能触发snap cgroup限制的系统包装器',
        )

    def test_both_extractors_support_shadow_database(self):
        self.assertIn('COCKPIT_DB_PATH', self.text('scrape_and_import.py'))
        self.assertIn('COCKPIT_DB_PATH', self.text('import-lvzai-api.py'))
        self.assertIn('COCKPIT_ROOT', self.text('import-lvzai-api.py'))

    def test_child_aph_extractor_does_not_advance_success_marker(self):
        text = self.text('scrape_and_import.py')
        self.assertNotIn("open(os.path.join(os.path.dirname(DB), '.last_sync')", text)

    def test_wrapper_uses_shadow_db_and_publishes_only_after_both_gates(self):
        text = Path('/home/ubuntu/.hermes/scripts/daily-cockpit-scrape.sh').read_text(encoding='utf-8')
        for marker in ('STAGE_DB=', 'COCKPIT_DB_PATH="$STAGE_DB"', 'commit_stage', 'rollback_production'):
            self.assertIn(marker, text)
        self.assertIn('APH_MAX_ATTEMPTS=${APH_MAX_ATTEMPTS:-2}', text)
        self.assertIn('LVZAI_MAX_ATTEMPTS=${LVZAI_MAX_ATTEMPTS:-2}', text)
        aph_publish = text.index('"$SYSTEM_PYTHON" "$SYNC_APH_SCRIPT"')
        lvzai_gate = text.index('LVZAI_GATE_OK')
        self.assertGreater(aph_publish, lvzai_gate)
        self.assertNotIn('PLAYWRIGHT_BROWSERS_PATH=os.path.expanduser("~/Library/Caches/ms-playwright")', self.text('import-lvzai-api.py'))



from pathlib import Path
import json, os, sqlite3, subprocess, tempfile, textwrap, unittest

WRAPPER = Path('/home/ubuntu/.hermes/scripts/daily-cockpit-scrape.sh')
TODAY = '2026-08-08'

class AtomicUpdateBehaviorTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name) / 'cockpit'
        self.root.mkdir()
        (self.root / 'logs').mkdir()
        (self.root / 'scripts').mkdir()
        self.db = self.root / 'cockpit.db'
        con = sqlite3.connect(self.db)
        con.executescript('''
          create table payment_centers(area text,center text,annual_budget real,cumulative_budget real,cumulative_executed real,same_period real,collection_rate real);
          create table daily_snapshots(date text,center text,annual_budget real,cumulative_budget real,cumulative_executed real,daily_collection real,quality_status text,quality_reason text,source text,source_status text,business_date text,last_validated_at text,field_provenance text);
          create table collection_centers(area text,center text,receivable real,received real);
        ''')
        for i in range(56):
            con.execute('insert into payment_centers values(?,?,?,?,?,?,?)',('A',f'P{i}',500,100,100,90,.5))
        for i in range(35): con.execute('insert into collection_centers values(?,?,?,?)',('A',f'C{i}',10,5))
        con.commit(); con.close()
        (self.root / 'APH决策_每日提取.json').write_text('{"old":true}',encoding='utf-8')
        (self.root / '.last_sync').write_text('111',encoding='utf-8')
        self.envfile = Path(self.tmp.name) / 'env'
        self.envfile.write_text('APH_USER=x\nAPH_PWD=x\nLVZAI_PWD=x\n',encoding='utf-8')
        self.aph = self.write_script('aph.py', '''
import json,os,sqlite3
from datetime import datetime
p=os.environ['COCKPIT_DB_PATH'];d=os.environ['COCKPIT_DATA_DIR'];today='2026-08-08'
c=sqlite3.connect(p);c.execute('update payment_centers set cumulative_executed=200');c.execute('delete from daily_snapshots where date=?',(today,))
for i in range(56): c.execute('insert into daily_snapshots values(?,?,?,?,?,?,?,?,?,?,?,?,?)',(today,f'P{i}',500,100,200,1,'verified','','src','available',today,today+'T17:30:00','{}'))
c.commit();c.close();os.makedirs(d,exist_ok=True)
raw={'sourceStatus':'available','businessDate':today,'date':today}
open(os.path.join(d,f'APH决策_每日提取_{today}.json'),'w').write(json.dumps(raw))
''')
        self.sync = self.write_script('sync.py', '''
import os,shutil
src=os.path.join(os.environ['COCKPIT_DATA_DIR'],'APH决策_每日提取_2026-08-08.json');dst=os.path.join(os.environ['COCKPIT_ROOT'],'APH决策_每日提取.json');shutil.copy2(src,dst)
''')

    def tearDown(self): self.tmp.cleanup()

    def write_script(self,name,body):
        p=Path(self.tmp.name)/name;p.write_text(textwrap.dedent(body),encoding='utf-8');return p

    def run_wrapper(self, lvzai, aph=None):
        env=dict(os.environ,COCKPIT_TEST_MODE='1',COCKPIT_LIVE_ROOT=str(self.root),COCKPIT_LIVE_DB=str(self.db),COCKPIT_ENV_FILE=str(self.envfile),SCRAPER_PYTHON='python3',SYSTEM_PYTHON='python3',APH_SCRIPT=str(aph or self.aph),LVZAI_SCRIPT=str(lvzai),SYNC_APH_SCRIPT=str(self.sync),COCKPIT_LOCK=str(Path(self.tmp.name)/'lock'),COCKPIT_STAGE_DIR=str(Path(self.tmp.name)/'stage'),COCKPIT_BACKUP_DIR=str(Path(self.tmp.name)/'backup'))
        return subprocess.run(['bash',str(WRAPPER)],env=env,capture_output=True,text=True,timeout=30)

    def test_lvzai_failure_keeps_production_unchanged(self):
        bad=self.write_script('lvzai_fail.py','raise SystemExit(42)\n')
        result=self.run_wrapper(bad)
        self.assertNotEqual(result.returncode,0,result.stdout+result.stderr)
        con=sqlite3.connect(self.db)
        self.assertEqual(con.execute('select distinct cumulative_executed from payment_centers').fetchall(),[(100.0,)])
        self.assertEqual(con.execute('select count(*) from daily_snapshots where date=?',(TODAY,)).fetchone()[0],0)
        con.close()
        self.assertEqual((self.root/'.last_sync').read_text(),'111')
        self.assertEqual(json.loads((self.root/'APH决策_每日提取.json').read_text()),{'old':True})
        self.assertIn('production unchanged',result.stdout)

    def test_success_commits_both_sources_and_marker(self):
        good=self.write_script('lvzai_ok.py', '''
import json,os,sqlite3
p=os.environ['COCKPIT_DB_PATH'];root=os.environ['COCKPIT_ROOT'];today='2026-08-08';c=sqlite3.connect(p);c.execute('update collection_centers set received=8');c.commit();c.close();os.makedirs(root,exist_ok=True)
summary={'date':today,'extractedAt':today+'T17:31:00'};detail={'rows':[{'center':str(i)} for i in range(35)],'extractedAt':summary['extractedAt']}
for n,o in [('绿仔收款汇总.json',summary),('绿仔收缴明细.json',detail),('绿仔同步状态.json',{'ok':True,'date':today})]: open(os.path.join(root,n),'w').write(json.dumps(o))
''')
        result=self.run_wrapper(good)
        self.assertEqual(result.returncode,0,result.stdout+result.stderr)
        con=sqlite3.connect(self.db)
        self.assertEqual(con.execute('select distinct cumulative_executed from payment_centers').fetchall(),[(200.0,)])
        self.assertEqual(con.execute('select count(*) from daily_snapshots where date=?',(TODAY,)).fetchone()[0],56)
        self.assertEqual(con.execute('select distinct received from collection_centers').fetchall(),[(8.0,)])
        con.close()
        self.assertNotEqual((self.root/'.last_sync').read_text(),'111')
        self.assertEqual(json.loads((self.root/'APH决策_每日提取.json').read_text())['date'],TODAY)
        self.assertIn('SYNC_OK:',result.stdout)

    def test_transient_aph_and_lvzai_failures_retry_once(self):
        aph_counter=Path(self.tmp.name)/'aph-counter'
        lvzai_counter=Path(self.tmp.name)/'lvzai-counter'
        flaky_aph=self.write_script('aph_flaky.py', f'''
import pathlib,runpy
p=pathlib.Path({str(aph_counter)!r});n=int(p.read_text())+1 if p.exists() else 1;p.write_text(str(n))
if n==1: raise SystemExit(31)
runpy.run_path({str(self.aph)!r},run_name='__main__')
''')
        good_body='''
import json,os,sqlite3
p=os.environ['COCKPIT_DB_PATH'];root=os.environ['COCKPIT_ROOT'];today='2026-08-08';c=sqlite3.connect(p);c.execute('update collection_centers set received=9');c.commit();c.close();os.makedirs(root,exist_ok=True)
summary={'date':today,'extractedAt':today+'T17:31:00'};detail={'rows':[{'center':str(i)} for i in range(35)],'extractedAt':summary['extractedAt']}
for n,o in [('绿仔收款汇总.json',summary),('绿仔收缴明细.json',detail),('绿仔同步状态.json',{'ok':True,'date':today})]: open(os.path.join(root,n),'w').write(json.dumps(o))
'''
        flaky_lvzai=self.write_script('lvzai_flaky.py', f'''
import pathlib
p=pathlib.Path({str(lvzai_counter)!r});n=int(p.read_text())+1 if p.exists() else 1;p.write_text(str(n))
if n==1: raise SystemExit(32)
{good_body}
''')
        result=self.run_wrapper(flaky_lvzai, flaky_aph)
        self.assertEqual(result.returncode,0,result.stdout+result.stderr)
        self.assertEqual(aph_counter.read_text(),'2')
        self.assertEqual(lvzai_counter.read_text(),'2')
        self.assertIn('RETRY',result.stdout)



if __name__ == "__main__": unittest.main(verbosity=2)
