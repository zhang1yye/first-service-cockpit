# 第一服务华北驾驶舱生产操作约束

本仓库当前承载 R128 干净、可复现的生产基线（标签 `production-r128-20260826`）；目录名中的 `production-r127` 仅为历史路径，不代表当前版本。任何 Codex、Hermes 或其他自动化代理在此目录工作时必须遵守：

1. 使用 Node 20 和锁文件；先执行快照校验、干净构建和生产契约测试。
2. 修改必须位于 `production/<change>` 分支并提交，然后推送 `cloud-ci`；不得从历史开发工作区直接发布。
3. CI 状态必须为 `passed` 才能形成上线候选；CI 不自动上线。
4. 只有用户明确确认上线后，才能使用 manifest 门禁发布脚本。
5. 禁止直接编辑生产 `index.html`、直接在生产目录运行 `tsc` 后上线，或绕过哈希、备份、Nginx、健康检查及回滚门禁。
6. 数据库、密钥、日志、导入文件、欠费原始数据和运行产物不得进入 Git。

## 固定路径与命令

- 工作区：`/Users/zhangye/Documents/Codex/第一服务华北地区经营驾驶舱-production-r127`
- 生产 SSH：`cloud-hermes`
- CI 远端：`cloud-ci`
- CI 状态：`scripts/cloud-ci-status.sh`
- CI 目录：`/home/ubuntu/ci/first-service-cockpit`
- 发布脚本：`/home/ubuntu/releases/source-baselines/deploy-production-release.sh`

```bash
git switch -c production/<change>
git add .
git commit -m "说明修改"
git push -u cloud-ci HEAD
scripts/cloud-ci-status.sh
```

只有 CI 通过且用户明确确认后，才可部署 `/home/ubuntu/ci/first-service-cockpit/artifacts/<run-id>`。
