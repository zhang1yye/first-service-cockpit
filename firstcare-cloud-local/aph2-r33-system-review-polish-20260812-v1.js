(() => {
  'use strict'

  const TARGET_ROUTES = new Set(['/system', '/admin', '/review', '/login'])
  let scheduled = false

  function setRouteScope() {
    document.body?.classList.toggle('aph-r33-ui-polish', TARGET_ROUTES.has(window.location.pathname))
  }

  function normalizeShellHeading() {
    document.querySelectorAll('header h1').forEach(heading => {
      const replacement = document.createElement('div')
      replacement.className = heading.className
      replacement.textContent = heading.textContent
      replacement.dataset.aphShellTitle = 'true'
      heading.replaceWith(replacement)
    })
  }

  function activateReviewTab(button) {
    if (!(button instanceof HTMLButtonElement)) return
    button.click()
    window.requestAnimationFrame(() => button.focus())
  }

  function bindTablistKeyboard(tablist) {
    if (!(tablist instanceof HTMLElement) || tablist.dataset.aphR33Keyboard === '1') return
    tablist.addEventListener('keydown', event => {
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return
      const tabs = [...tablist.querySelectorAll(':scope > button[role="tab"]')]
        .filter(button => !button.hidden && !button.disabled)
      if (!tabs.length) return
      const current = tabs.indexOf(document.activeElement)
      const fallback = Math.max(0, tabs.findIndex(button => button.getAttribute('aria-selected') === 'true'))
      const index = current >= 0 ? current : fallback
      const next = event.key === 'Home' ? 0
        : event.key === 'End' ? tabs.length - 1
          : event.key === 'ArrowRight' ? (index + 1) % tabs.length
            : (index - 1 + tabs.length) % tabs.length
      event.preventDefault()
      activateReviewTab(tabs[next])
    })
    tablist.dataset.aphR33Keyboard = '1'
  }

  function enhanceReview() {
    if (window.location.pathname !== '/review') return
    const switcher = document.querySelector('.aph-review-workbench-switch')
    if (!switcher) return
    bindTablistKeyboard(switcher)
    switcher.querySelectorAll('.aph-review-ops-groups').forEach(bindTablistKeyboard)
  }

  function enhanceLogin() {
    if (window.location.pathname !== '/login') return
    const form = document.querySelector('#root form')
    if (!form) return

    const password = form.querySelector('input[type="password"], input[autocomplete="current-password"]')
    const field = password?.parentElement
    if (password && field && field.dataset.aphR33Password !== '1') {
      field.classList.add('aph-r33-login-password')
      const toggle = document.createElement('button')
      toggle.type = 'button'
      toggle.className = 'aph-r33-password-toggle'
      toggle.textContent = '显示'
      toggle.setAttribute('aria-label', '显示登录密码')
      toggle.setAttribute('aria-pressed', 'false')
      toggle.addEventListener('click', () => {
        const visible = password.type === 'text'
        password.type = visible ? 'password' : 'text'
        toggle.textContent = visible ? '显示' : '隐藏'
        toggle.setAttribute('aria-label', visible ? '显示登录密码' : '隐藏登录密码')
        toggle.setAttribute('aria-pressed', String(!visible))
      })
      field.append(toggle)
      field.dataset.aphR33Password = '1'
    }

    if (!form.nextElementSibling?.classList.contains('aph-r33-login-help')) {
      const help = document.createElement('p')
      help.className = 'aph-r33-login-help'
      help.textContent = '账号或密码有问题，请联系系统管理员；登录后将按账号权限展示片区和项目。'
      form.after(help)
    }

    const submit = form.querySelector('button[type="submit"]')
    if (submit && !submit.title) submit.title = '请输入用户名和密码后登录'
  }

  function apply() {
    scheduled = false
    setRouteScope()
    normalizeShellHeading()
    enhanceReview()
    enhanceLogin()
  }

  function schedule() {
    if (scheduled) return
    scheduled = true
    window.requestAnimationFrame(apply)
  }

  function start() {
    schedule()
    new MutationObserver(schedule).observe(document.getElementById('root') || document.documentElement, {
      childList: true,
      subtree: true,
    })
  }

  window.addEventListener('DOMContentLoaded', start, { once: true })
  window.addEventListener('popstate', schedule)
  window.addEventListener('cockpit:navigation', schedule)
  if (document.readyState !== 'loading') start()
})()
