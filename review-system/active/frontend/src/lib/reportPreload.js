let reportModulePromise = null

export function loadReportTools() {
  if (!reportModulePromise) {
    reportModulePromise = import('./exportReport').catch(error => {
      reportModulePromise = null
      throw error
    })
  }
  return reportModulePromise
}

export function preloadReportTools() {
  loadReportTools().catch(() => {})
}
