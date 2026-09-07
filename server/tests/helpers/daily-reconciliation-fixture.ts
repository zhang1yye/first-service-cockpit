export const dailyMergeGroups = [
  { sources: ['第一服务北京满庭芳园服务中心', '第一服务北京青云大厦服务中心'], target: '第一服务满庭青云服务中心' },
  { sources: ['第一服务北京西山上品湾MOMΛ服务中心', '第一服务北京西山上品湾二期MOMΛ服务中心'], target: '第一服务北京西山上品湾MOMΛ服务中心' },
  { sources: ['第一服务北京上第MOMΛ服务中心', '第一服务北京IMOMΛ服务中心', '第一服务北京悦MOMΛ服务中心'], target: '第一服务北京上第MOMΛ服务中心' },
  { sources: ['第一服务北京MOMΛ万万树服务中心一期', '第一服务北京MOMΛ万万树服务中心二期'], target: '第一服务北京MOMΛ万万树服务中心' },
]

export function dailyCenterFixture(focusCenter: string) {
  const canonicalCenters = [
    ...dailyMergeGroups.map((group) => group.target),
    focusCenter,
    ...Array.from({ length: 51 }, (_, index) => `第一服务测试${String(index + 1).padStart(2, '0')}服务中心`),
  ]
  const rawCenters = canonicalCenters.flatMap((canonical) => dailyMergeGroups.find((group) => group.target === canonical)?.sources || [canonical])
  return {
    canonicalCenters,
    rawRows: (daily: number) => rawCenters.map((center) => ({ center, dailyCollection: center === focusCenter ? daily : 0 })),
  }
}
