/* 旧地址不再展示独立壳层；顶层访问回到驾驶舱主路由，嵌入时只显示业务内容。 */
(() => {
  'use strict'
  if (window.top === window.self) {
    window.location.replace('/arrears')
    return
  }
  document.documentElement.classList.add('aph-arrears-embedded')
})()
