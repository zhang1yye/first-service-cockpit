# firstcare.cloud 本地开发副本

该目录于 2026-07-27 从线上 `/var/www/cockpit` 只读同步，用于在现有 `firstcare.cloud` 页面、路由和业务功能基础上完成 APH 风格改造。

## 边界

- 不替换原有业务页面和路由。
- 不使用独立驾驶舱原型替代现有功能。
- `/api/*` 在本地开发时代理到 `https://www.firstcare.cloud`。
- 登录 Cookie 会改写为本地域名，便于在本地独立登录验证。
- APH 改造集中在 `aph2-theme.css`、`aph2-theme.js` 和 `aph-icons/`。

## 启动

```bash
npm run dev
```

默认地址：`http://localhost:4174/`
