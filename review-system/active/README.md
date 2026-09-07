# 第一服务研发小组审核系统

基于 React + Vite + Tailwind + Express 的方案审核系统原型。当前版本已按“八专业 Hermes Profile + 两类审核流程”重构业务闭环。

## 已实现能力

- 8 个 Hermes 专业 Profile：
  - 投资发展总监
  - 科技设施总监
  - 客户服务总监
  - 社区经营总监
  - 五个三总监
  - 计划财务总监
  - 信息运营总监
  - 人力资源与行政总监
- 内部运营方案审核：
  - 8 个专业并行审核
  - 输出各专业发现、建议、风险等级、评分
  - 自动生成最终汇总意见
- 市场拓展方案审核：
  - 投资发展总监先生成立项报告
  - 其他专业并行审核
  - 自动生成最终汇总意见
- 支持方案提交、附件上传元数据记录、审核详情查看、重新发起审核。
- 支持附件真实落盘、详情页下载、删除方案时同步清理附件。
- 支持 TXT、DOCX、PDF、XLS、XLSX、CSV、TSV 附件正文解析，PDF 会补充提取表格片段，审核引擎会读取附件正文参与判断。
- 支持人工复核备注、状态流转和审核时间线留痕。
- 支持人员账号新增、修改、启停管理。
- 规则配置已接入审核引擎，启用规则会影响评分、风险等级、专业建议和汇总意见。
- 支持管理员/使用者角色边界、角色权限矩阵、系统安全配置、登录失败锁定、强制改密和结构化审计日志。
- 支持账号安全审计上下文、批量改密/停用/解锁跳过原因、日志 CSV 专项摘要和按后端文件名下载。
- 支持在线下载备份、附件校验和、整体校验码、上传校验、确认恢复，以及服务器本地快照创建、容量概览、预览、查看、下载、恢复、删除和按保留天数清理。
- 后端支持 JSON 文件持久化，人员、方案、日志、规则、知识库、机器人配置和附件重启后保留。

## 当前实现说明

当前云端 AI 审核通过 Hermes 网关调用真实 Hermes Agent，默认使用 `deepseek/deepseek-chat` 完成 8 个一级专业并行审核。系统设置页提供 AI Provider、模型、Base URL 和密钥环境变量配置；密钥仅通过环境变量读取，不写入业务数据文件。位置在：

```text
backend/server.js
hermes/server.js
hermes/profiles.js
```

`hermes`、`openai`、`custom` Provider 会按 OpenAI Chat Completions 兼容协议请求 `${AI_REVIEW_BASE_URL}/chat/completions`，把方案正文、附件解析内容、专业 Profile、规则和本地审核基线发送给外部 AI，并要求返回结构化 JSON 审核意见。外部 AI 调用失败时会自动回退到本地规则引擎并写入时间线。

系统设置页提供“测试 AI 连接”，会使用当前表单配置执行一次不落库的审核探测。本地模式验证规则引擎链路；外部模式会校验 Base URL、密钥环境变量和结构化 JSON 返回。

项目内置 Hermes 网关服务，优先使用 `/opt/hermes-agent` 的 oneshot 模式执行真实模型审核，并暴露 8 个一级专业 Profile：

```text
GET  /health
GET  /v1/profiles            # 配置 HERMES_API_KEY 后需要 Bearer Token
GET  /v1/models              # 配置 HERMES_API_KEY 后需要 Bearer Token
POST /v1/chat/completions    # 配置 HERMES_API_KEY 后需要 Bearer Token
```

云服务器同机部署后，后端通过 `http://127.0.0.1:3100/v1` 调用 Hermes；Nginx 同时暴露健康检查地址 `https://firstcare.cloud/hermes/health`。如果要从公网检查 Profile，需要带上 `Authorization: Bearer <HERMES_API_KEY>` 请求 `https://firstcare.cloud/hermes/v1/profiles`。Hermes Agent 不可执行、模型调用失败或超过 40 秒时，网关会返回规则兜底并附带 `_meta.fallback=true`，主后端据此记录 AI 回退日志。

当前数据默认保存在：

```text
backend/data/store.json
backend/data/files/
```

可通过环境变量 `STORE_FILE` 指定其他存储文件。生产版本建议后续升级为 PostgreSQL 或 SQLite，并继续完善附件原文存储和外部备份策略。

## 本地运行

后端：

```bash
cd backend
npm install
PORT=3001 npm start
```

