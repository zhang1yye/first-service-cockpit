import http from "node:http";
import https from "node:https";
import { createHash } from "node:crypto";
import { createReadStream, existsSync, readFileSync, statSync } from "node:fs";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL(".", import.meta.url));
const port = Number(process.env.PORT || 4174);
const upstream = "www.firstcare.cloud";
const serviceCenterCache = new Map();
const serviceCenterCacheTtl = 5 * 60 * 1000;
const financialDataCache = new Map();
const financialDataCacheTtl = 30 * 1000;
const cockpitDataRoot = join(process.env.HOME || root, "cockpit");
const lvzaiSummaryPath = join(cockpitDataRoot, "绿仔收款汇总.json");
const lvzaiDetailPath = join(cockpitDataRoot, "绿仔收缴明细.json");

function getServiceCenterCacheKey(headers) {
  return createHash("sha256")
    .update(String(headers.authorization || "anonymous"))
    .digest("hex");
}

const contentTypes = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".webp": "image/webp",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
};

function normalizeServiceCenterKey(value) {
  return String(value || "")
    .normalize("NFKC")
    .replace(/\s+/g, "")
    .replace(/[·•・]/g, "")
    .replace(/^第一(?:服务|酒店)/, "")
    .replace(/(?:服务中心|体验中心)$/, "");
}

function buildServiceCenterDirectory(rows) {
  const entries = [];
  const exact = new Map();

  for (const row of Array.isArray(rows) ? rows : []) {
    const center = String(row?.center || "").trim();
    const area = String(row?.area || "").trim();
    const key = normalizeServiceCenterKey(center);
    if (!center || !key) continue;

    const entry = { area, center, key };
    entries.push(entry);
    const matches = exact.get(key) || [];
    matches.push(entry);
    exact.set(key, matches);
  }

  return { entries, exact };
}

function resolveServiceCenterName(value, area, directory) {
  const current = String(value || "").trim();
  const key = normalizeServiceCenterKey(current);
  if (!current || !key || !directory) return current;

  const sameArea = (entry) => !area || !entry.area || entry.area === area;
  const exactMatches = (directory.exact.get(key) || []).filter(sameArea);
  if (exactMatches.length === 1) return exactMatches[0].center;

  const suffixMatches = directory.entries.filter(
    (entry) =>
      sameArea(entry) &&
      (entry.key.endsWith(key) || key.endsWith(entry.key)),
  );
  if (suffixMatches.length === 1) return suffixMatches[0].center;

  const preferredType = current.endsWith("体验中心")
    ? suffixMatches.filter((entry) => entry.center.endsWith("体验中心"))
    : suffixMatches.filter(
        (entry) =>
          entry.center.endsWith("服务中心") &&
          !entry.center.endsWith("体验中心"),
      );
  return preferredType.length === 1 ? preferredType[0].center : current;
}

