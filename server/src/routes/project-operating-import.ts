import { Router } from 'express'
import { buildResponseContext } from '../response-context.js'
import { validateProjectOperatingBundle } from '../project-operating-contract.js'

const router = Router()

// 只做内存校验，不入库、不改变正式项目数据。
router.post('/api/project-operating-import/validate', (req, res) => {
  const validation = validateProjectOperatingBundle(req.body)
  const status = validation.valid ? 200 : 422
  return res.status(status).json({
    readyForControlledPreview: validation.valid,
    published: false,
    validation,
    meta: buildResponseContext(req, {
      businessDate: req.body?.businessDate,
      extractedAt: req.body?.extractedAt,
      sources: ['项目级经营事实导入包'],
      publicationStatus: validation.valid ? 'previewed' : 'blocked',
      qualityStatus: validation.valid ? 'ready' : 'blocked',
      qualityMessage: validation.valid ? '已通过结构校验，尚未发布' : '未通过项目经营事实门禁',
      batchSha256: validation.batchSha256,
      canWrite: false,
      canExport: false,
    }),
  })
})

export default router
