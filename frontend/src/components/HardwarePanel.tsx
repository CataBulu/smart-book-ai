import { useEffect, useState } from 'react'
import { Cpu, Gauge } from 'lucide-react'
import { api } from '../api.ts'
import type { HardwareStatus } from '../types.ts'

function Meter({ label, used, total, unit }: { label: string; used: number; total: number; unit: string }) {
  const pct = total ? Math.min(100, Math.round((used / total) * 100)) : 0
  return (
    <div className="meter">
      <div className="meter-row"><span>{label}</span><b>{used.toFixed(1)} / {total.toFixed(1)} {unit}</b></div>
      <div className="meter-bar" role="progressbar" aria-label={label} aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}>
        <i style={{ width: `${pct}%` }} className={pct > 88 ? 'hot' : ''} />
      </div>
    </div>
  )
}

/** Live view of where each model runs, polled while the settings popover is open. */
export function HardwarePanel({ onError }: { onError: (m: string) => void }) {
  const [hw, setHw] = useState<HardwareStatus | null>(null)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    let alive = true
    const load = () => api.hardware().then((h) => alive && setHw(h)).catch(() => {})
    void load()
    const t = setInterval(load, 3000)
    return () => { alive = false; clearInterval(t) }
  }, [])

  if (!hw) return <div className="setting"><span>Hardware</span><small>Checking your PC…</small></div>

  const chat = hw.ollama[0]
  const choose = async (images: 'gpu' | 'cpu') => {
    setSaving(true)
    try { setHw(await api.setImageDevice(images)) } catch (e) { onError((e as Error).message) } finally { setSaving(false) }
  }

  return (
    <div className="setting hardware">
      <span><Gauge size={13} /> Hardware</span>
      {hw.gpu ? (
        <>
          <small className="gpu-name">{hw.gpu.name} · {hw.gpu.util_pct}% busy</small>
          <Meter label="Graphics memory" used={hw.gpu.used_mb / 1024} total={hw.gpu.total_mb / 1024} unit="GB" />
        </>
      ) : <small><Cpu size={12} /> No NVIDIA graphics card found — everything runs on the CPU.</small>}
      <Meter label="System memory" used={hw.ram.used_gb} total={hw.ram.total_gb} unit="GB" />
      <ul className="placement">
        <li>Chat model <b>{chat ? `${chat.gpu_pct}% on graphics card` : 'not loaded yet'}</b></li>
        <li>Search &amp; voice <b>CPU</b></li>
      </ul>
      <div className="setting-sub">
        <span>Paint images on</span>
        <div className="segmented">
          <button aria-pressed={hw.images.setting === 'gpu'} disabled={saving || !hw.images.gpu_available}
                  onClick={() => void choose('gpu')}>Graphics card</button>
          <button aria-pressed={hw.images.setting === 'cpu'} disabled={saving} onClick={() => void choose('cpu')}>CPU</button>
        </div>
        <small>
          {hw.images.running_on === 'gpu'
            ? 'About 4 s per image. The chat model steps aside while it paints.'
            : 'About 20 s per image and ~6 GB of memory while painting.'}
        </small>
      </div>
    </div>
  )
}
