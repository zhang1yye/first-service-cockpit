import type { FiveBooksLiveDetail, FiveBooksLiveSubject } from './five-books-upstream.js'

interface FiveBooksDemoSnapshot {
  capturedAt: string
  year: number
  period: string
  targetCycle: string
  subjects: FiveBooksLiveSubject[]
  detailsByHeadCode: Record<string, FiveBooksLiveDetail>
}

// Business records excluded from the GitHub source backup.
export const FIVE_BOOKS_DEMO_SNAPSHOT: FiveBooksDemoSnapshot = {
  capturedAt: '', year: 2026, period: 'q2', targetCycle: '', subjects: [], detailsByHeadCode: {}
}
