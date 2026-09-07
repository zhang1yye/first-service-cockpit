import Panel from '../components/Panel'

export default function PlaceholderView({ title }) {
  return (
    <div className="space-y-4">
      <Panel className="p-12 text-center">
        <h1 className="text-xl font-bold text-blue-200 mb-2">{title}</h1>
        <p className="text-slate-400">该功能正在开发中，敬请期待...</p>
      </Panel>
    </div>
  )
}
