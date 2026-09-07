"use client";

/* APH 使用本地原始尺寸图标，避免图像优化改变锐度和尺寸。 */
/* eslint-disable @next/next/no-img-element */

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";

type SectionKey =
  | "overview"
  | "analysis"
  | "alerts"
  | "business"
  | "command"
  | "payment"
  | "daily"
  | "finance"
  | "collection"
  | "projects"
  | "tasks"
  | "ai-alerts"
  | "ai-report"
  | "reports"
  | "review"
  | "admin";

type ApiState = {
  loading: boolean;
  message: string;
  updatedAt: string | null;
  overview: Record<string, unknown> | null;
  trend: Array<Record<string, unknown>>;
  ranking: Array<Record<string, unknown>>;
  alerts: Array<Record<string, unknown>>;
  projects: Array<Record<string, unknown>>;
};

const sectionNames: Record<SectionKey, string> = {
  overview: "首页总览",
  analysis: "经营分析",
  alerts: "异常预警",
  business: "业务入口",
  command: "经营指挥台",
  payment: "回款额执行评估",
  daily: "每日回款明细",
  finance: "财务",
  collection: "收缴率明细",
  projects: "项目管理",
  tasks: "任务闭环",
  "ai-alerts": "AI 预警中心",
  "ai-report": "AI 经营月报",
  reports: "月报",
  review: "研发小组审核系统",
  admin: "数据管理",
};

const primaryNav: Array<[SectionKey, string]> = [
  ["overview", "驾驶舱看板"],
  ["command", "经营指挥台"],
  ["payment", "回款评估"],
  ["daily", "每日回款"],
  ["projects", "项目管理"],
  ["collection", "收缴明细"],
  ["ai-alerts", "AI 预警"],
  ["tasks", "任务闭环"],
  ["ai-report", "AI 月报"],
  ["review", "研发审核"],
  ["admin", "数据管理"],
  ["analysis", "经营分析"],
  ["alerts", "异常预警"],
  ["business", "业务入口"],
];

const businessEntries: Array<[SectionKey, string, string]> = [
  ["payment", "回款额执行评估", "预算、执行、完成率与目标差额"],
  ["daily", "每日回款明细", "按日期、片区和项目查看回款"],
  ["projects", "项目管理", "片区、项目、楼栋与房间下钻"],
  ["collection", "收缴率明细", "应收、实收、收缴率与欠费"],
  ["ai-alerts", "AI 预警中心", "经营异常识别与详情查看"],
  ["tasks", "任务闭环", "关联异常、责任人与处理状态"],
  ["ai-report", "AI 经营月报", "月度经营总结与管理建议"],
  ["review", "研发小组审核", "方案提交、专业审核与归档"],
  ["admin", "数据管理", "用户、权限、数据源与审计"],
];

const sectionIcons: Partial<Record<SectionKey, string>> = {
  overview: "/aph-icons/shouyeF.png",
  command: "/aph-icons/RectangleCopy.png",
  payment: "/aph-icons/caiwu.png",
  daily: "/aph-icons/renliziyuan.png",
  projects: "/aph-icons/shangye.png",
  collection: "/aph-icons/fangchanwuye.png",
  "ai-alerts": "/aph-icons/chengbentongjifenxi.png",
  tasks: "/aph-icons/renliziyuan.png",
  "ai-report": "/aph-icons/jiaoyu.png",
  review: "/aph-icons/tiyukebu.png",
  admin: "/aph-icons/jurassic_users.png",
  analysis: "/aph-icons/RectangleCopy.png",
  alerts: "/aph-icons/chengbentongjifenxi.png",
  business: "/aph-icons/hehuoren.png",
};

const emptyState: ApiState = {
  loading: true,
  message: "",
  updatedAt: null,
  overview: null,
  trend: [],
  ranking: [],
  alerts: [],
  projects: [],
};

function asNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const result = Number(value);
  return Number.isFinite(result) ? result : null;
}

