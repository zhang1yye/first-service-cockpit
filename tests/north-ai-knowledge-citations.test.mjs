import test from 'node:test'
import assert from 'node:assert/strict'
import vm from 'node:vm'
import { readFile } from 'node:fs/promises'

const assistantUrl = new URL('../firstcare-cloud-local/north-ai-assistant-20260813-r55.js', import.meta.url)
const source = await readFile(assistantUrl, 'utf8')
const index = await readFile(new URL('../firstcare-cloud-local/index.html', import.meta.url), 'utf8')
const evidenceCss = await readFile(new URL('../firstcare-cloud-local/aph2-r66-ai-evidence-20260813-v1.css', import.meta.url), 'utf8')
const opinionCss = await readFile(new URL('../firstcare-cloud-local/aph2-r89-ai-opinion-20260816-v1.css', import.meta.url), 'utf8')

function displayAnswerBuilder() {
  const match = source.match(/function displayAnswerText\(text\) \{[\s\S]*?\n  \}\n\n  function mainAnswerText/)
  assert.ok(match, '应找到回答展示清理函数')
  const functionSource = match[0].replace(/\n\n  function mainAnswerText$/, '')
  return vm.runInNewContext(`(${functionSource})`)
}

function errorMetaBuilder() {
  const match = source.match(/function responseErrorMeta\(data, status\) \{[\s\S]*?\n  \}\n\n  function syncRoute/)
  assert.ok(match, '应找到错误元数据保留函数')
  const functionSource = match[0].replace(/\n\n  function syncRoute$/, '')
  return vm.runInNewContext(`(${functionSource})`)
}

function answerLayerBuilder() {
  const match = source.match(/function displayAnswerText\(text\) \{[\s\S]*?\n  \}\n\n  function mainAnswerText\(text, opinion\) \{[\s\S]*?\n  \}\n\n  function appendAiOpinion/)
  assert.ok(match, '应找到事实正文与AI意见分层函数')
  const functions = match[0].replace(/\n\n  function appendAiOpinion$/, '')
  return vm.runInNewContext(`(() => { ${functions}; return { displayAnswerText, mainAnswerText } })()`)
}

function centerChoiceRenderer() {
  const match = source.match(/function appendCenterChoices\(wrapper, candidates\) \{[\s\S]*?\n  \}\n\n  \/\/ 同名或近似标准/)
  assert.ok(match, '应找到服务中心候选渲染函数')
  const functionSource = match[0].replace(/\n\n  \/\/ 同名或近似标准$/, '')
  const submitted = []
  const document = {
    createElement(tagName) {
      return {
        tagName,
        className: '',
        textContent: '',
        type: '',
        attributes: {},
        children: [],
        listeners: {},
        setAttribute(name, value) { this.attributes[name] = value },
        appendChild(child) { this.children.push(child); return child },
        addEventListener(name, listener) { this.listeners[name] = listener },
      }
    },
  }
  const render = vm.runInNewContext(`(${functionSource})`, {
    document,
    ask(question) { submitted.push(question) },
  })
  return { render, document, submitted }
}

function centerFollowUpRenderer() {
  const match = source.match(/function appendCenterFollowUps\(wrapper, centerPayment\) \{[\s\S]*?\n  \}\n\n  function addMessage/)
  assert.ok(match, '应找到当前中心快捷追问渲染函数')
  const functionSource = match[0].replace(/\n\n  function addMessage$/, '')
  const submitted = []
  const document = {
    createElement(tagName) {
      return {
        tagName, className: '', textContent: '', type: '', attributes: {}, children: [], listeners: {},
        setAttribute(name, value) { this.attributes[name] = value },
        appendChild(child) { this.children.push(child); return child },
        addEventListener(name, listener) { this.listeners[name] = listener },
      }
    },
  }
  return {
    render: vm.runInNewContext(`(${functionSource})`, { document, ask(question) { submitted.push(question) } }),
    document,
    submitted,
  }
}

function knowledgeChoiceRenderer() {
  const match = source.match(/function appendKnowledgeChoices\(wrapper, candidates\) \{[\s\S]*?\n  \}\n\n  \/\/ 回答后围绕当前中心/)
  assert.ok(match, '应找到知识标准候选渲染函数')
  const functionSource = match[0].replace(/\n\n  \/\/ 回答后围绕当前中心$/, '')
  const submitted = []
  const document = {
    createElement(tagName) {
      return {
        tagName, className: '', textContent: '', type: '', attributes: {}, children: [], listeners: {},
        setAttribute(name, value) { this.attributes[name] = value },
        appendChild(child) { this.children.push(child); return child },
        addEventListener(name, listener) { this.listeners[name] = listener },
      }
    },
  }
  return {
    render: vm.runInNewContext(`(${functionSource})`, { document, ask(question) { submitted.push(question) } }),
    document,
    submitted,
  }
}

