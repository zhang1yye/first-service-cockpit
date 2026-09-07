# 第一服务华北地区经营驾驶舱统一工作区

本目录自 2026-08-06 起作为驾驶舱唯一的本地工作区。

## 目录职责

- `server/`：线上 `/home/ubuntu/cockpit` 对应的 Node/Express/SQLite 后端源码、脚本与测试。生产服务为 `first-service-cockpit.service`。
- `firstcare-cloud-local/`：线上 `/var/www/cockpit` 静态前端的本地镜像和开发副本。同步生产文件时保留本地 `docs/` 设计证据。
- `firstcare-cloud-local/arrears/`：欠费资源分析独立静态页面，对应生产候选路径 `/arrears/`。
- `admin-web/`：管理后台React源码。
- `knowledge/`：经营知识候选、策展资料和证据。
- `production-overlays/`：基于生产静态文件制作的最小发布候选；不能跳过与生产哈希、差异和浏览器行为复核。
- `backups/`：历史局部源码备份。
- `docs/release-manifests/legacy-20260806/`：整合前旧发布清单，仅供追溯，不得作为新发布依据。
- `app/`：早期Vinext/Cloudflare前端原型。它不是当前 `www.firstcare.cloud` 的生产Node后端，也不是线上静态资源的直接发布源。

## 当前生产血缘

- 后端：`server/` → `/home/ubuntu/cockpit`
- 静态前端：`firstcare-cloud-local/` → `/var/www/cockpit`
- 早期原型：`app/`，仅作设计/重构参考

## 安全规则

1. 未经明确授权，不向生产上传、迁移数据库或重启服务。
2. 发布前分别生成后端、静态前端SHA-256清单。
3. `server/cockpit.db*`、`node_modules/`、`dist/`和日志是本地运行产物，不进入Git。
4. 静态前端发布必须从线上当前入口和活动资源开始，禁止用过期本地副本覆盖生产。
5. 欠费原始数据不得进入Git、知识库或静态目录。

## 本地验证

```bash
# 后端
cd server
npm run build
/usr/local/bin/node --import tsx --test tests/arrears-analysis.test.ts tests/arrears-integration.test.ts

# 管理端
cd ../admin-web
npm run build
npm test

# 静态脚本
cd ..
node --check firstcare-cloud-local/aph2-theme.js
node --check firstcare-cloud-local/arrears/arrears.js
```
