import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'

const root = path.resolve(import.meta.dirname, '..')
const release = path.join(root, 'deploy/r51-review-recovery')

test('遗留 APH 服务不再由公网 Nginx 暴露', () => {
  const nginx = fs.readFileSync(path.join(release, 'review-system.conf'), 'utf8')
  assert.match(nginx, /location = \/review-api\/aph\s*\{\s*return 404;\s*\}/)
  assert.match(nginx, /location \^~ \/review-api\/aph\/\s*\{\s*return 404;\s*\}/)
  assert.doesNotMatch(nginx, /127\.0\.0\.1:8788|127\.0\.0\.1:8789|proxy_pass[^;]*(?:8788|8789)/)
})

test('遗留 unit 不再保存供应商密钥并以非 root 身份运行', () => {
  for (const name of ['review-server.service', 'review-ws.service']) {
    const unit = fs.readFileSync(path.join(release, name), 'utf8')
    assert.doesNotMatch(unit, /DEEPSEEK_API_KEY|Environment=.*(?:KEY|SECRET|TOKEN|PASSWORD)/i)
    assert.match(unit, /^User=ubuntu$/m)
    assert.match(unit, /^Group=ubuntu$/m)
    assert.match(unit, /^UMask=0077$/m)
    assert.match(unit, /^NoNewPrivileges=true$/m)
  }
})

test('现代审核服务与 deploy.sh 保持严格 systemd 沙箱合同', () => {
  const deploy = fs.readFileSync(path.join(root, 'review-system/active/deploy.sh'), 'utf8')
  const units = [
    {
      name: 'first-service-review-api.service',
      environmentFile: '/etc/first-service/review-api.env',
      identity: ['User=ubuntu', 'Group=ubuntu'],
      storage: [
        'ReadWritePaths=/home/ubuntu/first-service-review-system/backend/data',
        'ReadWritePaths=/var/lib/first-service-review-api',
        'StateDirectory=first-service-review-api'
      ]
    },
    {
      name: 'first-service-hermes-gateway.service',
      environmentFile: '/etc/first-service/hermes-gateway.env',
      identity: ['DynamicUser=yes'],
      storage: ['StateDirectory=first-service-hermes-agent']
    }
  ]
  const sharedSandbox = [
    'NoNewPrivileges=true',
    'PrivateTmp=true',
    'PrivateDevices=true',
    'ProtectSystem=strict',
    'ProtectClock=true',
    'ProtectControlGroups=true',
    'ProtectKernelLogs=true',
    'ProtectKernelModules=true',
    'ProtectKernelTunables=true',
    'ProtectHostname=true',
    'LockPersonality=true',
    'RestrictSUIDSGID=true',
    'RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6',
    'CapabilityBoundingSet=',
    'AmbientCapabilities='
  ]

  for (const directive of sharedSandbox) {
    assert.ok(deploy.split(directive).length >= 3, `deploy.sh 两个 unit 均应包含 ${directive}`)
  }

  for (const { name, environmentFile, identity, storage } of units) {
    const unit = fs.readFileSync(path.join(release, name), 'utf8')
    const lines = new Set(unit.split(/\r?\n/))
    assert.doesNotMatch(unit, /^Environment=.*(?:KEY|SECRET|TOKEN|PASSWORD)/im)
    assert.ok(lines.has(`EnvironmentFile=${environmentFile}`))
    for (const directive of identity) assert.ok(lines.has(directive), `${name} 缺少 ${directive}`)
    assert.ok(lines.has('UMask=0077'))
    assert.ok(lines.has('After=network-online.target'))
    assert.ok(lines.has('Wants=network-online.target'))
    for (const directive of storage) assert.ok(lines.has(directive), `${name} 缺少 ${directive}`)
    for (const directive of sharedSandbox) {
      assert.ok(lines.has(directive), `${name} 缺少 ${directive}`)
    }
    assert.ok(!lines.has('ProtectSystem=full'))
    assert.ok(lines.has(name === 'first-service-review-api.service' ? 'ProtectHome=read-only' : 'ProtectHome=true'))
  }
})

test('遗留 Python 服务不含硬编码密钥且缺密钥时失败关闭', () => {
  const source = fs.readFileSync(path.join(root, 'review-system/server.py'), 'utf8')
  assert.doesNotMatch(source, /sk-[A-Za-z0-9_-]{16,}/)
  assert.match(source, /if not DEEPSEEK_API_KEY:/)
  assert.match(source, /DeepSeek API 密钥未配置/)
})