前端：

```bash
cd frontend
npm install
npm run dev -- --host 0.0.0.0 --port 5174
```

访问：

```text
http://127.0.0.1:5174
```

默认账号：

```text
admin / admin123
```

生产环境请立即修改默认管理员密码，或在人员管理中重新设置管理员账号。管理员账号不会被强制要求下次登录改密，使用者账号可按安全策略开启强制改密。

## 构建验证

```bash
cd frontend
npm run build
```

```bash
cd backend
node --check server.js
```

## Ubuntu 云服务器部署

```bash
sudo apt update
sudo apt install -y nginx git curl rsync
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs
```

把本项目上传到：

```bash
~/first-service-review-system
```

执行：

```bash
cd ~/first-service-review-system
export HERMES_API_KEY="YOUR_HERMES_API_KEY"
bash deploy.sh ~/first-service-review-system https://firstcare.cloud
```

默认静态站点目录为 `/var/www/first-service-dashboard`，与当前 `firstcare.cloud` 的 HTTPS Nginx 配置一致。如需部署到其他目录，可先设置：

```bash
export WEB_DIR=/var/www/your-site-root
```

Nginx 模板默认设置 `client_max_body_size 120m`，略高于系统设置里的“单文件上限（MB）”最大值，用于容纳 multipart 表单开销；真正的业务上限仍由后端按系统配置校验。

部署脚本会同时创建两个 systemd 服务：

```text
first-service-review-api.service
first-service-hermes-gateway.service
```

默认 Hermes 配置：

```text
AI_REVIEW_PROVIDER=hermes
AI_REVIEW_MODEL=hermes-eight-profile-v1
AI_REVIEW_BASE_URL=http://127.0.0.1:3100/v1
AI_REVIEW_API_KEY=change-this-hermes-key
HERMES_API_KEY=change-this-hermes-key
```

上线前请通过环境变量 `HERMES_API_KEY` 或 `AI_REVIEW_API_KEY` 传入正式强密钥，并使用单引号包裹，避免 shell 提前解释特殊字符。脚本会在写入 systemd `Environment` 时转义反斜杠和双引号。如果未传入密钥，`deploy.sh` 会阻止部署，避免默认占位密钥进入生产。仅本地测试可临时设置 `ALLOW_DEFAULT_HERMES_KEY=1` 跳过该拦截。部署后在系统设置页点击“测试 AI 连接”和“检查 Profile 接入”确认链路。

部署后访问：

```text
https://firstcare.cloud
```

## API

- `GET /api/health`
- `GET /hermes/health`
- `GET /hermes/v1/profiles`（需要 `Authorization: Bearer <HERMES_API_KEY>`）
- `POST /api/auth/login`
- `GET /api/auth/session`
- `GET /api/dashboard`
- `GET /api/profiles`
- `GET /api/proposals`
- `GET /api/proposals/:id`
- `POST /api/proposals`
- `POST /api/proposals/:id/review`
- `PATCH /api/proposals/:id/status`
- `POST /api/proposals/:id/notes`
- `GET /api/proposals/:id/files/:fileId`
- `GET /api/system-backup/export`
- `POST /api/system-config/ai-test`
- `POST /api/system-backup/preview`
- `POST /api/system-backup/restore`
- `GET /api/system-backup/snapshots`
- `POST /api/system-backup/snapshots`
- `POST /api/system-backup/snapshots/prune`
- `POST /api/system-backup/snapshots/:name/restore`
- `GET /api/system-backup/snapshots/:name/preview`
- `GET /api/system-backup/snapshots/:name`
- `DELETE /api/system-backup/snapshots/:name`

## 上线运维清单

- 确认 `first-service-review-api`、`first-service-hermes-gateway`、`nginx` 均为 active。
- 在系统设置页执行“测试 AI 连接”和“检查 Profile 接入”，确认 Hermes 8 个一级专业 Profile 均已匹配。
- 在人员管理中确认管理员/使用者权限边界，导出账号安全清单留档。
- 在日志中心导出账号安全、AI 调用、Hermes 配置和上线确认 CSV 留档。
- 把 aph.firstcare.com.cn 作业标准继续整理为分专业知识库。
- 增强扫描版 PDF/OCR 解析和复杂跨页表格识别。
- 增加数据库、对象存储和定时异地备份。
- 持续维护 HTTPS、强密码或 SSH key、服务器防火墙和异地备份策略。
