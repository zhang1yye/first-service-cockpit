import { Router } from 'express'
import fs from 'node:fs'
import os from 'node:os'
import crypto from 'node:crypto'
import { requireAdmin } from '../auth.js'

const router = Router()
const DEFAULT_REVIEW_SYSTEM_URL = '/review-system/'
const DEFAULT_COCKPIT_IP_URL = 'https://www.firstcare.cloud/'


function loadReviewSsoSecret(): string {
  if (process.env.REVIEW_SSO_SECRET && process.env.REVIEW_SSO_SECRET.length >= 32) return process.env.REVIEW_SSO_SECRET
  const secretPath = process.env.REVIEW_SSO_SECRET_FILE || `${os.homedir()}/.cockpit_review_sso_secret`
  if (fs.existsSync(secretPath)) return fs.readFileSync(secretPath, 'utf8').trim()
  const secret = crypto.randomBytes(48).toString('base64url')
  fs.writeFileSync(secretPath, secret, { mode: 0o600 })
  return secret
}

function base64url(input: string): string {
  return Buffer.from(input, 'utf8').toString('base64url')
}

function signReviewSso(user: any): string {
  const payload = base64url(JSON.stringify({
    username: user?.username || 'cockpit-admin',
    name: user?.username || '驾驶舱管理员',
    role: '管理员',
    exp: Date.now() + 60_000,
    nonce: crypto.randomBytes(12).toString('hex'),
  }))
  const sig = crypto.createHmac('sha256', loadReviewSsoSecret()).update(payload).digest('base64url')
  return `${payload}.${sig}`
}

function reviewSystemUrl() {
  const configuredUrl = process.env.REVIEW_SYSTEM_URL?.trim()
  if (configuredUrl) return configuredUrl

  const configuredPath = process.env.REVIEW_SYSTEM_PATH?.trim()
  if (!configuredPath) return DEFAULT_REVIEW_SYSTEM_URL

  const reviewPath = configuredPath.startsWith('/') ? configuredPath : `/${configuredPath}`
  const publicBase = process.env.COCKPIT_PUBLIC_URL?.trim()

  if (publicBase) return new URL(reviewPath, publicBase.endsWith('/') ? publicBase : `${publicBase}/`).toString()
  return reviewPath
}

router.get('/api/integrations/review', requireAdmin, (_req, res) => {
  res.json({
    key: 'review-collaboration',
    name: '研发小组审核系统',
    description: '研发小组审核系统已作为驾驶舱板块接入，统一从 firstcare.cloud 访问',
    targetUrl: reviewSystemUrl(),
    cockpitIpUrl: process.env.COCKPIT_IP_URL?.trim() || DEFAULT_COCKPIT_IP_URL,
    redirectUrl: '/api/integrations/review/redirect',
  })
})

router.get('/api/integrations/sites', requireAdmin, (_req, res) => {
  res.json({
    rows: [
      {
        key: 'review-domain',
        name: '第一服务研发小组审核系统',
        type: 'domain',
        url: reviewSystemUrl(),
      },
      {
        key: 'cockpit-ip',
        name: '华北智能驾驶舱域名入口',
        type: 'domain',
        url: process.env.COCKPIT_IP_URL?.trim() || DEFAULT_COCKPIT_IP_URL,
      },
    ],
  })
})

router.post('/api/integrations/review/sso', requireAdmin, (req, res) => {
  const target = reviewSystemUrl()
  const sep = target.includes('?') ? '&' : '?'
  res.json({ url: `${target}${sep}sso=${encodeURIComponent(signReviewSso((req as any).user))}` })
})

router.get('/api/integrations/review/redirect', requireAdmin, (req, res) => {
  const target = reviewSystemUrl()
  const sep = target.includes('?') ? '&' : '?'
  res.redirect(302, `${target}${sep}sso=${encodeURIComponent(signReviewSso((req as any).user))}`)
})

export default router
