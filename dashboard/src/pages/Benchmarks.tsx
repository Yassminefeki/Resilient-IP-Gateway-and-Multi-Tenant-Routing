import { useState } from 'react'

interface Props {
  showToast: (title: string, message: string, type?: 'info' | 'success' | 'warning' | 'error') => void
}

export default function Benchmarks({ showToast }: Props) {
  const [running, setRunning] = useState(false)
  const [history, setHistory] = useState([
    { run: '#14 (Today)', failover: '412ms', rollback: '640ms', p95: '2.31s', success: '100%' },
    { run: '#13 (Yesterday)', failover: '445ms', rollback: '710ms', p95: '2.45s', success: '96.7%' },
    { run: '#12 (2d ago)', failover: '398ms', rollback: '620ms', p95: '2.20s', success: '100%' },
  ])

  function runSuite() {
    setRunning(true)
    showToast('Benchmark Suite Running', 'Executing 10 parallel Nova VM provisions, VRRP failover probe, and config rollback check...', 'info')
    setTimeout(() => {
      setRunning(false)
      const newRun = {
        run: `#${history.length + 12} (Just now)`,
        failover: `${Math.floor(Math.random() * 50 + 390)}ms`,
        rollback: `${Math.floor(Math.random() * 60 + 590)}ms`,
        p95: '2.14s',
        success: '100%',
      }
      setHistory(prev => [newRun, ...prev])
      showToast('Benchmarks Completed', 'All SLA gates passed: Failover < 1000ms, Provision < 5s, Zero dropped packets.', 'success')
    }, 2200)
  }

  return (
    <div className="space-y-6">
      {/* Header bar */}
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-3">
        <div>
          <h2 className="text-[20px] font-bold text-[#170B1B]">Performance Benchmarks &amp; SLAs</h2>
          <p className="text-xs text-[#827787]">Simulated real-world stress test telemetry for the OpenStack Control Plane and HAProxy Gateway.</p>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={runSuite}
            disabled={running}
            className="px-3.5 py-1.5 bg-[#2D0035] text-white hover:bg-[#492B50] rounded-[10px] text-xs font-medium flex items-center gap-1.5 shadow-xs transition-colors disabled:opacity-50"
          >
            <span className={`material-symbols-outlined text-[15px] ${running ? 'animate-spin' : ''}`}>
              {running ? 'refresh' : 'play_arrow'}
            </span>
            <span>{running ? 'Executing Tests…' : 'Run Benchmark Suite'}</span>
          </button>
        </div>
      </div>

      {/* 4 Metric cards */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <div className="bg-white border border-[#E8E0EA] rounded-[14px] p-4 shadow-xs">
          <span className="text-xs text-[#827787]">Nova VM Provisioning p50 / p95</span>
          <div className="mt-2 text-xl font-bold font-mono text-[#170B1B]">1.84s / 2.31s</div>
          <span className="badge badge-emerald mt-2">Well Under 5s SLA</span>
        </div>
        <div className="bg-white border border-[#E8E0EA] rounded-[14px] p-4 shadow-xs">
          <span className="text-xs text-[#827787]">VRRP Gateway Failover</span>
          <div className="mt-2 text-xl font-bold font-mono text-[#2D0035]">412 ms</div>
          <span className="badge badge-emerald mt-2">Sub-second Zero Drop</span>
        </div>
        <div className="bg-white border border-[#E8E0EA] rounded-[14px] p-4 shadow-xs">
          <span className="text-xs text-[#827787]">Config Rollback Latency</span>
          <div className="mt-2 text-xl font-bold font-mono text-purple-900">640 ms</div>
          <span className="badge badge-emerald mt-2">Transaction Verified</span>
        </div>
        <div className="bg-white border border-[#E8E0EA] rounded-[14px] p-4 shadow-xs">
          <span className="text-xs text-[#827787]">Concurrent Stress Success</span>
          <div className="mt-2 text-xl font-bold font-mono text-emerald-700">98.4%</div>
          <span className="badge badge-emerald mt-2">10 Teams Parallel</span>
        </div>
      </div>

      {/* Benchmark run history */}
      <div className="bg-white border border-[#E8E0EA] rounded-[14px] p-5 shadow-xs space-y-3">
        <div className="flex items-center justify-between pb-2 border-b border-[#E8E0EA]">
          <h3 className="text-xs font-semibold text-[#170B1B]">Benchmark History</h3>
          <span className="text-xs font-mono text-[#827787]">Strict SLA Enforcement</span>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs border-collapse">
            <thead>
              <tr className="bg-[#F8F6F9] border-b border-[#E8E0EA] text-[#827787] text-[11px] font-medium uppercase tracking-wider">
                <th className="p-3 pl-3">BENCHMARK RUN</th>
                <th className="p-3">FAILOVER</th>
                <th className="p-3">ROLLBACK</th>
                <th className="p-3">PROVISION P95</th>
                <th className="p-3">SUCCESS RATE</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[#E8E0EA] font-mono text-xs">
              {history.map((h, i) => (
                <tr key={i} className="hover:bg-[#F8F6F9] transition-colors">
                  <td className="p-3 pl-3 font-sans font-bold text-[#170B1B]">{h.run}</td>
                  <td className="p-3 text-purple-900 font-semibold">{h.failover}</td>
                  <td className="p-3 text-blue-900 font-semibold">{h.rollback}</td>
                  <td className="p-3 text-gray-800">{h.p95}</td>
                  <td className="p-3 text-emerald-700 font-bold">{h.success}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  )
}
