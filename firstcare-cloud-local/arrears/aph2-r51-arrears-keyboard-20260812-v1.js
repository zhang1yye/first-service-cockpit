/* R51：欠费经营分析页签键盘模式与滚动表格入口。 */
(() => {
  'use strict'

  const tablist = document.querySelector('.arrears-view-tabs[role="tablist"]')
  const tabs = tablist ? [...tablist.querySelectorAll('[role="tab"]')] : []
  if (tabs.length) {
    const activate = (tab) => {
      tab.focus()
      tab.click()
    }

    tablist.addEventListener('keydown', (event) => {
      const current = tabs.indexOf(document.activeElement)
      if (current < 0) return

      let next = current
      if (event.key === 'ArrowRight') next = (current + 1) % tabs.length
      else if (event.key === 'ArrowLeft') next = (current - 1 + tabs.length) % tabs.length
      else if (event.key === 'Home') next = 0
      else if (event.key === 'End') next = tabs.length - 1
      else return

      event.preventDefault()
      activate(tabs[next])
    })
  }

  document.querySelectorAll('.table-wrap').forEach((region, index) => {
    if (!region.hasAttribute('tabindex')) region.tabIndex = 0
    if (!region.hasAttribute('role')) region.setAttribute('role', 'region')
    if (!region.hasAttribute('aria-label')) {
      region.setAttribute('aria-label', index ? '欠费分析结果表' : '欠费上传批次表，可横向滚动')
    }
  })

  const nameReviewControls = () => {
    document.querySelectorAll('.result-card .review-box').forEach((box, index) => {
      const resource = box.closest('.result-card')?.querySelector('h3')?.textContent?.trim()
        || `第${index + 1}项资源`
      const category = box.querySelector('select')
      const note = box.querySelector('input')
      if (category && !category.getAttribute('aria-label')) {
        category.setAttribute('aria-label', `${resource}人工归因类别`)
      }
      if (note && !note.getAttribute('aria-label')) {
        note.setAttribute('aria-label', `${resource}人工核验说明`)
      }
    })
  }

  nameReviewControls()
  const resultRows = document.querySelector('#resultRows')
  if (resultRows) {
    new MutationObserver(nameReviewControls).observe(resultRows, {
      childList: true,
      subtree: true,
    })
  }

  document.body.setAttribute('data-r51-arrears-keyboard', 'ready')
})()
