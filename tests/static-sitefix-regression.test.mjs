import assert from "node:assert/strict";
import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";

const root = path.resolve(import.meta.dirname, "..");
const staticRoot = path.join(root, "firstcare-cloud-local");
const indexPath = path.join(staticRoot, "index.html");

async function activeRelease() {
  const html = await readFile(indexPath, "utf8");
  const match = html.match(/\/assets\/([^/]+)\/app-[^"']+\.js/);
  assert.ok(match, "index.html 应指向版本化 SPA 入口");
  return { html, name: match[1], dir: path.join(staticRoot, "assets", match[1]) };
}

async function jsSources(dir) {
  const names = (await readdir(dir)).filter((name) => name.endsWith(".js"));
  return Promise.all(names.map(async (name) => ({ name, source: await readFile(path.join(dir, name), "utf8") })));
}

async function sourceContaining(dir, needle) {
  const matches = (await jsSources(dir)).filter(({ source }) => source.includes(needle));
  assert.equal(matches.length, 1, `应仅有一个活动 chunk 包含 ${needle}`);
  return matches[0];
}

function extractRedirectSanitizer(source) {
  const match = source.match(/function f\(e = "\/"\) \{[\s\S]*?\n\}/);
  assert.ok(match, "应找到登录 redirect 清洗函数");
  const context = vm.createContext({ URL, window: { location: { origin: "https://cockpit.example" } } });
  return vm.runInContext(`(${match[0]})`, context);
}

test("不可变发布切换到 R6 且旧含共享凭据版本已移出公开根", async () => {
  const { html, name } = await activeRelease();
  assert.equal(name, "cockpit-r51-cloud-remediation-20260812-v1");
  assert.doesNotMatch(html, /sortfix-20260805-percent2\/app-/);
  await assert.rejects(stat(path.join(staticRoot, "assets", "sortfix-20260805-percent2")), (error) => error?.code === "ENOENT");
  assert.equal((await stat(path.join(root, "backups", "site-fix-pre-20260806-121827", "retired-public-review-assets", "sortfix-20260805-percent2"))).isDirectory(), true);
});

test("每日明细先从 dates 选择最新有效日期再请求明细，并提供日期可访问名称", async () => {
  const { dir } = await activeRelease();
  const { source } = await sourceContaining(dir, "/api/daily/dates");

  assert.match(source, /useState\(""\)/, "初始日期必须为空，不能先请求无快照的当天");
  assert.ok(source.includes(".filter((s) => /^\\d{4}-\\d{2}-\\d{2}$/.test(s))"), "必须过滤有效 ISO 日期");
  assert.match(source, /sort\(\(s, n\) => n\.localeCompare\(s\)\)/, "必须按日期降序选择最新值");
  assert.match(source, /f2\([^)]*\[0\][^)]*\)/, "dates 返回后必须设置最新有效日期");
  assert.match(source, /if \(!o\) return;/, "日期未确定前不得请求 daily 明细");
  assert.match(source, /type: "date", value: o,[^}]*"aria-label": "\\u67E5\\u8BE2\\u65E5\\u671F"/, "日期 input 必须有 aria-label=查询日期");
});

test("登录 redirect 仅接受同源相对业务路径", async () => {
  const { dir } = await activeRelease();
  const { source } = await sourceContaining(dir, "loginRedirect");
  const sanitize = extractRedirectSanitizer(source);

  for (const value of ["/review?id=1#risk", "/daily", "/login-help"]) {
    assert.equal(sanitize(value), value, `应保留合法路径 ${value}`);
  }
  for (const value of [
    "//evil.example/steal",
    "/\\evil.example/steal",
    "https://evil.example/steal",
    "javascript:alert(1)",
    "/login",
    "/login?redirect=/daily",
    "/login/again",
  ]) {
    assert.equal(sanitize(value), "/", `应拒绝不安全 redirect ${value}`);
  }
});

test("移动端 AI 入口使用安全区内的紧凑按钮，桌面悬浮规则保持不变", async () => {
  const { html } = await activeRelease();
  const cssHref = html.match(/href="\/(north-ai-assistant-[^"]+\.css)(?:\?[^" ]*)?"/)?.[1];
  assert.ok(cssHref, "index.html 应引用 north-ai CSS");
  const css = await readFile(path.join(staticRoot, cssHref), "utf8");

  assert.match(css, /\.north-ai-launcher\s*\{[\s\S]*?position:\s*fixed;[\s\S]*?right:\s*18px;[\s\S]*?bottom:\s*18px;/, "桌面入口定位不得回归");
  const mobile = css.slice(css.lastIndexOf("@media (max-width: 640px)"));
  assert.match(mobile, /\.north-ai-launcher\s*\{[^}]*bottom:\s*max\([^;]*env\(safe-area-inset-bottom\)[^;]*\);[^}]*width:\s*44px;[^}]*min-height:\s*44px;/s);
  assert.match(mobile, /\.north-ai-launcher-mark\s*\{[^}]*width:\s*34px;[^}]*height:\s*34px;/s);
});

test("项目主数据页在390px下约束网格宽度并由表格容器独立横向滚动", async () => {
  const css = await readFile(path.join(staticRoot, "aph2-theme.css"), "utf8");
  assert.match(css, /\.aph-project-profile-page\s*\{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\)[^}]*min-width:\s*0/s);
  const mobile = css.slice(css.indexOf("@media (max-width: 760px)"));
  assert.match(mobile, /\.aph-project-table-card\s*\{[^}]*min-width:\s*0[^}]*max-width:\s*100%[^}]*overflow:\s*hidden/s);
  assert.match(mobile, /\.aph-project-table-wrap\s*\{[^}]*max-width:\s*100%[^}]*overflow-x:\s*auto/s);
});
