import { useEffect, useMemo, useRef, useState } from 'react'
import {
  Chart as ChartJS,
  ArcElement,
  Tooltip,
  Legend,
  CategoryScale,
  LinearScale,
  PointElement,
  LineElement,
  Filler,
  TimeScale,
} from 'chart.js'
import { Pie, Line } from 'react-chartjs-2'

ChartJS.register(ArcElement, Tooltip, Legend, CategoryScale, LinearScale, PointElement, LineElement, Filler, TimeScale)

function useApi<T>(path: string, deps: any[] = [], token?: string) {
  const [data, setData] = useState<T | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    const headers: Record<string, string> = {}
    if (token && token.trim()) headers['Authorization'] = 'Bearer ' + token.trim()
    fetch(path, { headers })
      .then(async (r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`)
        const json = await r.json()
        if (!cancelled) setData(json)
      })
      .catch((e) => !cancelled && setError(String(e)))
      .finally(() => !cancelled && setLoading(false))
    return () => {
      cancelled = true
    }
  }, [...deps, token])

  return { data, loading, error }
}

type Summary = { month: string; totalExpense: number; totalIncome: number; net: number; count: number; currency?: string; topCategory?: string }
type EntriesResp = { month: string; data: any[] }
type ByCategoryResp = { month: string; data: { category: string; amount: number }[] }
type DailyResp = { month: string; data: { date: string; amount: number }[] }
type WeeklyResp = { scope: any; data: { week: string; amount: number }[] }
type MonthlySeriesResp = { year: number; data: { month: string; amount: number }[] }
type BudgetsProgressResp = { month: string; data: { category: string; capJod: number; spentJod: number; percent: number | null }[] }
  type SuggestionsResp = { data: Array<{ id: number; entryId: number; vendor?: string | null; total?: number | null; currency?: string | null; date?: string | null; method?: string | null; note?: string | null; accepted?: number; applied?: number; rejected?: number; entry?: any }> }
type ForecastResult = { category: string; months: string[]; history: number[]; ok: boolean; method?: string; forecast?: number; ci80?: [number, number]; ci95?: [number, number]; h?: number }
type ForecastResp = { unit: string; h: number; results: ForecastResult[] }
type AnomalyItem = { category: string; month: string; actual: number; expected: number; z?: number | null; method: string; note?: string }
type AnomaliesResp = { unit: string; anomalies: AnomalyItem[] }
// FX breakdown temporarily disabled per request
// Chat dropdown removed per request (keep type placeholder for future use if needed)

export default function App() {
  // Filters
  const [month, setMonth] = useState<string>(() => new Date().toISOString().slice(0,7))
  const [category, setCategory] = useState<string>(() => localStorage.getItem('dash_cat') || '')
  const [seriesMode, setSeriesMode] = useState<'daily'|'weekly'|'monthly'>('daily')
  const [exportOpen, setExportOpen] = useState(false)
  const [rangeStart, setRangeStart] = useState<string>('')
  const [rangeEnd, setRangeEnd] = useState<string>('')
  const [catOpen, setCatOpen] = useState(false)
  const [catHover, setCatHover] = useState(-1)
  const catWrapRef = useRef<HTMLDivElement | null>(null)

  // Auth token handling: allow ?token= and persist in localStorage
  const [token, setToken] = useState<string>(() => {
    const sp = new URLSearchParams(window.location.search)
    const t = sp.get('token') || localStorage.getItem('dash_token') || ''
    if (t) localStorage.setItem('dash_token', t)
    return t
  })
  useEffect(() => {
    if (token) localStorage.setItem('dash_token', token)
    else localStorage.removeItem('dash_token')
  }, [token])

  const qs = (base: string) => {
    const p = new URLSearchParams()
    p.set('month', month || 'current')
    if (category) p.set('category', category)
    return `${base}?${p.toString()}`
  }

  const { data: summary, loading, error } = useApi<Summary>(qs('/api/summary'), [month], token)
  const { data: entriesResp } = useApi<EntriesResp>(qs('/api/entries') + '&limit=100', [month, category], token)
  const { data: byCat } = useApi<ByCategoryResp>(qs('/api/by-category'), [month], token)
  // Include category so the time series updates when a category is chosen
  const { data: daily } = useApi<DailyResp>(qs('/api/daily'), [month, category], token)
  const { data: weekly } = useApi<WeeklyResp>(qs('/api/weekly'), [month, category], token)
  const monthlyUrl = useMemo(() => {
    const base = `/api/monthly?year=${month.slice(0,4)}`
    return category ? `${base}&category=${encodeURIComponent(category)}` : base
  }, [month, category])
  const { data: monthlySeries } = useApi<MonthlySeriesResp>(monthlyUrl, [month, category], token)
  const { data: budgets } = useApi<BudgetsProgressResp>(qs('/api/budgets/progress'), [month], token)
  const [suggReload, setSuggReload] = useState(0)
  const { data: suggestions } = useApi<SuggestionsResp>('/api/suggestions', [suggReload], token)
  const entries = entriesResp?.data || []

  // Forecast and anomalies
  const forecastUrl = useMemo(() => {
    const p = new URLSearchParams()
    p.set('months', '24')
    p.set('h', '1')
    if (category) p.set('category', category)
    return `/api/forecast?${p.toString()}`
  }, [category])
  const { data: forecast, loading: forecastLoading, error: forecastError } = useApi<ForecastResp>(forecastUrl, [forecastUrl], token)
  const catSynonyms = (c: string) => {
    const codeToName: Record<string,string> = { g:'groceries', f:'food', t:'transport', b:'bills', h:'health', r:'rent', m:'misc', u:'uncategorized' }
    const nameToCode: Record<string,string> = Object.fromEntries(Object.entries(codeToName).map(([k,v])=>[v,k]))
    const lc = (c||'').toLowerCase()
    const out = new Set<string>([lc])
    if (codeToName[lc]) out.add(codeToName[lc])
    if (nameToCode[lc]) out.add(nameToCode[lc])
    return Array.from(out)
  }

  const anomaliesUrl = useMemo(() => {
    const p = new URLSearchParams()
    p.set('months', '24')
    p.set('window', '12')
    p.set('z', '3')
    p.set('category', category || 'all')
    return `/api/anomalies?${p.toString()}`
  }, [category])
  const { data: anomalies } = useApi<AnomaliesResp>(anomaliesUrl, [anomaliesUrl], token)

  // Persist category selection
  useEffect(() => {
    if (category) localStorage.setItem('dash_cat', category)
    else localStorage.removeItem('dash_cat')
  }, [category])

  // Close suggestions on outside click
  useEffect(() => {
    const onDocClick = (e: MouseEvent) => {
      if (!catWrapRef.current) return
      if (!catWrapRef.current.contains(e.target as Node)) setCatOpen(false)
    }
    document.addEventListener('click', onDocClick)
    return () => document.removeEventListener('click', onDocClick)
  }, [])

  // Daily average out (expenses) for the selected month
  const daysInSelectedMonth = useMemo(() => {
    const parts = month.split('-')
    if (parts.length !== 2) return 30
    const y = Number(parts[0])
    const m = Number(parts[1])
    if (!Number.isFinite(y) || !Number.isFinite(m)) return 30
    return new Date(Date.UTC(y, m, 0)).getUTCDate()
  }, [month])
  const avgOutPerDay = useMemo(() => {
    if (!summary) return 0
    const expense = Number(summary.totalExpense || 0)
    return daysInSelectedMonth ? (expense / daysInSelectedMonth) : 0
  }, [summary, daysInSelectedMonth])

  // Category suggestions derived from by-category data
  const allCategories = useMemo(() => {
    const rows = (byCat?.data || [])
    const map = new Map<string, number>()
    for (const r of rows) {
      const name = String(r.category || '').toLowerCase()
      const amt = Number(r.amount) || 0
      map.set(name, Math.max(map.get(name) || 0, amt))
    }
    return Array.from(map.entries()).map(([name, amount]) => ({ name, amount }))
  }, [byCat])

  const filteredCats = useMemo(() => {
    const q = (category || '').trim().toLowerCase()
    const base = allCategories.slice().sort((a,b) => b.amount - a.amount)
    if (!q) return base.slice(0, 20)
    return base.filter(c => c.name.includes(q)).slice(0, 20)
  }, [allCategories, category])

  // Removed quick chips per request

  const totalAbs = useMemo(() => {
    if (!summary) return 0
    return Math.abs(summary.totalExpense || 0) + Math.abs(summary.totalIncome || 0)
  }, [summary])

  // Helper: category display: prefer code mapping when code is a known letter; else first word of description
  const codeToName: Record<string,string> = { g:'groceries', f:'food', t:'transport', b:'bills', h:'health', r:'rent', m:'misc', u:'uncategorized' }
  const displayCategory = (e: any) => {
    const code = String(e?.code || '').toLowerCase()
    if (codeToName[code]) return codeToName[code]
    const s = String(e?.description || '').trim()
    if (!s) return 'uncategorized'
    return s.split(/\s+/)[0].toLowerCase()
  }

  // Suggestions actions
  const applySuggestion = async (id: number) => {
    try {
      const r = await fetch(`/api/suggestions/${id}/apply`, { method: 'POST', headers: token ? { 'Authorization': 'Bearer ' + token } : {} })
      if (!r.ok) throw new Error(`HTTP ${r.status}`)
      setSuggReload(x=>x+1)
    } catch (_) {}
  }
  const rejectSuggestion = async (id: number) => {
    try {
      const r = await fetch(`/api/suggestions/${id}/reject`, { method: 'POST', headers: token ? { 'Authorization': 'Bearer ' + token } : {} })
      if (!r.ok) throw new Error(`HTTP ${r.status}`)
      setSuggReload(x=>x+1)
    } catch (_) {}
  }

  // Authenticated download helper (respects Content-Disposition filename)
  async function downloadAuth(url: string) {
    try {
      const r = await fetch(url, { headers: token ? { 'Authorization': 'Bearer ' + token } : {} })
      if (!r.ok) throw new Error(`HTTP ${r.status}`)
      const blob = await r.blob()
      let filename = 'download'
      const disp = r.headers.get('Content-Disposition') || ''
      const m = /filename\*=UTF-8''([^;]+)|filename=\"?([^\";]+)\"?/i.exec(disp)
      if (m) filename = decodeURIComponent(m[1] || m[2])
      const a = document.createElement('a')
      a.href = URL.createObjectURL(blob)
      a.download = filename
      a.click()
      setTimeout(() => URL.revokeObjectURL(a.href), 1000)
    } catch (e) {
      console.error('download failed', e)
    }
  }

  return (
    <div className="min-h-dvh bg-bg text-text">
      <div className="max-w-6xl mx-auto p-4">
        <header className="sticky top-0 z-10 -mx-4 px-4 py-3 bg-bg/60 backdrop-blur border-b border-border flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
          <h1 className="text-2xl font-semibold">Ledger Dashboard</h1>
          <div className="flex flex-wrap gap-2 items-center">
            <label className="text-sm opacity-70">Month</label>
            <div className="flex items-center gap-1">
              <button className="btn btn-ghost" onClick={() => {
                const d = new Date(month + '-01T00:00:00Z'); d.setUTCMonth(d.getUTCMonth()-1); setMonth(d.toISOString().slice(0,7));
              }}>{'<'}</button>
              <input type="month" value={month} onChange={(e)=>setMonth(e.target.value)} className="bg-card border border-border rounded px-2 py-1" />
              <button className="btn btn-ghost" onClick={() => {
                const d = new Date(month + '-01T00:00:00Z'); d.setUTCMonth(d.getUTCMonth()+1); setMonth(d.toISOString().slice(0,7));
              }}>{'>'}</button>
            </div>
            <label className="text-sm opacity-70">Category</label>
            <div className="relative" ref={catWrapRef}>
              <div className="flex items-center gap-1 bg-card border border-border rounded px-2 py-1">
                <input
                  placeholder="all"
                  value={category}
                  onChange={(e)=>{ setCategory(e.target.value.toLowerCase()); setCatOpen(true); setCatHover(-1) }}
                  onFocus={()=> setCatOpen(true)}
                  onKeyDown={(e)=>{
                    if (!filteredCats.length) return
                    if (e.key==='ArrowDown') { setCatHover(h => Math.min(filteredCats.length-1, h+1)) }
                    if (e.key==='ArrowUp') { setCatHover(h => Math.max(0, h-1)) }
                    if (e.key==='Enter') {
                      const pick = catHover>=0? filteredCats[catHover]?.name : filteredCats[0]?.name
                      if (pick) { setCategory(pick); setCatOpen(false) }
                    }
                    if (e.key==='Escape') setCatOpen(false)
                  }}
                  className="bg-transparent outline-none flex-1"
                  style={{ minWidth: 160 }}
                />
                {category && (
                  <button className="text-sm opacity-70 hover:opacity-100" onClick={()=>setCategory('')} title="Clear">×</button>
                )}
              </div>
              {catOpen && (
                <div className="absolute z-20 mt-1 w-[240px] max-h-64 overflow-auto card p-1">
                  <button className="w-full text-left px-2 py-1 rounded hover:bg-white/5" onClick={()=>{ setCategory(''); setCatOpen(false) }}>All</button>
                  <button className="w-full text-left px-2 py-1 rounded hover:bg-white/5" onClick={()=>{ setCategory('uncategorized'); setCatOpen(false) }}>Uncategorized</button>
                  <div className="h-px bg-border my-1" />
                  {filteredCats.map((c, i) => (
                    <button
                      key={c.name}
                      className={`w-full text-left px-2 py-1 rounded hover:bg-white/5 ${i===catHover? 'bg-white/5' : ''}`}
                      onMouseEnter={()=>setCatHover(i)}
                      onClick={()=>{ setCategory(c.name); setCatOpen(false) }}
                    >
                      <span className="capitalize">{c.name}</span>
                      <span className="opacity-60 ml-2 text-xs">{Math.round(c.amount)}</span>
                    </button>
                  ))}
                  {!filteredCats.length && (
                    <div className="px-2 py-1 opacity-60 text-sm">No matches</div>
                  )}
                </div>
              )}
            </div>
            <button className={`btn ${category==='uncategorized'?'btn-accent':''}`} onClick={() => setCategory(category==='uncategorized' ? '' : 'uncategorized')}>Uncategorized</button>
            <div className="relative">
              <button className="btn btn-accent" onClick={()=>setExportOpen(v=>!v)}>Export ▾</button>
              {exportOpen && (
                <div className="absolute right-0 mt-2 w-64 card p-3 z-20">
                  <div className="text-sm font-medium mb-2">Current month</div>
                  <div className="flex gap-2">
                    <button className="btn flex-1" onClick={() => { downloadAuth(qs('/api/export') + '&format=csv') }}>CSV</button>
                    <button className="btn flex-1" onClick={() => { downloadAuth(qs('/api/export') + '&format=xlsx') }}>XLSX</button>
                  </div>
                  <div className="h-px bg-border my-3" />
                  <div className="text-sm font-medium mb-2">This year</div>
                  <button className="btn w-full" onClick={() => {
                    const y = month.slice(0,4);
                    const cat = category?`&category=${encodeURIComponent(category)}`:'';
                    downloadAuth(`/api/export?start=${y}-01&end=${y}-12${cat}&format=xlsx`)
                  }}>Download XLSX</button>
                  <div className="h-px bg-border my-3" />
                  <div className="text-sm font-medium mb-2">Custom range</div>
                  <div className="flex items-center gap-2">
                    <input type="month" value={rangeStart} onChange={e=>setRangeStart(e.target.value)} className="bg-card border border-border rounded px-2 py-1 flex-1" />
                    <span className="opacity-70">to</span>
                    <input type="month" value={rangeEnd} onChange={e=>setRangeEnd(e.target.value)} className="bg-card border border-border rounded px-2 py-1 flex-1" />
                  </div>
                  <button disabled={!rangeStart||!rangeEnd} className="btn w-full mt-2 disabled:opacity-50" onClick={() => {
                    const cat = category?`&category=${encodeURIComponent(category)}`:'';
                    downloadAuth(`/api/export?start=${rangeStart}&end=${rangeEnd}${cat}&format=xlsx`)
                  }}>Download XLSX</button>
                </div>
              )}
            </div>
            <div className="flex items-center gap-2 ml-auto">
              <input
                placeholder="Bearer token"
                value={token}
                onChange={(e)=>setToken(e.target.value)}
                className="bg-card border border-border rounded px-2 py-1"
                style={{ minWidth: 220 }}
              />
              <div className="text-sm opacity-70 min-w-16 text-right">{loading ? 'Loading…' : error ? 'Error' : 'Ready'}</div>
            </div>
          </div>
        </header>

        <section className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-3 mt-4">
          <div className="card p-4">
            <div className="text-sm opacity-70">Total</div>
            <div className="text-2xl font-bold">{totalAbs.toFixed(2)}</div>
          </div>
          <div className="card p-4">
            <div className="text-sm opacity-70">Out</div>
            <div className="text-2xl font-bold">{summary ? Number(summary.totalExpense || 0).toFixed(2) : '—'}</div>
          </div>
          <div className="card p-4">
            <div className="text-sm opacity-70">In</div>
            <div className="text-2xl font-bold">{summary ? Number(summary.totalIncome || 0).toFixed(2) : '—'}</div>
          </div>
          <div className="card p-4">
            <div className="text-sm opacity-70">Count</div>
            <div className="text-2xl font-bold">{summary?.count ?? '—'}</div>
          </div>
          <div className="card p-4">
            <div className="text-sm opacity-70">Avg Out/Day</div>
            <div className="text-2xl font-bold">{avgOutPerDay.toFixed(2)}</div>
          </div>
        </section>

        <section className="grid grid-cols-1 lg:grid-cols-2 gap-3 mt-6">
          <div className="card p-4">
            <h3 className="font-semibold mb-3">By Category</h3>
            <div className="h-72">
              <Pie data={{
                labels: (byCat?.data || []).map(x=>x.category),
                datasets: [{
                  data: (byCat?.data || []).map(x=>x.amount),
                  backgroundColor: ['#6bd5ff','#f472b6','#a78bfa','#34d399','#fbbf24','#60a5fa','#fb7185','#22d3ee','#93c5fd','#fca5a5'],
                }]
              }} />
            </div>
          </div>
          <div className="card p-4">
            <div className="flex items-center justify-between mb-3">
              <div className="flex items-center gap-3">
                <h3 className="font-semibold">Time Series</h3>
                {(() => {
                  const catKey = (category||'').toLowerCase()
                  const fr = (catKey && forecast?.results) ? forecast.results.find(r => catSynonyms(catKey).includes(String(r.category||'').toLowerCase())) : undefined
                  if (catKey && fr && fr.ok && typeof fr.forecast === 'number') {
                    return <span className="text-xs px-2 py-1 bg-white/5 rounded">Forecast: {Math.round(fr.forecast)} JOD</span>
                  }
                  return null
                })()}
                {(() => {
                  // Minimal debug hint to explain why the forecast dot/badge might not show
                  const catKey = (category||'').toLowerCase()
                  if (!catKey) return null
                  if (forecastLoading) return <span className="text-xs opacity-60">forecast: loading…</span>
                  if (forecastError) return <span className="text-xs opacity-60">forecast: error</span>
                  if (!forecast || !Array.isArray(forecast.results)) return <span className="text-xs opacity-60">forecast: no data</span>
                  const fr = forecast.results.find(r => catSynonyms(catKey).includes(String(r.category||'').toLowerCase()))
                  if (!fr) {
                    const got = forecast.results.map(r => r.category).slice(0,6).join(', ')
                    return <span className="text-xs opacity-60">forecast: no match for “{catKey}”{got?` (got: ${got}…)`:''}</span>
                  }
                  if (fr.ok && typeof fr.forecast === 'number') return null // the main badge already shows
                  if (fr.ok && typeof fr.forecast !== 'number') return <span className="text-xs opacity-60">forecast: ok, value missing</span>
                  return <span className="text-xs opacity-60">forecast: {String((fr as any).reason || 'unavailable')}</span>
                })()}
              </div>
              <div className="flex gap-1">
                <button className={`btn ${seriesMode==='daily'?'btn-accent':''}`} onClick={()=>setSeriesMode('daily')}>Daily</button>
                <button className={`btn ${seriesMode==='weekly'?'btn-accent':''}`} onClick={()=>setSeriesMode('weekly')}>Weekly</button>
                <button className={`btn ${seriesMode==='monthly'?'btn-accent':''}`} onClick={()=>setSeriesMode('monthly')}>Monthly</button>
              </div>
            </div>
            <div className="h-72">
              {seriesMode==='daily' && (
                <Line data={{
                  labels: (daily?.data || []).map(x=>x.date.slice(5)),
                  datasets: [{ label: `Spend${category?` – ${category}`:''}` , data: (daily?.data || []).map(x=>x.amount), fill: true, backgroundColor: 'rgba(107, 213, 255, 0.2)', borderColor: '#6bd5ff' }]
                }} options={{ scales: { y: { beginAtZero: true } } }} />
              )}
              {seriesMode==='weekly' && (
                <Line data={{
                  labels: (weekly?.data || []).map(x=>x.week.slice(-2)),
                  datasets: [{ label: `Spend${category?` – ${category}`:''}`, data: (weekly?.data || []).map(x=>x.amount), fill: true, backgroundColor: 'rgba(125, 211, 252, 0.2)', borderColor: '#7dd3fc' }]
                }} options={{ scales: { y: { beginAtZero: true } } }} />
              )}
              {seriesMode==='monthly' && (
                (() => {
                  const ms = monthlySeries?.data || []
                  const baseLabels = ms.map(x=>x.month)
                  const labels = baseLabels.map(x=>x.slice(5))
                  const history = ms.map(x=>x.amount)
                  let labelsPlus = labels
                  let forecastData: (number|null)[] | null = null
                  let forecastLabel = ''
                  const catKey = (category||'').toLowerCase()
                  const fr = (catKey && forecast?.results) ? forecast.results.find(r => catSynonyms(catKey).includes(String(r.category||'').toLowerCase())) : undefined
                  if (catKey && fr && fr.ok && typeof fr.forecast === 'number') {
                    // append next month based on the currently selected month in the header
                    const sel = month && /^\d{4}-\d{2}$/.test(month) ? month : baseLabels[baseLabels.length-1]
                    if (sel) {
                      const y = Number(sel.slice(0,4))
                      const m = Number(sel.slice(5))
                      const nextY = m===12 ? y+1 : y
                      const nextM = m===12 ? 1 : (m+1)
                      forecastLabel = `${nextY}-${String(nextM).padStart(2,'0')}`
                      labelsPlus = labels.concat(forecastLabel.slice(5))
                      forecastData = new Array(labelsPlus.length).fill(null)
                      forecastData[labelsPlus.length-1] = fr.forecast
                    }
                  }
                  const datasets: any[] = [
                    { label: `Spend${category?` – ${category}`:''}`, data: history, fill: true, backgroundColor: 'rgba(251, 191, 36, 0.2)', borderColor: '#fbbf24' }
                  ]
                  if (forecastData) {
                    datasets.push({ label: 'Forecast (next month)', data: forecastData, fill: false, borderColor: '#ef4444', pointBackgroundColor: '#ef4444', borderDash: [6,4], pointRadius: 6, pointHoverRadius: 8, showLine: false })
                  }
                  return <Line
                    data={{ labels: labelsPlus, datasets }}
                    options={{
                      scales: { y: { beginAtZero: true } },
                      plugins: {
                        tooltip: {
                          callbacks: {
                            title: (ctx: any) => {
                              const i = ctx?.[0]?.dataIndex ?? 0
                              // If this is the appended forecast point, show a clearer title
                              if (forecastData && i === labelsPlus.length - 1 && forecastLabel) {
                                return `Next month (${forecastLabel})`
                              }
                              // Otherwise show full YYYY-MM if available
                              return baseLabels[i] || labelsPlus[i]
                            }
                          }
                        }
                      }
                    }}
                  />
                })()
              )}
            </div>
          </div>
        </section>

        {false && (
          <section className="mt-6">
            <div className="card p-4">
              <h3 className="font-semibold mb-3">FX Breakdown</h3>
              <div className="h-64">(hidden)</div>
            </div>
          </section>
        )}

        <section className="mt-6">
          {anomalies && anomalies.anomalies && anomalies.anomalies.length > 0 ? (
            <div className="card p-4 mb-4">
              <div className="flex items-center justify-between mb-2">
                <h2 className="text-lg font-semibold">Anomalies</h2>
                <div className="text-sm opacity-70">Last 24 months</div>
              </div>
              <div className="overflow-x-auto">
                <table className="min-w-[640px] w-full text-sm">
                  <thead className="bg-white/5">
                    <tr>
                      <th className="text-left p-2">Month</th>
                      <th className="text-left p-2">Category</th>
                      <th className="text-right p-2">Actual (JOD)</th>
                      <th className="text-right p-2">Expected</th>
                      <th className="text-left p-2">Method</th>
                    </tr>
                  </thead>
                  <tbody>
                    {anomalies.anomalies.slice(0, 12).map((a, i) => (
                      <tr key={i} className="odd:bg-white/5">
                        <td className="p-2">{a.month}</td>
                        <td className="p-2 capitalize">{a.category}</td>
                        <td className="p-2 text-right">{Number(a.actual).toFixed(2)}</td>
                        <td className="p-2 text-right">{Number(a.expected).toFixed(2)}</td>
                        <td className="p-2">{a.method}{a.note?` – ${a.note}`:''}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          ) : (
            <div className="card p-4 mb-4">
              <h2 className="text-lg font-semibold mb-1">Anomalies</h2>
              <div className="text-sm opacity-70">No anomalies detected in the last 24 months.</div>
            </div>
          )}
          <h2 className="text-xl font-semibold mb-3">Recent Entries</h2>
          <div className="overflow-x-auto card">
            <table className="min-w-[640px] w-full text-sm">
              <thead className="bg-white/5">
                <tr>
                  <th className="text-left p-2">Date</th>
                  <th className="text-left p-2">Description</th>
                  <th className="text-right p-2">Amount</th>
                  <th className="text-left p-2">Category</th>
                </tr>
              </thead>
              <tbody>
                {entries.map((e: any) => (
                  <tr key={e.id} className="odd:bg-white/5">
                    <td className="p-2">{(e.createdAt || e.date || '').slice(0,10)}</td>
                    <td className="p-2">{e.description}</td>
                    <td className="p-2 text-right">{Number(e.amount).toFixed(2)}</td>
                    <td className="p-2 capitalize">{displayCategory(e)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>

        {!!budgets?.data?.length && (
          <section className="mt-6">
            <h2 className="text-xl font-semibold mb-3">Budgets</h2>
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
              {budgets.data.map((b,i)=> (
                <div key={i} className="card p-4">
                  <div className="flex items-center justify-between">
                    <div className="font-medium">{b.category}</div>
                    <div className="text-sm opacity-70">{b.percent ? Math.round(b.percent) + '%' : '—'}</div>
                  </div>
                  <div className="mt-2 h-2 bg-[#0b142a] rounded">
                    <div className="h-full bg-accent rounded" style={{ width: `${Math.min(100, Math.max(0, b.percent || 0))}%` }} />
                  </div>
                  <div className="mt-2 text-sm opacity-70">{b.spentJod.toFixed(2)} / {b.capJod.toFixed(2)} JOD</div>
                </div>
              ))}
            </div>
          </section>
        )}

        {!!suggestions?.data?.length && (
          <section className="mt-6">
            <div className="flex items-center justify-between mb-3">
              <h2 className="text-xl font-semibold">Suggestions</h2>
              <button className="btn" onClick={()=>setSuggReload(x=>x+1)}>Refresh</button>
            </div>
            <div className="overflow-x-auto card">
              <table className="min-w-[800px] w-full text-sm">
                <thead className="bg-white/5">
                  <tr>
                    <th className="text-left p-2">ID</th>
                    <th className="text-left p-2">Entry</th>
                    <th className="text-left p-2">Vendor</th>
                    <th className="text-right p-2">Total</th>
                    <th className="text-left p-2">Currency</th>
                    <th className="text-left p-2">Date</th>
                    <th className="text-left p-2">Attachment</th>
                    <th className="text-left p-2">Method</th>
                    <th className="text-left p-2">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {suggestions.data.map((s) => (
                    <tr key={s.id} className="odd:bg-white/5">
                      <td className="p-2">{s.id}</td>
                      <td className="p-2">#{s.entryId}</td>
                      <td className="p-2">{s.vendor || '—'}</td>
                      <td className="p-2 text-right">{s.total != null ? Number(s.total).toFixed(2) : '—'}</td>
                      <td className="p-2">{s.currency || '—'}</td>
                      <td className="p-2">{s.date || '—'}</td>
                      <td className="p-2">
                        {s.entry?.attachmentUrl ? (
                          <a href={s.entry.attachmentUrl} target="_blank" className="inline-flex items-center gap-2">
                            <img src={s.entry.attachmentUrl} style={{ width: 36, height: 36, objectFit: 'cover', borderRadius: 4 }} />
                            <span className="underline">open</span>
                          </a>
                        ) : '—'}
                      </td>
                      <td className="p-2">{s.method || '—'}</td>
                      <td className="p-2">
                        {s.applied ? (
                          <span className="opacity-70">Applied</span>
                        ) : s.rejected ? (
                          <span className="opacity-70">Rejected</span>
                        ) : (
                          <div className="flex gap-2">
                            <button className="btn btn-accent" onClick={()=>applySuggestion(s.id)}>Apply</button>
                            <button className="btn" onClick={()=>rejectSuggestion(s.id)}>Reject</button>
                          </div>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        )}
      </div>
    </div>
  )
}