test('界面隐藏来源、限制说明和知识编号但保留业务结论', () => {
  const display = displayAnswerBuilder()
  const visible = display([
    '中心数据',
    '累计执行：1306.88万',
    'AI建议',
    '建议逐周跟进[K2]',
    '来源：FineReport中心明细 · 2026-08-14',
    '知识依据：[K2]',
    '限制说明：仅回答服务中心回款',
  ].join('\n'))

  assert.match(visible, /中心数据/)
  assert.match(visible, /累计执行：1306\.88万/)
  assert.match(visible, /建议逐周跟进/)
  assert.doesNotMatch(visible, /来源|知识依据|限制说明|\[K2\]/)
  assert.doesNotMatch(source, /appendKnowledgeCitations\(wrapper, meta\.citations\)/)
  assert.doesNotMatch(source, /\(meta\.sources \|\| \[\]\)\.forEach/)
  assert.doesNotMatch(source, /meta\.limitations\?\.length/)
})

test('有结构化AI意见时事实正文不再重复展示判断和建议', () => {
  const { mainAnswerText } = answerLayerBuilder()
  const answer = [
    '中心数据',
    '累计执行：1306.88万',
    'AI判断：预算缺口是主要风险。',
    'AI建议：核对入账与欠费清单。[K1]',
  ].join('\n')
  assert.equal(mainAnswerText(answer, { judgement: '预算缺口是主要风险。' }), '中心数据\n累计执行：1306.88万')
  assert.equal(mainAnswerText('异常重点\n预算缺口是主要风险。', { judgement: '预算缺口是主要风险。' }), '')
  assert.match(mainAnswerText(answer, null), /AI判断/)
})