function formatNumber(value: unknown, digits = 2) {
  const number = asNumber(value);
  if (number === null) return "—";
  return new Intl.NumberFormat("zh-CN", {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  }).format(number);
}

function pick(source: Record<string, unknown> | null, keys: string[]) {
  if (!source) return null;
  for (const key of keys) {
    if (source[key] !== undefined && source[key] !== null) return source[key];
  }
  return null;
}

function severityLabel(item: Record<string, unknown>) {
  const raw = String(item.level ?? item.severity ?? item.riskLevel ?? "").toLowerCase();
  if (raw.includes("red") || raw.includes("红") || raw === "3") return "红";
  if (raw.includes("orange") || raw.includes("橙") || raw === "2") return "橙";
  return "黄";
}

function downloadExcel(filename: string, headers: string[], rows: string[][]) {
  const escape = (value: string) => value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const table = `<table><thead><tr>${headers.map((item) => `<th>${escape(item)}</th>`).join("")}</tr></thead><tbody>${rows
    .map((row) => `<tr>${row.map((item) => `<td>${escape(item)}</td>`).join("")}</tr>`)
    .join("")}</tbody></table>`;
  const blob = new Blob([`\ufeff<html><meta charset="utf-8"><body>${table}</body></html>`], {
    type: "application/vnd.ms-excel;charset=utf-8",
  });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `${filename}.xls`;
  anchor.click();
  URL.revokeObjectURL(url);
}

