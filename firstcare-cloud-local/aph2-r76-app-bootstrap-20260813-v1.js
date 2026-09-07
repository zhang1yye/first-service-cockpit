/* R76：等待权限范围初始化后加载含成员多范围管理的不可变主应用。 */
;(async () => {
  await Promise.resolve(window.__aphR65ScopeReady)
  await import('/assets/cockpit-r76-member-scope-20260813-v1/app-G7HUEEER.js')
})().catch((error) => {
  console.error('[R76 bootstrap]', error)
})