test('非2xx回应保留门禁代码、业务日期、来源和候选中心', () => {
  const build = errorMetaBuilder()
  const sourceEvidence = [{ name: 'FineReport中心明细', businessDate: '2026-08-12', status: 'warning' }]
  const meta = build({
    code: 'CENTER_PAYMENT_NOT_RESOLVED',
    businessDate: '2026-08-12',
    sources: sourceEvidence,
    limitations: ['服务中心名称存在多个匹配'],
    centerPaymentCandidates: ['中心甲', '中心乙'],
  }, 422)

  assert.equal(meta.errorCode, 'CENTER_PAYMENT_NOT_RESOLVED')
  assert.equal(meta.errorLabel, '服务中心名称待确认')
  assert.equal(meta.statusCode, 422)
  assert.equal(meta.businessDate, '2026-08-12')
  assert.deepEqual(meta.sources, sourceEvidence)
  assert.deepEqual(meta.centerPaymentCandidates, ['中心甲', '中心乙'])
  assert.match(source, /if \(!response\.ok\) \{[\s\S]*?responseErrorMeta\(data, response\.status\)[\s\S]*?addMessage\('assistant'/)
  assert.doesNotMatch(source, /if \(!response\.ok\) throw new Error\(data\.error/)
})

test('知识、数据和AI服务失败使用不同状态文案', () => {
  const build = errorMetaBuilder()
  assert.equal(build({ code: 'APPROVED_KNOWLEDGE_UNAVAILABLE' }, 409).errorLabel, '已批准知识不足')
  assert.equal(build({ code: 'ASSISTANT_DATA_UNAVAILABLE' }, 409).errorLabel, '经营数据暂不可用')
  assert.equal(build({ code: 'AI_GENERATION_UNAVAILABLE' }, 503).errorLabel, 'AI生成服务暂不可用')
  assert.equal(build({ code: 'KNOWLEDGE_SELECTION_REQUIRED' }, 409).errorLabel, '请选择标准')
})

test('跨服务中心403显示范围外文案且不伪造证据元数据', () => {
  const build = errorMetaBuilder()
  const meta = build({
    code: 'SERVICE_CENTER_OUT_OF_SCOPE',
    error: '该服务中心不在当前账号的数据范围内。',
    citations: [],
    fallbackUsed: false,
    readOnly: true,
  }, 403)

  assert.match(source, /SERVICE_CENTER_OUT_OF_SCOPE: '该服务中心不在当前账号范围内'/)
  assert.equal(meta.errorCode, 'SERVICE_CENTER_OUT_OF_SCOPE')
  assert.equal(meta.errorLabel, '该服务中心不在当前账号范围内')
  assert.equal(meta.statusCode, 403)
  assert.deepEqual(meta.citations, [])
  assert.equal(meta.fallbackUsed, false)
  assert.equal(meta.readOnly, true)
  assert.equal(meta.businessDate, undefined)
  assert.equal(meta.sources, undefined)
  assert.equal(meta.centerPaymentCandidates, undefined)
})

test('名称歧义直接显示可点击候选并自动用完整名称重问', () => {
  const { render, document, submitted } = centerChoiceRenderer()
  const wrapper = document.createElement('div')
  render(wrapper, [
    '第一服务北京万国城MOMΛ服务中心',
    '第一服务北京通州万国城MOMΛ服务中心',
    '第一服务北京万国城MOMΛ服务中心',
  ])

  assert.equal(wrapper.children.length, 1)
  const choices = wrapper.children[0]
  assert.equal(choices.className, 'north-ai-center-choices')
  assert.equal(choices.attributes.role, 'group')
  assert.equal(choices.attributes['aria-label'], '请选择服务中心')
  assert.equal(choices.children[0].textContent, '请选择要查询的服务中心')
  assert.equal(choices.children.length, 3, '重复候选应去重')
  assert.equal(choices.children[1].type, 'button')
  choices.children[2].listeners.click()
  assert.deepEqual(submitted, ['第一服务北京通州万国城MOMΛ服务中心数据'])
  assert.match(source, /meta\.errorCode === 'CENTER_PAYMENT_NOT_RESOLVED'[\s\S]*?'服务中心名称待确认'/)
  assert.match(source, /meta\.errorLabel !== quality\.textContent/)
})

test('中心回答后提供三项围绕当前中心的快捷追问', () => {
  const { render, document, submitted } = centerFollowUpRenderer()
  const wrapper = document.createElement('div')
  render(wrapper, { center: '第一服务北京上第MOMΛ服务中心' })
  assert.equal(wrapper.children.length, 1)
  const actions = wrapper.children[0]
  assert.equal(actions.attributes['aria-label'], '继续询问当前服务中心')
  assert.deepEqual(actions.children.slice(1).map(item => item.textContent), ['看未达标指标', '分析异常重点', '给三个优先动作'])
  actions.children[3].listeners.click()
  assert.deepEqual(submitted, ['第一服务北京上第MOMΛ服务中心给我三个优先动作'])
  assert.match(source, /appendCenterFollowUps\(wrapper, meta\.centerPayment\)/)
})

test('多个有效知识标准显示版本与适用范围并可点击选择', () => {
  const { render, document, submitted } = knowledgeChoiceRenderer()
  const wrapper = document.createElement('div')
  render(wrapper, [
    { title: 'PM4-RL-19 第一服务薪酬管理作业标准', version: '13.0', scope: '适用于第一服务控股', question: 'PM4-RL-19 第一服务薪酬管理作业标准' },
    { title: 'PM4-SD-13 上诚物业薪酬管理作业标准', version: '1.0', scope: '适用于山东上诚物业', question: 'PM4-SD-13 上诚物业薪酬管理作业标准' },
  ])
  const choices = wrapper.children[0]
  assert.equal(choices.attributes['aria-label'], '请选择知识标准')
  assert.equal(choices.children[0].textContent, '找到多个有效标准，请选择')
  assert.match(choices.children[1].textContent, /版本 13\.0.*适用于第一服务控股/)
  assert.match(choices.children[2].textContent, /版本 1\.0.*适用于山东上诚物业/)
  choices.children[1].listeners.click()
  assert.deepEqual(submitted, ['PM4-RL-19 第一服务薪酬管理作业标准'])
  assert.match(source, /appendKnowledgeChoices\(wrapper, meta\.knowledgeChoices\)/)
})

test('入口使用新缓存键并加载独立知识证据样式', () => {
  assert.match(index, /north-ai-assistant-20260813-r55\.js\?v=r55-5/)
  assert.match(index, /aph2-r66-ai-evidence-20260813-v1\.css\?v=r66-ai-evidence2/)
  assert.match(index, /aph2-r89-ai-opinion-20260816-v1\.css\?v=r89-ai-opinion1/)
  assert.match(evidenceCss, /#north-ai-assistant \.north-ai-knowledge/)
  assert.match(evidenceCss, /#north-ai-assistant \.north-ai-knowledge-item/)
  assert.match(evidenceCss, /#north-ai-assistant \.north-ai-center-choice/)
  assert.match(evidenceCss, /min-height: 44px/)
  assert.match(source, /localStorage\.getItem\('cockpit_token'\) \|\| localStorage\.getItem\('token'\)/)
  assert.match(source, /直接给出真实数据、未达标指标、AI判断和下一步建议/)
  assert.match(source, /正在检索已批准知识并核对可信事实/)
  assert.match(source, /appendAiOpinion\(wrapper, meta\.aiOpinion\)/)
  assert.match(source, /AI意见用于经营分析和核查提示，不替代业务确认或审批结论/)
  assert.match(opinionCss, /#north-ai-assistant \.north-ai-opinion/)
  assert.match(opinionCss, /min-height: 44px/)
  assert.match(opinionCss, /@media \(max-width: 640px\)/)
})

test('登录后驾驶舱业务路由直接显示AI入口', () => {
  for (const route of ['/payment', '/daily', '/collection', '/ai-alerts', '/ai-report', '/admin']) {
    assert.match(source, new RegExp(route.replace('/', '\\/')))
  }
  assert.match(source, /current\.startsWith\('\/projects\/'\)/)
  assert.match(source, /launcher\.hidden = !visible/)
  assert.match(source, /launcher\.toggleAttribute\('hidden', !visible\)/)
  assert.doesNotMatch(source, /launcher\.hidden = !isHome\(\)/)
})
