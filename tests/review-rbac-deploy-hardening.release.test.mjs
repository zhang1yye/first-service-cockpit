import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const read = relativePath => fs.readFileSync(path.join(repoRoot, relativePath), 'utf8')

test('后端 RBAC 固定最小权限且遗留角色不可新分配', () => {
  const source = read('review-system/active/backend/server.js')

  assert.match(source, /使用者:\s*\['submitProposal'\]/)
  assert.match(source, /审核员:\s*\['reviewProposal',\s*'viewLogs'\]/)
  assert.match(source, /function isAssignableUserRole/)
  assert.match(source, /return assignableUserRoles\.has/)
  assert.match(source, /if \(!isAssignableUserRole\(role\)\) return res\.status\(400\)/)
  assert.doesNotMatch(source, /\? value : '使用者'/)
  assert.match(source, /nextUser\.status = normalizeUserStatus\(nextUser\.status\) \|\| '停用'/)
  assert.match(source, /nextStatus === '启用' && !isAssignableUserRole\(nextRole\)/)
})

test('部署脚本用 0600 EnvironmentFile 传递密钥，systemd unit 不再写入密钥', () => {
  const deploy = read('review-system/active/deploy.sh')

  assert.match(deploy, /install -m 0600/)
  assert.match(deploy, /EnvironmentFile=\/etc\/first-service\/review-api\.env/)
  assert.match(deploy, /EnvironmentFile=\/etc\/first-service\/hermes-gateway\.env/)
  assert.match(deploy, /REVIEW_SSO_SECRET_FILE=/)
  assert.match(deploy, /review-sso\.secret" "\$SSO_SECRET_PATH"/)
  assert.doesNotMatch(deploy, /Environment="AI_REVIEW_API_KEY=/)
  assert.doesNotMatch(deploy, /Environment="HERMES_API_KEY=/)
  assert.match(deploy, /NoNewPrivileges=true/)
  assert.match(deploy, /ProtectSystem=strict/)
  assert.match(deploy, /UMask=0077/)
  assert.match(deploy, /write_api_env_file "\$TEMP_ENV_DIR\/review-api\.env" 0/)
  assert.match(deploy, /unset BOOTSTRAP_ADMIN_PASSWORD BOOTSTRAP_PASSWORD/)
})
