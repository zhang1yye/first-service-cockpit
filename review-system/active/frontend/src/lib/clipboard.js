export async function copyText(text) {
  const content = String(text ?? '')

  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(content)
      return true
    } catch {
      // 现代剪贴板接口在部分浏览器环境下会被权限策略拦截，继续走兜底复制。
    }
  }

  const textarea = document.createElement('textarea')
  textarea.value = content
  textarea.setAttribute('readonly', 'readonly')
  textarea.style.position = 'fixed'
  textarea.style.top = '-9999px'
  textarea.style.left = '-9999px'
  textarea.style.opacity = '0'
  document.body.appendChild(textarea)
  textarea.focus()
  textarea.select()

  let copied = false
  try {
    copied = document.execCommand('copy')
  } finally {
    textarea.remove()
  }

  if (!copied) {
    throw new Error('复制失败')
  }

  return true
}
