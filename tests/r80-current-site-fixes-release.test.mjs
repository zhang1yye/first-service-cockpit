import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const js = readFileSync(new URL("../firstcare-cloud-local/aph2-r80-current-site-fixes-20260816-v1.js", import.meta.url), "utf8");
const css = readFileSync(new URL("../firstcare-cloud-local/aph2-r80-current-site-fixes-20260816-v1.css", import.meta.url), "utf8");

test("欠费路由和链接统一为带斜杠的独立应用入口", () => {
  assert.match(js, /location\.pathname === "\/arrears"/);
  assert.match(js, /location\.replace\("\/arrears\/"/);
  assert.match(js, /url\.pathname = "\/arrears\/"/);
});

test("移动首页只保留一次导航避让", () => {
  assert.match(css, /data-r42-route="home"[\s\S]*main#main-content[\s\S]*padding-top: 64px !important/);
  assert.match(css, /aph-home-reflow[\s\S]*padding-top: 0 !important/);
});

test("后台页签在移动导航后占位，不再覆盖状态栏", () => {
  assert.match(css, /\.r65-tabs[\s\S]*top: 52px !important[\s\S]*margin-top: 52px !important/);
});

test("AI 列表分页保留完整行与原 details 交互", () => {
  assert.match(js, /PAGE_SIZE = 12/);
  assert.match(js, /r56-center-row/);
  assert.doesNotMatch(js, /innerHTML\s*=/);
  assert.match(css, /r56-center-row\[hidden\]/);
});

test("保护已验收业务页与数据边界", () => {
  assert.doesNotMatch(css, /data-r42-route="(?:daily|payment|collection)"/);
  assert.doesNotMatch(js, /fetch\s*\(|XMLHttpRequest|\/api\//);
  assert.doesNotMatch(js + css, /mock|demo|Math\.random/);
});
