import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

const root = path.resolve(import.meta.dirname, "..");
const releaseDir = path.join(root, "firstcare-cloud-local", "assets", "sortfix-20260806-percentcap1");
const helperPath = path.join(releaseDir, "chunk-COMPLETIONCAP.js");

async function source(name) {
  return readFile(path.join(releaseDir, name), "utf8");
}

test("共享完成率工具按真实比例排序，仅封顶条形宽度，不改写原始值", async () => {
  const helpers = await import(`${pathToFileURL(helperPath).href}?t=${Date.now()}`);
  assert.equal(helpers.capCompletionRate(1.2), 1);
  assert.equal(helpers.capCompletionRate(1), 1);
  assert.equal(helpers.capCompletionRate(0.8842), 0.8842);
  assert.ok(Number.isNaN(helpers.capCompletionRate(null)));
  assert.equal(helpers.formatCompletionRate(1.2), "120.00%");
  assert.equal(helpers.formatCompletionRate(2.9), "290.00%");
  assert.equal(helpers.formatCompletionRate(0.8842), "88.42%");
  assert.equal(helpers.formatCompletionRate(null), "—");
  assert.equal(helpers.completionBarPercent(1.2), 100);
  assert.equal(helpers.completionBarPercent(2.9), 100);
  assert.equal(helpers.completionBarPercent(0.8842), 88.42);

  const rows = [
    { name: "丁", rate: 2.9 },
    { name: "乙", rate: 1.2 },
    { name: "甲", rate: 1 },
    { name: "丙", rate: 0.99 },
  ];
  const sorted = [...rows].sort((left, right) => helpers.compareCompletionRate(left.rate, right.rate, "desc", left.name, right.name));
  assert.deepEqual(sorted.map((row) => row.name), ["丁", "乙", "甲", "丙"], "完成率必须按真实值290% > 120% > 100% > 99%排序");
  assert.equal(rows[0].rate, 2.9, "原始超额率必须保留");
});

test("首页地图进入页面即加载，片区按真实百分比排序和显示、条形宽度封顶", async () => {
  const home = await source("chunk-C5JXPXJ4.js");
  const map = await source("chunk-XGALVLQQ.js");
  assert.match(home, /\[G, J\] = hl\.useState\(true\)/);
  assert.match(home, /compareCompletionRate\(a2\.rate, n\.rate, "desc", a2\.area, n\.area\)/);
  assert.match(home, /formatCompletionRate\(t\.rate\)/);
  assert.match(home, /completionBarPercent\(t\.rate\)/);
  assert.match(home, /formatCompletionRate\(s2\.annualRate\)/);
  assert.match(home, /formatCompletionRate\(s2\.collectionRate\)/);
  assert.match(home, /formatCompletionRate\(s2\.cumulativeRate\)/);
  assert.match(map, /formatCompletionRate\(f\.rate\)/);
  assert.match(map, /formatCompletionRate\(r5\.rate\)/);
});

test("回款额执行评估显示并按真实超额比例排序，进度条以100%封顶", async () => {
  const payment = await source("chunk-5G47Z27Q.js");
  assert.match(payment, /a4 === "annualRate" \|\| a4 === "cumulativeRate"/);
  assert.match(payment, /compareCompletionRate\(c3\[a4\], _\[a4\], o3, c3\.center, _\.center\)/);
  assert.match(payment, /formatCompletionRate\(a4\)/);
  assert.match(payment, /completionBarPercent\(t2\.annualRate\)/);
  assert.match(payment, /completionBarPercent\(t2\.cumulativeRate\)/);
});

test("每日回款明细新增完成率列并以今日累计除累计预算，默认按真实完成率降序", async () => {
  const daily = await source("chunk-24D7OGMQ.js");
  assert.match(daily, /key: "completionRate", label: "\\u5B8C\\u6210\\u7387"/);
  assert.match(daily, /dailyCompletionRate\(e3\)/);
  assert.match(daily, /hl\.useState\("completionRate"\)/);
  assert.match(daily, /compareCompletionRate\(dailyCompletionRate\(e3\), dailyCompletionRate\(s\), c, e3\.center, s\.center\)/);
  assert.match(daily, /formatCompletionRate\(dailyCompletionRate\(e3\)\)/);
});

test("收缴率显示并按真实超额比例排序，进度条以100%封顶", async () => {
  const collection = await source("chunk-D3P3MDJ2.js");
  assert.match(collection, /sortKey === "rate"/);
  assert.match(collection, /compareCompletionRate\(left\.rate, right\.rate, sortDirection, left\.center, right\.center\)/);
  assert.match(collection, /formatCompletionRate\(c3\.rate\)/);
  assert.match(collection, /formatCompletionRate\(x2\)/);
  assert.match(collection, /completionBarPercent\(c3\.rate\)/);
  assert.doesNotMatch(collection, /i2\.map\(\(row\) => Object\.fromEntries\(Object\.entries\(row\).*capCompletionRate\(value\)/);
});
