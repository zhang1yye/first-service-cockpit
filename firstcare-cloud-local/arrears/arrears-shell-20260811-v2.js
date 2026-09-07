/* 欠费分析独立页导航：悬停覆盖展开，菜单按钮用于键盘和触屏切换。 */
(() => {
  'use strict'

  const nav = document.querySelector('.aph-icon-rail')
  const menu = document.querySelector('.aph-menu-toggle')
  if (!nav || !menu) return

  const setExpanded = (expanded) => {
    nav.classList.toggle('is-expanded', expanded)
    menu.setAttribute('aria-expanded', String(expanded))
  }

  menu.addEventListener('click', () => setExpanded(!nav.classList.contains('is-expanded')))
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') setExpanded(false)
  })
})()
