const COMMON_PASSWORDS = new Set([
  '123456789012', 'password1234', 'admin123456', 'firstcare123', 'zhangye123456',
])

export function validatePassword(password: unknown, username = ''): { ok: boolean; error?: string } {
  const value = String(password || '')
  if (!value) return { ok: false, error: '密码不能为空' }
  if (username && value.toLocaleLowerCase() === String(username).trim().toLocaleLowerCase()) {
    return { ok: false, error: '密码不能与用户名相同' }
  }
  if (COMMON_PASSWORDS.has(value.toLocaleLowerCase())) {
    return { ok: false, error: '密码过于简单，请更换后重试' }
  }
  return { ok: true }
}
