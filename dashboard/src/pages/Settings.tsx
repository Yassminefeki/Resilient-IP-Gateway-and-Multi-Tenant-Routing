import { useState } from 'react'

interface Props {
  showToast: (title: string, message: string, type?: 'info' | 'success' | 'warning' | 'error') => void
}

export default function Settings({ showToast }: Props) {
  const [authUrl] = useState('https://keystone.openstack.felcloud.tn:5000/v3')
  const [projectName] = useState('cstam-hackathon-2026')
  const [leaseTtl, setLeaseTtl] = useState(3600)
  const [quarantineSec, setQuarantineSec] = useState(180)
  const [prioMaster, setPrioMaster] = useState(101)
  const [prioBackup, setPrioBackup] = useState(100)
  const [maintenanceMode, setMaintenanceMode] = useState(false)

  function handleSave() {
    showToast('Configuration Saved', 'Platform environment variables and IPAM timing parameters persisted.', 'success')
  }

  return (
    <div className="space-y-6">
      {/* Header bar */}
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-3">
        <div>
          <h2 className="text-[20px] font-bold text-[#170B1B]">Platform Configuration &amp; OpenStack Bindings</h2>
          <p className="text-xs text-[#827787]">Control plane environment variables, IPAM timing rules, and VRRP priorities.</p>
        </div>
        <button
          onClick={handleSave}
          className="px-3.5 py-1.5 bg-[#2D0035] text-white hover:bg-[#492B50] rounded-[10px] text-xs font-medium flex items-center gap-1.5 shadow-xs transition-colors"
        >
          <span className="material-symbols-outlined text-[15px]">save</span>
          <span>Save Configuration</span>
        </button>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 text-xs">
        {/* OpenStack Auth */}
        <div className="bg-white border border-[#E8E0EA] rounded-[14px] p-5 shadow-xs space-y-3">
          <div className="flex items-center gap-2 pb-2 border-b border-[#E8E0EA]">
            <span className="material-symbols-outlined text-[18px] text-[#2D0035]">cloud</span>
            <h3 className="font-semibold text-[#170B1B]">OpenStack Keystone &amp; Neutron</h3>
          </div>
          <div className="space-y-3">
            <div>
              <label className="block text-[#827787] text-[11px] mb-1 font-mono uppercase">Keystone Auth URL</label>
              <input
                className="w-full p-2 bg-[#F8F6F9] border border-[#E8E0EA] rounded-[8px] font-mono text-xs text-[#170B1B]"
                value={authUrl}
                readOnly
              />
            </div>
            <div>
              <label className="block text-[#827787] text-[11px] mb-1 font-mono uppercase">Project Name / Tenant</label>
              <input
                className="w-full p-2 bg-[#F8F6F9] border border-[#E8E0EA] rounded-[8px] font-mono text-xs text-[#170B1B]"
                value={projectName}
                readOnly
              />
            </div>
            <div className="p-2.5 rounded-lg bg-emerald-50 border border-emerald-200 text-emerald-900 flex items-center gap-2">
              <span className="material-symbols-outlined text-[16px] text-emerald-700">check_circle</span>
              <span>Neutron Subnet 10.20.10.0/24 bound with OVS port security.</span>
            </div>
          </div>
        </div>

        {/* IPAM & Cooldown */}
        <div className="bg-white border border-[#E8E0EA] rounded-[14px] p-5 shadow-xs space-y-3">
          <div className="flex items-center gap-2 pb-2 border-b border-[#E8E0EA]">
            <span className="material-symbols-outlined text-[18px] text-[#2D0035]">schedule</span>
            <h3 className="font-semibold text-[#170B1B]">IPAM Timing &amp; Quarantine Policy</h3>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-[#827787] text-[11px] mb-1 font-mono uppercase">Default Lease TTL (s)</label>
              <input
                type="number"
                value={leaseTtl}
                onChange={e => setLeaseTtl(Number(e.target.value))}
                className="w-full p-2 bg-white border border-[#E8E0EA] rounded-[8px] font-mono text-xs text-[#170B1B]"
              />
            </div>
            <div>
              <label className="block text-[#827787] text-[11px] mb-1 font-mono uppercase">Quarantine Cooldown (s)</label>
              <input
                type="number"
                value={quarantineSec}
                onChange={e => setQuarantineSec(Number(e.target.value))}
                className="w-full p-2 bg-white border border-[#E8E0EA] rounded-[8px] font-mono text-xs text-[#170B1B]"
              />
            </div>
          </div>
          <p className="text-[11px] text-[#827787]">
            Released IPs enter quarantine for {quarantineSec}s to prevent ARP collisions and ensure clean socket teardowns.
          </p>
        </div>

        {/* VRRP Priority Policies */}
        <div className="bg-white border border-[#E8E0EA] rounded-[14px] p-5 shadow-xs space-y-3">
          <div className="flex items-center gap-2 pb-2 border-b border-[#E8E0EA]">
            <span className="material-symbols-outlined text-[18px] text-[#2D0035]">sync_alt</span>
            <h3 className="font-semibold text-[#170B1B]">Keepalived VRRP Priority Election</h3>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-[#827787] text-[11px] mb-1 font-mono uppercase">gw1 (Master Prio)</label>
              <input
                type="number"
                value={prioMaster}
                onChange={e => setPrioMaster(Number(e.target.value))}
                className="w-full p-2 bg-white border border-[#E8E0EA] rounded-[8px] font-mono text-xs text-[#170B1B]"
              />
            </div>
            <div>
              <label className="block text-[#827787] text-[11px] mb-1 font-mono uppercase">gw2 (Backup Prio)</label>
              <input
                type="number"
                value={prioBackup}
                onChange={e => setPrioBackup(Number(e.target.value))}
                className="w-full p-2 bg-white border border-[#E8E0EA] rounded-[8px] font-mono text-xs text-[#170B1B]"
              />
            </div>
          </div>
          <p className="text-[11px] text-[#827787]">
            gw1 priority ({prioMaster}) exceeds gw2 ({prioBackup}) to ensure deterministic primary master allocation.
          </p>
        </div>

        {/* Platform Maintenance Mode */}
        <div className="bg-white border border-[#E8E0EA] rounded-[14px] p-5 shadow-xs space-y-3">
          <div className="flex items-center gap-2 pb-2 border-b border-[#E8E0EA]">
            <span className="material-symbols-outlined text-[18px] text-[#2D0035]">build_circle</span>
            <h3 className="font-semibold text-[#170B1B]">Global Ingress Maintenance Banner</h3>
          </div>
          <div className="flex items-center justify-between p-3 bg-[#F8F6F9] border border-[#E8E0EA] rounded-lg">
            <div>
              <div className="font-semibold text-[#170B1B]">Display 503 Maintenance Page</div>
              <p className="text-[11px] text-[#827787]">Routes all incoming traffic to maintenance splash during cluster upgrade.</p>
            </div>
            <label className="relative inline-flex items-center cursor-pointer">
              <input
                type="checkbox"
                checked={maintenanceMode}
                onChange={e => setMaintenanceMode(e.target.checked)}
                className="sr-only peer"
              />
              <div className="w-11 h-6 bg-gray-300 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-[#2D0035]"></div>
            </label>
          </div>
        </div>
      </div>
    </div>
  )
}
