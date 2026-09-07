let chartModulePromise = null

export function loadReviewCharts() {
  if (!chartModulePromise) {
    chartModulePromise = import('../components/charts/ReviewCharts').catch(error => {
      chartModulePromise = null
      throw error
    })
  }
  return chartModulePromise
}

export function preloadReviewCharts() {
  loadReviewCharts().catch(() => {})
}
