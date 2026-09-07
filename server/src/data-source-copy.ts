export type ProjectOperatingSourceCopy = {
  detail: string
  suggestion: string
  operatorAction: string
}

export function projectOperatingSourceCopy(projectCount: number): ProjectOperatingSourceCopy {
  const count = Math.max(0, Number(projectCount) || 0)
  if (count > 0) {
    return {
      detail: `检测到${count}条历史项目经营记录，当前系统不启用。`,
      suggestion: '当前只使用APH回款、绿仔正式收缴和权威项目目录。',
      operatorAction: '不得将历史项目经营记录用于页面、AI、月报、归档或导出；如需启用必须重新立项。',
    }
  }
  return {
    detail: '项目经营数据源当前不接入',
    suggestion: '当前只使用APH回款、绿仔正式收缴和权威项目目录。',
    operatorAction: '无需补录成本、利润率、品质、安全、满意度等项目经营字段；不得恢复演示项目。',
  }
}
