import assert from "node:assert/strict";
import test from "node:test";

async function render(pathname = "/") {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}-${pathname}`);
  const { default: worker } = await import(workerUrl.href);

  return worker.fetch(
    new Request(`http://localhost${pathname}`, {
      headers: { accept: "text/html" },
    }),
    {
      ASSETS: {
        fetch: async () => new Response("Not found", { status: 404 }),
      },
    },
    {
      waitUntil() {},
      passThroughOnException() {},
    },
  );
}

test("服务端渲染经营驾驶舱首页", async () => {
  const response = await render();
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/html\b/i);

  const html = await response.text();
  assert.match(html, /<title>第一服务华北地区经营驾驶舱<\/title>/);
  assert.match(html, /首页总览/);
  assert.match(html, /驾驶舱看板/);
  assert.match(html, /经营指挥台/);
  assert.match(html, /每日回款/);
  assert.match(html, /经营分析/);
  assert.match(html, /异常预警/);
  assert.match(html, /业务入口/);
  assert.match(html, /任务闭环/);
  assert.match(html, /AI 月报/);
  assert.match(html, /研发审核/);
  assert.match(html, /数据管理/);
  assert.match(html, /回款/);
  assert.match(html, /收缴率/);
  assert.match(html, /预算完成率/);
  assert.match(html, /欠费金额/);
  assert.match(html, /企业微信待接入/);
  assert.doesNotMatch(html, /codex-preview|Your site is taking shape/);
});

test("服务端渲染多页面和只读业务模块", async () => {
  const [analysisResponse, projectsResponse, reviewResponse] = await Promise.all([
    render("/analysis"),
    render("/projects"),
    render("/review"),
  ]);

  for (const response of [analysisResponse, projectsResponse, reviewResponse]) {
    assert.equal(response.status, 200);
  }

  const analysis = await analysisResponse.text();
  const projects = await projectsResponse.text();
  const review = await reviewResponse.text();

  assert.match(analysis, /同比、环比、目标差额均读取 API/);
  assert.match(analysis, /导出 Excel/);
  assert.match(projects, /项目 → 楼栋 → 房间\/业主/);
  assert.match(projects, /暂不提供导出/);
  assert.match(projects, /默认脱敏/);
  assert.match(review, /研发审核/);
  assert.match(review, /审核中心/);
  assert.match(review, /专业知识库/);
  assert.match(review, /账号安全分析/);
  assert.match(review, /只读/);
});
