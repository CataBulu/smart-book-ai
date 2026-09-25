import { useEffect, useState } from 'react'
import { AlertCircle, CheckCircle2, Loader2 } from 'lucide-react'
import { api } from '../api.ts'
import type { JobStatus } from '../types.ts'

export interface TrackedJob {
  id: string
  label: string
  state: 'running' | 'done' | 'failed'
  startedAt: number
}

const STAGE: Record<JobStatus['stage'], string> = {
  starting: 'Starting…',
  reading: 'Reading pages',
  indexing: 'Indexing for search',
  done: 'Done',
  failed: 'Stopped',
}

function duration(s: number): string {
  if (s < 60) return `${Math.max(1, Math.round(s))} s`
  const m = Math.floor(s / 60)
  return `${m} min${s % 60 >= 30 && m < 10 ? ' 30 s' : ''}`
}

function JobRow({ job }: { job: TrackedJob }) {
  const [status, setStatus] = useState<JobStatus | null>(null)
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    if (job.state !== 'running') return
    let alive = true
    const poll = async () => {
      try { const s = await api.job(job.id); if (alive) setStatus(s) } catch { /* not registered yet */ }
      if (alive) setNow(Date.now())
    }
    void poll()
    const t = setInterval(poll, 700)
    return () => { alive = false; clearInterval(t) }
  }, [job.id, job.state])

  const done = job.state === 'done'
  const failed = job.state === 'failed'
  const pct = done ? 100 : status?.percent ?? 0
  const unit = status?.stage === 'reading' ? 'pages' : /\d+ books$/.test(job.label) ? 'books' : 'passages'
  const detail = done ? 'Finished'
    : failed ? 'Something went wrong — see the message in the app'
    : status && status.total > 0
      ? `${status.done.toLocaleString()} of ${status.total.toLocaleString()} ${unit}${status.eta_s !== null ? ` · about ${duration(status.eta_s)} left` : ''}`
      : `Working… ${duration((now - job.startedAt) / 1000)}`

  return (
    <div className={`job ${job.state}`} role="status" aria-label={job.label} data-testid="job">
      <div className="job-head">
        {done ? <CheckCircle2 size={16} /> : failed ? <AlertCircle size={16} /> : <Loader2 size={16} className="spin" />}
        <b title={job.label}>{job.label}</b>
        <span className="job-pct" data-testid="job-percent">{Math.round(pct)}%</span>
      </div>
      <div className="job-bar"><i style={{ width: `${pct}%` }} /></div>
      <div className="job-detail">
        <span>{done || failed ? '' : STAGE[status?.stage ?? 'starting']}</span>
        <span>{detail}</span>
      </div>
    </div>
  )
}

/** Small window in the corner with a live percentage for imports and indexing. */
export function ProgressWindow({ jobs }: { jobs: TrackedJob[] }) {
  if (!jobs.length) return null
  return <div className="jobs" aria-live="polite">{jobs.map((j) => <JobRow key={j.id} job={j} />)}</div>
}
