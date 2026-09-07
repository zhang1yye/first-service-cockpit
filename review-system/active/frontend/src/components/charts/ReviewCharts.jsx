import { Area, AreaChart, Bar, BarChart, Cell, Pie, PieChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'

const tooltipStyle = { background: '#020617', border: '1px solid rgba(59,130,246,.35)', borderRadius: 8 }

function chartSummary(data = [], valueKey = 'value', labelKey = 'name', suffix = '') {
  if (!Array.isArray(data) || data.length === 0) return '暂无图表数据'
  return data.map(item => `${item?.[labelKey] || '未命名'} ${item?.[valueKey] ?? 0}${suffix}`).join('，')
}

function AccessibleChart({ summary, children }) {
  return (
    <div className="h-full w-full">
      <p className="sr-only">{summary}</p>
      <div className="h-full w-full" aria-hidden="true">{children}</div>
    </div>
  )
}

export function StatusPieChart({ data }) {
  return (
    <AccessibleChart summary={`审核状态分布：${chartSummary(data)}`}>
      <ResponsiveContainer width="100%" height="85%">
        <PieChart>
          <Pie data={data} dataKey="value" innerRadius={62} outerRadius={96} paddingAngle={3} isAnimationActive={false} rootTabIndex={-1}>
            {data.map(item => <Cell key={item.name} fill={item.color} />)}
          </Pie>
          <Tooltip contentStyle={tooltipStyle} />
        </PieChart>
      </ResponsiveContainer>
    </AccessibleChart>
  )
}

export function TypeBarChart({ data }) {
  return (
    <AccessibleChart summary={`方案类型统计：${chartSummary(data)}`}>
      <ResponsiveContainer width="100%" height="85%">
        <BarChart data={data}>
          <XAxis dataKey="name" stroke="#64748b" fontSize={12} tickLine={false} axisLine={false} />
          <YAxis stroke="#64748b" fontSize={12} tickLine={false} axisLine={false} allowDecimals={false} />
          <Tooltip contentStyle={tooltipStyle} />
          <Bar dataKey="value" name="方案数" fill="#38bdf8" radius={[6, 6, 0, 0]} isAnimationActive={false} />
        </BarChart>
      </ResponsiveContainer>
    </AccessibleChart>
  )
}

export function ScoreBarChart({ data }) {
  return (
    <AccessibleChart summary={`方案评分分布：${chartSummary(data, 'score', 'name', '分')}`}>
      <ResponsiveContainer width="100%" height="86%">
        <BarChart data={data}>
          <XAxis dataKey="name" stroke="#64748b" fontSize={12} tickLine={false} axisLine={false} />
          <YAxis stroke="#64748b" fontSize={12} tickLine={false} axisLine={false} domain={[0, 100]} />
          <Tooltip contentStyle={tooltipStyle} />
          <Bar dataKey="score" name="综合评分" fill="#10b981" radius={[6, 6, 0, 0]} isAnimationActive={false} />
        </BarChart>
      </ResponsiveContainer>
    </AccessibleChart>
  )
}

export function ReminderStageBarChart({ data }) {
  return (
    <AccessibleChart summary={`催办阶段建议：${chartSummary(data, 'value', 'label')}`}>
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={data}>
          <XAxis dataKey="label" stroke="#64748b" fontSize={12} tickLine={false} axisLine={false} />
          <YAxis stroke="#64748b" fontSize={12} tickLine={false} axisLine={false} allowDecimals={false} />
          <Tooltip contentStyle={tooltipStyle} />
          <Bar dataKey="value" name="建议数" fill="#22d3ee" radius={[6, 6, 0, 0]} isAnimationActive={false} />
        </BarChart>
      </ResponsiveContainer>
    </AccessibleChart>
  )
}

export function TrendAreaChart({ data }) {
  return (
    <AccessibleChart summary={`审核效率趋势：${(data || []).map(item => `${item.date || '未记录日期'} 提交 ${item.submit ?? 0}，通过 ${item.pass ?? 0}`).join('；') || '暂无图表数据'}`}>
      <ResponsiveContainer width="100%" height="82%">
        <AreaChart data={data || []}>
          <defs>
            <linearGradient id="submit" x1="0" y1="0" x2="0" y2="1">
              <stop offset="5%" stopColor="#bd1e2d" stopOpacity={0.35} />
              <stop offset="95%" stopColor="#bd1e2d" stopOpacity={0} />
            </linearGradient>
            <linearGradient id="pass" x1="0" y1="0" x2="0" y2="1">
              <stop offset="5%" stopColor="#10b981" stopOpacity={0.5} />
              <stop offset="95%" stopColor="#10b981" stopOpacity={0} />
            </linearGradient>
          </defs>
          <XAxis dataKey="date" stroke="#64748b" fontSize={11} tickLine={false} axisLine={false} />
          <YAxis stroke="#64748b" fontSize={11} tickLine={false} axisLine={false} width={28} />
          <Tooltip contentStyle={tooltipStyle} />
          <Area type="monotone" dataKey="submit" name="提交数" stroke="#bd1e2d" fill="url(#submit)" strokeWidth={2} isAnimationActive={false} />
          <Area type="monotone" dataKey="pass" name="通过数" stroke="#10b981" fill="url(#pass)" strokeWidth={2} isAnimationActive={false} />
        </AreaChart>
      </ResponsiveContainer>
    </AccessibleChart>
  )
}

export function ProfessionalPieChart({ data }) {
  return (
    <AccessibleChart summary={`专业任务占比：${chartSummary(data, 'value', 'name', '%')}`}>
      <ResponsiveContainer width="100%" height="100%">
        <PieChart>
          <Pie data={data} dataKey="value" innerRadius={38} outerRadius={66} paddingAngle={2} isAnimationActive={false} rootTabIndex={-1}>
            {data.map(entry => <Cell key={entry.name} fill={entry.color} />)}
          </Pie>
        </PieChart>
      </ResponsiveContainer>
    </AccessibleChart>
  )
}