export default function CockpitApp({ section }: { section: string }) {
  const activeSection = (sectionNames[section as SectionKey] ? section : "overview") as SectionKey;
  const [period, setPeriod] = useState("本月");
  const [scope, setScope] = useState("账号授权项目");
  const [api, setApi] = useState<ApiState>(emptyState);

  const loadData = useCallback(async () => {
    setApi((current) => ({ ...current, loading: true, message: "" }));
    const resources = ["overview", "trend", "ranking", "alerts", "projects"] as const;
    const results = await Promise.all(
      resources.map(async (resource) => {
        const response = await fetch(`/api/dashboard?resource=${resource}`, { cache: "no-store" });
        const body = await response.json();
        return { resource, response, body };
      }),
    );
    const successful = results.filter((result) => result.body.ok);
    const latest = successful.map((result) => result.body.updatedAt).filter(Boolean).sort().at(-1) ?? null;
    const firstError = results.find((result) => !result.body.ok)?.body;
    const byResource = Object.fromEntries(results.map((result) => [result.resource, result.body.data]));
    setApi({
      loading: false,
      message: firstError?.message ?? "",
      updatedAt: latest,
      overview: byResource.overview ?? null,
      trend: Array.isArray(byResource.trend) ? byResource.trend : [],
      ranking: Array.isArray(byResource.ranking) ? byResource.ranking : [],
      alerts: Array.isArray(byResource.alerts) ? byResource.alerts : [],
      projects: Array.isArray(byResource.projects) ? byResource.projects : [],
    });
  }, []);

  useEffect(() => {
    const initialLoad = window.setTimeout(loadData, 0);
    const timer = window.setInterval(loadData, 5 * 60 * 1000);
    return () => {
      window.clearTimeout(initialLoad);
      window.clearInterval(timer);
    };
  }, [loadData]);

  const kpis = useMemo(() => {
    const overview = api.overview;
    return [
      {
        label: "回款",
        value: formatNumber(pick(overview, ["received", "actualCollection", "paymentAmount"])),
        unit: "万元",
        note: "口径与目标来自 API",
      },
      {
        label: "收缴率",
        value: formatNumber(pick(overview, ["collectionRate", "paymentRate"])),
        unit: "%",
        note: "含同比、环比和目标差额",
      },
      {
        label: "预算完成率",
        value: formatNumber(pick(overview, ["budgetCompletionRate", "budgetRate"])),
        unit: "%",
        note: "按同期预算口径",
      },
      {
        label: "欠费金额",
        value: formatNumber(pick(overview, ["arrears", "arrearsAmount"])),
        unit: "万元",
        note: "账龄规则来自 API",
      },
    ];
  }, [api.overview]);

  const alertRows = api.alerts.map((item, index) => [
    severityLabel(item),
    String(item.projectName ?? item.communityName ?? item.project ?? `异常 ${index + 1}`),
    String(item.title ?? item.riskName ?? item.message ?? "经营异常"),
    String(item.metric ?? item.detail ?? "—"),
    String(item.updatedAt ?? api.updatedAt ?? "—"),
  ]);

  const analysisRows = api.ranking.map((item, index) => [
    String(index + 1),
    String(item.projectName ?? item.communityName ?? item.name ?? "—"),
    formatNumber(item.receivable),
    formatNumber(item.received ?? item.paidAmount),
    formatNumber(item.collectionRate ?? item.rate),
    formatNumber(item.arrears),
  ]);

  return (
    <main
      className="aph-shell"
      data-aph-shell="2.0"
      data-auth-provider="aph-sso"
      data-permission-scope="account-project"
    >
      <header className="aph-topbar">
        <Link className="aph-logo" href="/" aria-label="APH 2.0 首页">
          <img src="/aph-icons/aph-brand-lockup.jpg" alt="APH 2.0" />
        </Link>
        <button className="menu-button" aria-label="展开或收起导航">
          <img src="/aph-icons/aph-menu-toggle.jpg" alt="" aria-hidden="true" />
        </button>
        <div className="top-status">
          <span>华北经营数据状态：</span>
          <b className={api.message ? "status-warn" : "status-ok"}>
            {api.loading ? "正在同步" : api.message ? "接口待授权" : "数据正常"}
          </b>
        </div>
        <div className="top-tools">
          <button className="top-tool" onClick={loadData} disabled={api.loading}>
            <img src="/aph-icons/RectangleCopy.png" alt="" aria-hidden="true" />
            <span>刷新</span>
          </button>
          <span className="update-time">{api.updatedAt ? `更新于 ${new Date(api.updatedAt).toLocaleString("zh-CN")}` : "暂无有效更新时间"}</span>
          <button className="top-tool" type="button">
            <img src="/aph-icons/chengbentongjifenxi.png" alt="" aria-hidden="true" />
            <span>预警</span>
          </button>
          <button className="user-button" type="button">
            <img src="/aph-icons/hehuoren.png" alt="" aria-hidden="true" />
            <span>企业微信待接入</span>
          </button>
        </div>
      </header>

      <aside className="aph-sidebar" aria-label="主导航">
        {primaryNav.map(([key, label]) => (
          <a className={activeSection === key ? "side-item active" : "side-item"} href={key === "overview" ? "/" : `/${key}`} key={key} aria-label={label}>
            <span className={`nav-icon nav-${key}`} aria-hidden="true" /><em>{label}</em>
          </a>
        ))}
      </aside>

      <section className="aph-workspace">
        <nav className="breadcrumb">
          <button className="tab-scroll-control" type="button" aria-label="向左滚动页签">
            <img src="/aph-icons/aph-tab-prev.jpg" alt="" aria-hidden="true" />
          </button>
          <img className="breadcrumb-home" src="/aph-icons/shouyeF.png" alt="" aria-hidden="true" />
          <b>{sectionNames[activeSection]}</b>
          <div className="global-filters">
            <select value={scope} onChange={(event) => setScope(event.target.value)} aria-label="数据范围">
              <option>账号授权项目</option>
              <option disabled>片区范围由接口返回</option>
            </select>
            <select value={period} onChange={(event) => setPeriod(event.target.value)} aria-label="统计周期">
              <option>本月</option><option>本季度</option><option>本年度</option><option>自定义日期</option>
            </select>
          </div>
        </nav>

        <div className="aph-content">
          {api.message && (
            <div className="system-notice" role="status">
              <strong>数据暂不可用</strong>
              <span>{api.message}。页面不会使用演示数据替代经营事实，完成企业微信与接口授权后自动恢复。</span>
            </div>
          )}

          {activeSection === "overview" && (
            <>
              <section className="hero-row">
                <article className="business-banner">
                  <div className="banner-brand"><span>1</span><p>第一服务<small>First Service</small></p></div>
                  <div><p>NORTH CHINA OPERATION COMMAND</p><h1>华北地区经营驾驶舱</h1><h2>日常经营监控 · 统一业务入口 · 经营异常预警</h2></div>
                  <time>{new Date().toLocaleDateString("zh-CN")}</time>
                </article>
                <article className="aph-card shortcuts-card">
                  <div className="card-title"><h3>便捷导航</h3><span>{businessEntries.length} 个只读业务模块</span></div>
                  <div className="shortcut-grid">
                    {businessEntries.map(([key, label]) => <a href={`/${key}`} key={key}><span><img src={sectionIcons[key]} alt="" aria-hidden="true" /></span><em>{label}</em></a>)}
                  </div>
                </article>
              </section>
              <section className="kpi-strip">
                {kpis.map((kpi) => {
                  const icon = kpi.label === "回款"
                    ? sectionIcons.payment
                    : kpi.label === "收缴率"
                      ? sectionIcons.collection
                      : kpi.label === "欠费金额"
                        ? sectionIcons.alerts
                        : sectionIcons.command;
                  return <article className="aph-card kpi-item" key={kpi.label}><span className="kpi-icon"><img src={icon} alt="" aria-hidden="true" /></span><div><p>{kpi.label}</p><strong>{kpi.value}<small>{kpi.unit}</small></strong></div><em>{kpi.note}</em></article>;
                })}
              </section>
              <section className="dashboard-grid">
                <article className="aph-card panel">
                  <div className="card-title"><h3>经营趋势</h3><Link href="/analysis">查看分析 ›</Link></div>
                  <TrendView rows={api.trend} />
                </article>
                <article className="aph-card panel">
                  <div className="card-title"><h3>红橙黄异常摘要</h3><Link href="/alerts">查看全部 ›</Link></div>
                  <AlertList rows={api.alerts.slice(0, 5)} />
                </article>
                <article className="aph-card panel">
                  <div className="card-title"><h3>项目经营排名</h3><span>仅显示账号授权项目</span></div>
                  <RankingTable rows={api.ranking.slice(0, 6)} />
                </article>
                <article className="aph-card panel data-quality">
                  <div className="card-title"><h3>数据状态</h3><span>每 5 分钟自动刷新</span></div>
                  <dl><div><dt>指标口径</dt><dd>以 API 返回为准</dd></div><div><dt>权限范围</dt><dd>{scope}</dd></div><div><dt>最近更新</dt><dd>{api.updatedAt ? new Date(api.updatedAt).toLocaleString("zh-CN") : "暂无"}</dd></div></dl>
                </article>
              </section>
              <div className="page-actions"><button onClick={() => window.print()}>导出 PDF / 打印</button></div>
            </>
          )}

          {activeSection === "analysis" && (
            <PagePanel title="经营分析" subtitle="支持本月、本季度、本年度与自定义日期；同比、环比、目标差额均读取 API">
              <div className="analysis-kpis">{kpis.map((kpi) => <div key={kpi.label}><span>{kpi.label}</span><strong>{kpi.value}<small>{kpi.unit}</small></strong><em>同比 —　环比 —　目标差额 —</em></div>)}</div>
              <TrendView rows={api.trend} />
              <RankingTable rows={api.ranking} />
              <div className="page-actions"><button onClick={() => downloadExcel("华北经营分析", ["排名", "项目", "应收", "实收", "收缴率", "欠费"], analysisRows)}>导出 Excel</button></div>
            </PagePanel>
          )}

          {activeSection === "alerts" && (
            <PagePanel title="异常预警" subtitle="红、橙、黄三级；阈值优先读取 API，缺失时由管理员配置">
              <div className="severity-summary"><span className="red">红色 {api.alerts.filter((item) => severityLabel(item) === "红").length}</span><span className="orange">橙色 {api.alerts.filter((item) => severityLabel(item) === "橙").length}</span><span className="yellow">黄色 {api.alerts.filter((item) => severityLabel(item) === "黄").length}</span></div>
              <div className="table-wrap"><table><thead><tr><th>级别</th><th>项目</th><th>异常事项</th><th>指标/差额</th><th>更新时间</th><th>操作</th></tr></thead><tbody>{alertRows.length ? alertRows.map((row, index) => <tr key={index}>{row.map((cell, cellIndex) => <td key={cellIndex}>{cell}</td>)}<td><a href={`/ai-alerts?alert=${index}`}>查看详情</a></td></tr>) : <EmptyRow columns={6} />}</tbody></table></div>
              <div className="page-actions"><button onClick={() => downloadExcel("华北经营异常预警", ["级别", "项目", "异常事项", "指标/差额", "更新时间"], alertRows)}>导出 Excel</button></div>
            </PagePanel>
          )}

          {activeSection === "business" && (
            <PagePanel title="统一业务入口" subtitle="所有模块均在驾驶舱内部打开，保持 APH 页面结构并统一执行账号权限">
              <div className="business-grid">{businessEntries.map(([key, label, description]) => <a href={`/${key}`} key={key}><span><img src={sectionIcons[key]} alt="" aria-hidden="true" /></span><div><strong>{label}</strong><p>{description}</p></div><em>进入 ›</em></a>)}</div>
            </PagePanel>
          )}

          {["command", "payment", "daily", "finance", "collection", "tasks", "ai-alerts", "ai-report", "reports", "review", "admin"].includes(activeSection) && (
            <PagePanel title={sectionNames[activeSection]} subtitle="本站内部只读页面；数据范围由账号权限和现有接口共同控制">
              <ReadOnlyModule section={activeSection} api={api} />
            </PagePanel>
          )}

          {activeSection === "projects" && (
            <PagePanel title="项目下钻" subtitle="项目 → 楼栋 → 房间/业主；明细默认脱敏且暂不提供导出">
              <div className="drill-path"><b>账号授权项目</b><span>›</span><em>请选择项目</em><span>›</span><em>楼栋</em><span>›</span><em>房间/业主</em></div>
              <div className="table-wrap"><table><thead><tr><th>项目</th><th>应收</th><th>实收</th><th>回款率</th><th>欠费金额</th><th>欠费户数</th><th>最长账龄</th><th>下钻</th></tr></thead><tbody>{api.projects.length ? api.projects.map((item, index) => <tr key={index}><td>{String(item.name ?? item.communityName ?? "—")}</td><td>由接口返回</td><td>由接口返回</td><td>—</td><td>—</td><td>—</td><td>—</td><td><button className="link-button">查看楼栋</button></td></tr>) : <EmptyRow columns={8} />}</tbody></table></div>
              <div className="privacy-note">房间/业主层级仅对授权账号开放；姓名和手机号默认脱敏，访问行为记录账号、时间、项目和查看范围。</div>
            </PagePanel>
          )}
        </div>
      </section>
    </main>
  );
}