function replaceServiceCenterNamesInText(value, area, directory) {
  let result = String(value || "");
  if (!result || !directory) return result;

  const candidates = directory.entries
    .filter((entry) => !area || !entry.area || entry.area === area)
  const aliases = candidates
    .flatMap((entry) => {
      const withoutCity = entry.key.replace(
        /^(?:北京|天津|石家庄|张家口|葫芦岛|营口|保定|廊坊|青岛)/,
        "",
      );
      return [entry.key, withoutCity]
        .filter((alias) => alias.length >= 5)
        .map((alias) => ({ alias, entry }));
    })
    .filter(({ alias }) => {
      const matches = candidates.filter((entry) => {
        const withoutCity = entry.key.replace(
          /^(?:北京|天津|石家庄|张家口|葫芦岛|营口|保定|廊坊|青岛)/,
          "",
        );
        return entry.key === alias || withoutCity === alias;
      });
      return matches.length === 1;
    })
    .sort((left, right) => right.alias.length - left.alias.length);

  const preserved = [];
  for (const entry of candidates) {
    if (!result.includes(entry.center)) continue;
    const placeholder = `__APH_CENTER_${preserved.length}__`;
    preserved.push(entry.center);
    result = result.replaceAll(entry.center, placeholder);
  }
  const aliasMap = new Map(
    aliases.map(({ alias, entry }) => [alias, entry.center]),
  );
  if (aliases.length) {
    const pattern = new RegExp(
      aliases
        .map(({ alias }) => alias.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
        .join("|"),
      "g",
    );
    result = result.replace(pattern, (match) => aliasMap.get(match) || match);
  }
  preserved.forEach((center, index) => {
    result = result.replaceAll(`__APH_CENTER_${index}__`, center);
  });
  return result;
}

function normalizeServiceCenterPayload(payload, pathname, directory) {
  const normalizeValue = (value, area = "") => {
    if (Array.isArray(value)) {
      return value.map((item) => normalizeValue(item, area));
    }
    if (!value || typeof value !== "object") return value;

    const currentArea = String(value.area || value.region || area || "");
    const result = {};
    for (const [key, item] of Object.entries(value)) {
      if (key === "center" || key === "project_name") {
        result[key] = resolveServiceCenterName(item, currentArea, directory);
      } else if (
        key === "name" &&
        (pathname.startsWith("/api/projects") ||
          pathname.startsWith("/api/alerts") ||
          pathname.startsWith("/api/tasks") ||
          pathname.startsWith("/api/ai/"))
      ) {
        result[key] = resolveServiceCenterName(item, currentArea, directory);
      } else if (
        typeof item === "string" &&
        ["summary", "text", "answer", "message"].includes(key)
      ) {
        result[key] = replaceServiceCenterNamesInText(
          item,
          currentArea,
          directory,
        );
      } else {
        result[key] = normalizeValue(item, currentArea);
      }
    }
    return result;
  };

  return normalizeValue(payload);
}

function requestUpstreamJson(path, headers) {
  return new Promise((resolve, reject) => {
    const requestHeaders = { ...headers, host: upstream };
    delete requestHeaders["content-length"];
    delete requestHeaders["accept-encoding"];

    const upstreamRequest = https.request(
      {
        hostname: upstream,
        method: "GET",
        path,
        headers: requestHeaders,
      },
      (upstreamResponse) => {
        const chunks = [];
        upstreamResponse.on("data", (chunk) => chunks.push(chunk));
        upstreamResponse.on("end", () => {
          if (
            !upstreamResponse.statusCode ||
            upstreamResponse.statusCode < 200 ||
            upstreamResponse.statusCode >= 300
          ) {
            reject(
              new Error(
                `标准服务中心接口返回 ${upstreamResponse.statusCode || "未知状态"}`,
              ),
            );
            return;
          }
          try {
            resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
          } catch (error) {
            reject(error);
          }
        });
      },
    );
    upstreamRequest.on("error", reject);
    upstreamRequest.end();
  });
}

async function getServiceCenterDirectory(headers) {
  const cacheKey = getServiceCenterCacheKey(headers);
  const cached = serviceCenterCache.get(cacheKey);
  if (cached && Date.now() - cached.updatedAt < serviceCenterCacheTtl) {
    return cached.directory;
  }

  const rows = await requestUpstreamJson("/api/payments", headers);
  const directory = buildServiceCenterDirectory(rows);
  serviceCenterCache.set(cacheKey, { directory, updatedAt: Date.now() });
  return directory;
}

function rowsFromPayload(payload) {
  if (Array.isArray(payload)) return payload;
  if (Array.isArray(payload?.rows)) return payload.rows;
  return [];
}

function numberValue(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function rounded(value, digits = 2) {
  const factor = 10 ** digits;
  return Math.round(numberValue(value) * factor) / factor;
}

function readLocalJson(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

function overlayLocalLvzaiData(payload, pathname) {
  const summary = readLocalJson(lvzaiSummaryPath);
  if (!summary || summary.collectionRate == null) return payload;

  if (
    pathname === "/api/summary" &&
    payload &&
    typeof payload === "object" &&
    !Array.isArray(payload) &&
    !payload.error
  ) {
    return {
      ...payload,
      collectionRate: numberValue(summary.collectionRate),
      collectionReceivable: numberValue(summary["receivable_万"]),
      collectionReceived: numberValue(summary["received_万"]),
      collectionOutstanding: numberValue(summary["outstanding_万"]),
      collectionSource: String(summary.source || "绿仔管家"),
      collectionExtractedAt: summary.extractedAt || null,
      collectionPeriodCorrection: summary.periodCorrection || null,
      _ts: summary.extractedAt || payload._ts,
    };
  }

  if (pathname !== "/api/collections") return payload;
  const detail = readLocalJson(lvzaiDetailPath);
  const localRows = rowsFromPayload(detail);
  if (!localRows.length) return payload;

  const localByCenter = new Map(
    localRows.map((row) => [normalizeServiceCenterKey(row.center), row]),
  );
  const summaryMeta = {
    collectionRate: numberValue(summary.collectionRate),
    collectionReceivable: numberValue(summary["receivable_万"]),
    collectionReceived: numberValue(summary["received_万"]),
    collectionOutstanding: numberValue(summary["outstanding_万"]),
    collectionSource: String(summary.source || "绿仔管家"),
    collectionExtractedAt: summary.extractedAt || null,
  };
  const overlayRows = (rows) =>
    rows
      .filter((row) =>
        localByCenter.has(normalizeServiceCenterKey(row.center)),
      )
      .map((row, index) => {
      const local = localByCenter.get(normalizeServiceCenterKey(row.center));
      const result = local
        ? {
            ...row,
            area: local.area || row.area,
            center: local.center || row.center,
            receivable: numberValue(local.receivable),
            received: numberValue(local.received),
            outstanding:
              local.outstanding == null
                ? Math.max(
                    numberValue(local.receivable) - numberValue(local.received),
                    0,
                  )
                : numberValue(local.outstanding),
            rate: numberValue(local.collectionRate),
            collectionRate: numberValue(local.collectionRate),
            source:
              "绿仔实时接口·本期应收/前期收本期+本期收本期/本期欠收",
            extractedAt: detail.extractedAt || summary.extractedAt || null,
          }
        : { ...row };
      if (index === 0) result._lvzaiSummary = summaryMeta;
      return result;
      });

  if (Array.isArray(payload)) return overlayRows(payload);
  if (Array.isArray(payload?.rows)) {
    return {
      ...payload,
      rows: overlayRows(payload.rows),
      extractedAt: detail.extractedAt || summary.extractedAt || null,
    };
  }
  return payload;
}

function financialRowKey(row) {
  return `${String(row?.area || "").trim()}::${normalizeServiceCenterKey(
    row?.center || row?.name,
  )}`;
}

function mergeFinancialRows(paymentPayload, collectionPayload) {
  const payments = rowsFromPayload(paymentPayload);
  const collections = rowsFromPayload(collectionPayload);
  const collectionByKey = new Map(
    collections.map((row) => [financialRowKey(row), row]),
  );

  return payments.map((payment, index) => {
    const collection =
      collectionByKey.get(financialRowKey(payment)) ||
      collections.find(
        (row) =>
          normalizeServiceCenterKey(row?.center) ===
          normalizeServiceCenterKey(payment?.center),
      ) ||
      null;
    const receivable = collection ? numberValue(collection.receivable) : null;
    const received = collection ? numberValue(collection.received) : null;
    const collectionRate =
      receivable && receivable > 0 ? (received / receivable) * 100 : null;

    return {
      id: 10001 + index,
      area: String(payment.area || collection?.area || "").trim(),
      name: String(payment.center || collection?.center || "").trim(),
      center: String(payment.center || collection?.center || "").trim(),
      property_type: "服务中心",
      annualBudget: numberValue(payment.annualBudget),
      cumulativeBudget: numberValue(payment.cumulativeBudget),
      cumulativeExecuted: numberValue(payment.cumulativeExecuted),
      executionVariance: numberValue(payment.executionVariance),
      annualRate: numberValue(payment.annualRate),
      cumulativeRate: numberValue(payment.cumulativeRate),
      samePeriod: numberValue(payment.samePeriod),
      growth: numberValue(payment.growth),
      receivable,
      received,
      overdue30: collection ? numberValue(collection.overdue30) : null,
      overdue90: collection ? numberValue(collection.overdue90) : null,
      collectionRate: collectionRate === null ? null : rounded(collectionRate),
      area_sqm: null,
      units: null,
      staff_count: null,
      annual_income: null,
      annual_cost: null,
      ytd_income: null,
      ytd_cost: null,
      profitRate: null,
      quality_score: null,
      safety_incidents: null,
      customer_satisfaction: null,
      complaint_count: null,
      dataSource: collection ? "payments+collections" : "payments",
      realFinancialOnly: true,
      unavailableFields: [
        "area_sqm",
        "units",
        "staff_count",
        "annual_income",
        "annual_cost",
        "ytd_income",
        "ytd_cost",
        "profitRate",
        "quality_score",
        "safety_incidents",
        "customer_satisfaction",
        "complaint_count",
      ],
    };
  });
}

async function getRealFinancialProjects(headers) {
  const cacheKey = getServiceCenterCacheKey(headers);
  const cached = financialDataCache.get(cacheKey);
  if (cached && Date.now() - cached.updatedAt < financialDataCacheTtl) {
    return cached.promise;
  }

  const promise = Promise.allSettled([
    requestUpstreamJson("/api/payments", headers),
    requestUpstreamJson("/api/collections", headers),
  ]).then(([paymentResult, collectionResult]) => {
    if (paymentResult.status !== "fulfilled") return null;
    return mergeFinancialRows(
      paymentResult.value,
      collectionResult.status === "fulfilled" ? collectionResult.value : [],
    );
  });
  financialDataCache.set(cacheKey, {
    promise,
    updatedAt: Date.now(),
  });
  return promise;
}

function financialAlerts(projects) {
  return projects
    .filter(
      (project) =>
        project.executionVariance < 0 ||
        (project.cumulativeRate > 0 && project.cumulativeRate < 1),
    )
    .sort(
      (left, right) =>
        left.executionVariance - right.executionVariance ||
        left.cumulativeRate - right.cumulativeRate,
    )
    .map((project, index) => {
      const items = [];
      if (project.executionVariance < 0) {
        items.push(
          `累计执行低于累计预算，差额${rounded(
            project.executionVariance,
          ).toLocaleString("zh-CN")}万`,
        );
      }
      if (project.cumulativeRate > 0 && project.cumulativeRate < 1) {
        items.push(`累计完成率${rounded(project.cumulativeRate * 100)}%`);
      }
      return {
        id: 20001 + index,
        project_id: project.id,
        project_name: project.name,
        name: project.name,
        area: project.area,
        severity: "medium",
        status: "待核实",
        items,
        reasons: items,
        actions: ["核对累计预算与实际回款口径", "进入回款明细确认差额"],
        summary: items.join("；"),
        realFinancialOnly: true,
        provisionalLevel: true,
      };
    });
}

function sumBy(rows, field) {
  return rows.reduce((total, row) => total + numberValue(row?.[field]), 0);
}

function groupFinancialAreas(projects) {
  const groups = new Map();
  for (const project of projects) {
    const group = groups.get(project.area) || {
      area: project.area,
      project_count: 0,
      receivable: 0,
      received: 0,
      cumulativeBudget: 0,
      cumulativeExecuted: 0,
    };
    group.project_count += 1;
    group.receivable += numberValue(project.receivable);
    group.received += numberValue(project.received);
    group.cumulativeBudget += numberValue(project.cumulativeBudget);
    group.cumulativeExecuted += numberValue(project.cumulativeExecuted);
    groups.set(project.area, group);
  }
  return [...groups.values()]
    .map((group) => ({
      ...group,
      collectionRate:
        group.receivable > 0
          ? rounded((group.received / group.receivable) * 100)
          : null,
      cumulativeRate:
        group.cumulativeBudget > 0
          ? rounded(
              (group.cumulativeExecuted / group.cumulativeBudget) * 100,
            )
          : null,
      quality: null,
      satisfaction: null,
    }))
    .sort(
      (left, right) =>
        numberValue(right.collectionRate) - numberValue(left.collectionRate),
    );
}

function buildMonthlyReport(projects, requestedArea) {
  const scoped =
    requestedArea && !["华北", "全部"].includes(requestedArea)
      ? projects.filter((project) => project.area === requestedArea)
      : projects;
  const receivable = sumBy(scoped, "receivable");
  const received = sumBy(scoped, "received");
  const cumulativeBudget = sumBy(scoped, "cumulativeBudget");
  const cumulativeExecuted = sumBy(scoped, "cumulativeExecuted");
  const collectionRate =
    receivable > 0 ? rounded((received / receivable) * 100) : null;
  const cumulativeRate =
    cumulativeBudget > 0
      ? rounded((cumulativeExecuted / cumulativeBudget) * 100)
      : null;
  const alerts = financialAlerts(scoped);
  const weakestProjects = [...scoped]
    .sort(
      (left, right) =>
        numberValue(left.collectionRate ?? left.cumulativeRate) -
        numberValue(right.collectionRate ?? right.cumulativeRate),
    )
    .slice(0, 5)
    .map((project) => ({
      id: project.id,
      name: project.name,
      area: project.area,
      collectionRate: project.collectionRate,
      cumulativeRate: project.cumulativeRate,
    }));
  const areaRank = groupFinancialAreas(scoped);

  return {
    reportDate: new Date().toISOString().slice(0, 10),
    area: requestedArea || "华北",
    summary: {
      project_count: scoped.length,
      total_receivable: rounded(receivable),
      total_received: rounded(received),
      collectionRate,
      cumulativeBudget: rounded(cumulativeBudget),
      cumulativeExecuted: rounded(cumulativeExecuted),
      executionVariance: rounded(cumulativeExecuted - cumulativeBudget),
      cumulativeRate,
      total_area: null,
      total_units: null,
      ytd_income: null,
      ytd_cost: null,
      profitRate: null,
      avg_quality: null,
      total_incidents: null,
      avg_satisfaction: null,
      total_complaints: null,
    },
    areaRank,
    alerts,
    weakestProjects,
    dataQuality: {
      score: null,
      projectCount: scoped.length,
      latestSnapshotMonth: null,
      summary:
        "本月报仅使用回款与收缴现有接口；收入成本、利润率、品质、安全、满意度和投诉接口暂未接入。",
      sourceScope: ["payments", "collections"],
    },
    autoTaskReview: {
      summary: { total: 0, ok: 0, warning: 0, danger: 0 },
      generatedAt: null,
      rows: [],
      abnormal: [],
      text: "任务数据接口当前未接入，本月报不生成任务结论。",
    },
    riskTrendSummary: {
      worsening: [],
      improving: [],
      total: 0,
      note: "真实月度历史快照接口暂未接入，不生成风险趋势结论。",
    },
    sections: [
      {
        title: "一、真实回款总览",
        content: `当前纳入${scoped.length}个有权限的服务中心，累计预算${rounded(
          cumulativeBudget,
        ).toLocaleString("zh-CN")}万，累计执行${rounded(
          cumulativeExecuted,
        ).toLocaleString("zh-CN")}万，累计完成率${
          cumulativeRate === null ? "暂不可用" : `${cumulativeRate}%`
        }。`,
      },
      {
        title: "二、真实收缴表现",
        content:
          collectionRate === null
            ? "收缴接口当前未返回可计算的应收、实收数据。"
            : `应收${rounded(receivable).toLocaleString(
                "zh-CN",
              )}万，实收${rounded(received).toLocaleString(
                "zh-CN",
              )}万，综合收缴率${collectionRate}%。`,
      },
      {
        title: "三、片区对比",
        content: areaRank.length
          ? areaRank
              .slice(0, 5)
              .map(
                (row) =>
                  `${row.area}${
                    row.collectionRate === null
                      ? "收缴率暂不可用"
                      : `收缴率${row.collectionRate}%`
                  }`,
              )
              .join("；")
          : "暂无可对比的片区数据。",
      },
      {
        title: "四、未达累计预算清单",
        content: alerts.length
          ? alerts
              .slice(0, 8)
              .map((alert) => `${alert.name}：${alert.items.join("，")}`)
              .join("；")
          : "当前真实回款接口中未发现累计执行低于累计预算的服务中心。",
      },
      {
        title: "五、数据缺口",
        content:
          "面积、户数、收入成本、利润率、品质、安全、满意度、投诉及历史趋势接口暂未接入，因此本月报不生成相关数值与判断。",
      },
    ],
    aiText: null,
    realFinancialOnly: true,
  };
}

async function buildRealEndpointPayload(pathname, requestUrl, headers) {
  const supported =
    pathname === "/api/projects" ||
    /^\/api\/projects\/\d+$/.test(pathname) ||
    pathname === "/api/alerts" ||
    pathname === "/api/ai/monthly-report" ||
    pathname === "/api/ai/brief" ||
    pathname === "/api/ai/week-focus" ||
    pathname === "/api/ai/health" ||
    pathname === "/api/ai/trends" ||
    pathname === "/api/ai/risk-trends" ||
    pathname === "/api/trends" ||
    pathname === "/api/forecasts" ||
    pathname === "/api/formal-outputs" ||
    pathname === "/api/governance/report-archives";
  if (!supported) return null;

  if (pathname === "/api/trends") {
    return {
      payload: [],
      adapted: true,
    };
  }
  if (pathname === "/api/forecasts") {
    return {
      adapted: true,
      payload: {
        rows: [],
        workflow: {
          draft: 0,
          submitted: 0,
          area_approved: 0,
          region_approved: 0,
          locked: 0,
          rejected: 0,
        },
        discipline: {
          readyToSubmit: 0,
          unready: 0,
          missingRoles: [],
        },
        message: "真实预算预测审批接口暂未接入，已停止展示演示草稿。",
        unavailable: true,
        realFinancialOnly: true,
      },
    };
  }
  if (
    pathname === "/api/formal-outputs" ||
    pathname === "/api/governance/report-archives"
  ) {
    return {
      adapted: true,
      payload: {
        rows: [],
        total: 0,
        message: "真实归档接口暂未接入，已停止展示演示归档记录。",
        unavailable: true,
        realFinancialOnly: true,
      },
    };
  }

  const projects = await getRealFinancialProjects(headers);
  if (!projects) {
    return {
      adapted: true,
      payload: {
        rows: [],
        alerts: [],
        total: 0,
        unavailable: true,
        message: "真实回款接口暂不可用，已停止展示演示数据。",
        realFinancialOnly: true,
      },
    };
  }

  const alerts = financialAlerts(projects);

  if (pathname === "/api/projects") {
    return {
      adapted: true,
      payload: {
        rows: projects,
        total: projects.length,
        realFinancialOnly: true,
        sourceScope: ["payments", "collections"],
      },
    };
  }
  if (/^\/api\/projects\/\d+$/.test(pathname)) {
    const id = Number(pathname.split("/").pop());
    return {
      adapted: true,
      payload:
        projects.find((project) => project.id === id) || {
          error: "服务中心不存在或无权访问",
        },
    };
  }
  if (pathname === "/api/alerts") {
    return {
      adapted: true,
      payload: {
        alerts,
        rows: alerts,
        total: alerts.length,
        summary:
          "仅依据真实回款接口列示未达累计预算的服务中心；正式红橙黄风险分级规则尚未配置，当前统一标记为待核实。",
        thresholds: null,
        provisionalLevel: true,
        realFinancialOnly: true,
      },
    };
  }
  if (pathname === "/api/ai/monthly-report") {
    const requestedArea = new URL(
      requestUrl,
      `http://localhost:${port}`,
    ).searchParams.get("area");
    return {
      adapted: true,
      payload: buildMonthlyReport(projects, requestedArea),
    };
  }
  if (pathname === "/api/ai/brief") {
    const report = buildMonthlyReport(projects, "华北");
    return {
      adapted: true,
      payload: {
        status: alerts.length ? "关注" : "稳健",
        text: `今日经营判断仅基于真实回款与收缴接口。累计完成率${
          report.summary.cumulativeRate === null
            ? "暂不可用"
            : `${report.summary.cumulativeRate}%`
        }，综合收缴率${
          report.summary.collectionRate === null
            ? "暂不可用"
            : `${report.summary.collectionRate}%`
        }；利润、品质、安全和投诉数据暂未接入。`,
        collectionRate: report.summary.collectionRate,
        cumulativeRate: report.summary.cumulativeRate,
        alerts: alerts.length,
        keyProjects: alerts.slice(0, 3).map((item) => item.name),
        realFinancialOnly: true,
      },
    };
  }
  if (pathname === "/api/ai/week-focus") {
    return {
      adapted: true,
      payload: {
        date: new Date().toISOString().slice(0, 10),
        rows: alerts.slice(0, 5).map((alert) => ({
          id: alert.project_id,
          name: alert.name,
          area: alert.area,
          healthScore: null,
          level: "待核实",
          collectionRate:
            projects.find((project) => project.id === alert.project_id)
              ?.collectionRate ?? null,
          profitRate: null,
          priority: null,
          reasons: alert.items,
          observation: "建议核对累计预算与实际回款口径",
          riskType: "回款进度",
          realFinancialOnly: true,
        })),
        summary: alerts.length
          ? `本周优先核对${alerts
              .slice(0, 5)
              .map((item) => item.name)
              .join("、")}的真实回款差额。`
          : "真实回款接口中暂无需优先核对的服务中心。",
        provisionalLevel: true,
        realFinancialOnly: true,
      },
    };
  }

  return {
    adapted: true,
    payload: {
      avgScore: null,
      projects: [],
      rows: [],
      risky: [],
      alerts: [],
      summary:
        "健康分与历史趋势所需的利润、品质、安全、投诉及月度快照接口暂未接入，已停止展示演示结论。",
      unavailable: true,
      realFinancialOnly: true,
    },
  };
}

function proxyToFirstcare(request, response) {
  const pathname = new URL(
    request.url || "/",
    `http://localhost:${port}`,
  ).pathname;
  const headers = {
    ...request.headers,
    host: upstream,
    origin: `https://${upstream}`,
    referer: `https://${upstream}/`,
  };
  delete headers["accept-encoding"];
  delete headers["if-none-match"];
  delete headers["if-modified-since"];

  const proxyRequest = https.request(
    {
      hostname: upstream,
      method: request.method,
      path: request.url,
      headers,
    },
    (proxyResponse) => {
      const responseHeaders = { ...proxyResponse.headers };
      const cookies = responseHeaders["set-cookie"];
      if (Array.isArray(cookies)) {
        responseHeaders["set-cookie"] = cookies.map((cookie) =>
          cookie
            .replace(/;\s*Domain=[^;]+/gi, "")
            .replace(/;\s*Secure/gi, "")
            .replace(/SameSite=None/gi, "SameSite=Lax"),
        );
      }
      if (typeof responseHeaders.location === "string") {
        responseHeaders.location = responseHeaders.location.replace(
          `https://${upstream}`,
          `http://localhost:${port}`,
        );
      }

      const isJson =
        String(responseHeaders["content-type"] || "").includes(
          "application/json",
        ) && request.method === "GET";
      if (!isJson) {
        response.writeHead(proxyResponse.statusCode || 502, responseHeaders);
        proxyResponse.pipe(response);
        return;
      }

      const chunks = [];
      proxyResponse.on("data", (chunk) => chunks.push(chunk));
      proxyResponse.on("end", async () => {
        const originalBody = Buffer.concat(chunks);
        let responseBody = originalBody;
        let adapted = false;

        try {
          const originalPayload = JSON.parse(originalBody.toString("utf8"));
          const realPayload = await buildRealEndpointPayload(
            pathname,
            request.url || pathname,
            headers,
          );
          const payload = overlayLocalLvzaiData(
            realPayload?.payload ?? originalPayload,
            pathname,
          );
          adapted = Boolean(realPayload?.adapted);
          if (adapted) {
            responseBody = Buffer.from(JSON.stringify(payload));
          } else {
            let directory;
            if (pathname === "/api/payments") {
              directory = buildServiceCenterDirectory(payload);
              const cacheKey = getServiceCenterCacheKey(headers);
              serviceCenterCache.set(cacheKey, {
                directory,
                updatedAt: Date.now(),
              });
            } else {
              directory = await getServiceCenterDirectory(headers);
            }
            responseBody = Buffer.from(
              JSON.stringify(
                normalizeServiceCenterPayload(payload, pathname, directory),
              ),
            );
          }
        } catch (error) {
          console.warn(
            `[服务中心名称统一] ${pathname} 未处理：${error.message}`,
          );
          responseBody = originalBody;
        }

        delete responseHeaders["transfer-encoding"];
        delete responseHeaders["content-encoding"];
        responseHeaders["cache-control"] = "no-store";
        responseHeaders["content-length"] = String(responseBody.length);
        response.writeHead(
          adapted ? 200 : proxyResponse.statusCode || 502,
          responseHeaders,
        );
        response.end(responseBody);
      });
    },
  );

  proxyRequest.on("error", (error) => {
    response.writeHead(502, { "Content-Type": "application/json; charset=utf-8" });
    response.end(JSON.stringify({ ok: false, message: `本地代理失败：${error.message}` }));
  });
  request.pipe(proxyRequest);
}

function serveStatic(request, response) {
  const url = new URL(request.url || "/", `http://localhost:${port}`);
  const decodedPath = decodeURIComponent(url.pathname);
  const relativePath = normalize(decodedPath).replace(/^(\.\.[/\\])+/, "").replace(/^[/\\]+/, "");
  const cockpitRoutes = new Set(["/arrears", "/system", "/admin"]);
  let target = cockpitRoutes.has(decodedPath) ? join(root, "index.html") : join(root, relativePath);

  if (!target.startsWith(root)) {
    response.writeHead(403);
    response.end("Forbidden");
    return;
  }

  if (existsSync(target) && statSync(target).isDirectory()) {
    target = join(target, "index.html");
  }
  if (!existsSync(target) || !statSync(target).isFile()) {
    target = join(root, "index.html");
  }

  response.writeHead(200, {
    "Cache-Control": "no-store",
    "Content-Type": contentTypes[extname(target).toLowerCase()] || "application/octet-stream",
  });
  createReadStream(target).pipe(response);
}

const server = http.createServer((request, response) => {
  const requestUrl = new URL(request.url || "/", `http://localhost:${port}`);
  const pathname = requestUrl.pathname;
  const redirects = new Map([
    ["/arrears/", "/arrears"],
    ["/system/", "/system"],
    ["/system/index.html", "/system"],
    ["/admin/", "/admin"],
    ["/admin/index.html", "/admin"],
    ["/review-system", "/review?view=workbench"],
    ["/review-system/", "/review?view=workbench"],
  ]);
  const isEmbeddedArrears = pathname === "/arrears/" && requestUrl.searchParams.get("embedded") === "1";
  if (redirects.has(pathname) && !isEmbeddedArrears) {
    response.writeHead(302, { Location: redirects.get(pathname), "Cache-Control": "no-store" });
    response.end();
    return;
  }
  if (pathname.startsWith("/api/") || pathname.startsWith("/review-system/")) {
    proxyToFirstcare(request, response);
    return;
  }
  serveStatic(request, response);
});

server.listen(port, "127.0.0.1", () => {
  console.log(`firstcare.cloud 本地开发副本：http://localhost:${port}`);
});
