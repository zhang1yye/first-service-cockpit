import { NextRequest, NextResponse } from "next/server";

const endpoints: Record<string, string> = {
  overview: "/api/v1/cockpit/north/overview",
  trend: "/api/v1/cockpit/north/collection-trend",
  ranking: "/api/v1/cockpit/north/project-rank?limit=12",
  alerts: "/api/v1/cockpit/north/risk-summary",
  projects: "/api/v1/property/community/list",
};

export async function GET(request: NextRequest) {
  const resource = request.nextUrl.searchParams.get("resource") ?? "overview";
  const endpoint = endpoints[resource];
  if (!endpoint) {
    return NextResponse.json({ ok: false, message: "不支持的数据资源" }, { status: 400 });
  }

  const baseUrl = process.env.FIRSTSERVICE_API_BASE_URL;
  const accessToken = process.env.FIRSTSERVICE_API_TOKEN;
  if (!baseUrl || !accessToken) {
    return NextResponse.json(
      {
        ok: false,
        code: "API_NOT_CONFIGURED",
        message: "现有接口尚未完成受控授权配置",
        updatedAt: null,
      },
      { status: 503 },
    );
  }

  try {
    const response = await fetch(`${baseUrl.replace(/\/$/, "")}${endpoint}`, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: "application/json",
      },
      cache: "no-store",
      signal: AbortSignal.timeout(12000),
    });
    if (!response.ok) {
      return NextResponse.json(
        {
          ok: false,
          code: response.status === 401 ? "AUTH_EXPIRED" : "UPSTREAM_ERROR",
          message: response.status === 401 ? "接口授权已失效" : "接口暂时不可用",
          updatedAt: new Date().toISOString(),
        },
        { status: response.status === 401 ? 401 : 502 },
      );
    }
    const payload = await response.json();
    return NextResponse.json({
      ok: true,
      data: payload?.data ?? payload,
      updatedAt: new Date().toISOString(),
    });
  } catch {
    return NextResponse.json(
      {
        ok: false,
        code: "UPSTREAM_TIMEOUT",
        message: "接口响应超时",
        updatedAt: new Date().toISOString(),
      },
      { status: 504 },
    );
  }
}