function PagePanel({ title, subtitle, children }: { title: string; subtitle: string; children: React.ReactNode }) {
  return <section className="aph-card page-panel"><header><div><h1>{title}</h1><p>{subtitle}</p></div><span className="readonly-tag">只读</span></header>{children}</section>;
}

function EmptyRow({ columns }: { columns: number }) {
  return <tr><td colSpan={columns}><div className="empty-data"><strong>暂无可展示数据</strong><span>接口授权完成后，将按当前账号权限加载数据。</span></div></td></tr>;
}

function TrendView({ rows }: { rows: Array<Record<string, unknown>> }) {
  const values = rows.map((item) => asNumber(item.received ?? item.actual ?? item.value) ?? 0);
  const maximum = Math.max(...values, 1);
  return <div className="trend-view">{rows.length ? rows.slice(-12).map((item, index) => <div key={index}><span title={String(item.received ?? item.actual ?? "0")} style={{ height: `${Math.max(4, (values[index] / maximum) * 100)}%` }} /><em>{String(item.period ?? item.month ?? item.label ?? index + 1)}</em></div>) : <div className="empty-chart">接口授权后显示经营趋势</div>}</div>;
}

function AlertList({ rows }: { rows: Array<Record<string, unknown>> }) {
  return <div className="alert-list">{rows.length ? rows.map((item, index) => <a href={`/alerts?item=${index}`} key={index}><i className={`severity ${severityLabel(item)}`}>{severityLabel(item)}</i><span><strong>{String(item.projectName ?? item.communityName ?? item.project ?? "经营异常")}</strong><small>{String(item.title ?? item.message ?? item.detail ?? "查看异常详情")}</small></span><em>详情 ›</em></a>) : <div className="empty-data"><strong>暂无异常数据</strong><span>未使用演示数据填充。</span></div>}</div>;
}

