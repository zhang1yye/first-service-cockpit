export function spreadsheetSafeText(value = '') {
  const text = value !== null && typeof value === 'object'
    ? JSON.stringify(value)
    : String(value ?? '')
  // Excel 等表格软件会把这些前缀解释成公式；前置单引号强制按文本读取。
  return /^(?:[\t\r]|\s*[=+\-@])/.test(text) ? `'${text}` : text
}

export function csvCell(value = '') {
  const text = spreadsheetSafeText(value)
  return `"${text.replaceAll('"', '""')}"`
}
