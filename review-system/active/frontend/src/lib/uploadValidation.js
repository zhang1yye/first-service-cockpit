function fileExtension(file) {
  const name = String(file?.name || '')
  const index = name.lastIndexOf('.')
  return index >= 0 ? name.slice(index).toLowerCase() : ''
}

export function uploadFormatError(file, allowedExtensions = [], label = '上传文件') {
  if (!file) return ''
  const allowed = new Set(allowedExtensions.map(item => String(item).toLowerCase()))
  if (allowed.has(fileExtension(file))) return ''
  const allowedText = allowedExtensions.map(item => String(item).replace('.', '').toUpperCase()).join('、')
  return `${label}格式不支持：${file.name || '未命名文件'}。请上传 ${allowedText} 文件。`
}