function RankingTable({ rows }: { rows: Array<Record<string, unknown>> }) {
  return <div className="table-wrap"><table><thead><tr><th>排名</th><th>项目</th><th>应收</th><th>实收</th><th>收缴率</th><th>欠费</th></tr></thead><tbody>{rows.length ? rows.map((item, index) => <tr key={index}><td><b className={`rank rank-${index + 1}`}>{index + 1}</b></td><td>{String(item.projectName ?? item.communityName ?? item.name ?? "—")}</td><td>{formatNumber(item.receivable)}</td><td>{formatNumber(item.received ?? item.paidAmount)}</td><td>{formatNumber(item.collectionRate ?? item.rate)}%</td><td>{formatNumber(item.arrears)}</td></tr>) : <EmptyRow columns={6} />}</tbody></table></div>;
}

function ReadOnlyModule({ section, api }: { section: SectionKey; api: ApiState }) {
  const descriptions: Partial<Record<SectionKey, string[]>> = {
    command: ["经营目标", "回款执行", "异常数量", "重点管理动作"],
    payment: ["累计执行", "年度预算", "年度完成率", "目标差额"],
    daily: ["回款日期", "片区", "项目", "当日实收"],
    finance: ["应收与实收", "预算执行", "目标差额", "同比与环比"],
    collection: ["收缴率", "欠费金额", "欠费户数", "最长账龄"],
    tasks: ["关联项目", "责任人", "截止时间", "当前状态"],
    "ai-alerts": ["异常摘要", "影响范围", "数据口径", "更新时间"],
    "ai-report": ["本月经营摘要", "指标变化", "异常事项", "管理建议"],
    reports: ["本月经营摘要", "指标变化", "异常事项", "管理建议"],
    review: ["审核事项", "当前环节", "审核结论", "归档状态"],
    admin: ["账号与角色", "项目权限", "数据源状态", "操作审计"],
  };
  const items = descriptions[section] ?? [];
  const reviewViews = ["工作台", "方案提交", "审核中心", "审核机器人", "人员管理", "专业知识库", "规则配置", "数据分析", "日志中心", "系统设置", "账号安全分析"];
  const adminViews = ["用户与角色", "项目授权", "数据源", "数据质量", "备份快照", "上线检查", "操作日志", "账号安全"];
  const moduleViews = section === "review" ? reviewViews : section === "admin" ? adminViews : [];
  return <>
    <div className="module-summary">{items.map((item) => <div key={item}><span>{item}</span><strong>—</strong><em>由现有接口返回</em></div>)}</div>
    {moduleViews.length > 0 && <div className="module-view-grid">{moduleViews.map((item) => <button key={item}><strong>{item}</strong><span>只读查看</span></button>)}</div>}
    <div className="module-detail"><h2>{section === "ai-alerts" ? "异常详情" : section === "daily" ? "回款记录" : "业务记录"}</h2><div className="empty-data"><strong>{api.message ? "接口尚未授权" : "暂无记录"}</strong><span>该页面不会提供编辑、提交或审批操作。</span></div></div>
  </>;
}
