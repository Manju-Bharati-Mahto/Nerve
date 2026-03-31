import { useState } from 'react'
import { useAppData } from '@/hooks/useAppData'
import type { Entry } from '@/lib/app-types'
import { Download } from 'lucide-react'

export default function ExportPage() {
  const { entries } = useAppData()
  const [loading, setLoading] = useState(false)

  function exportData(format: 'json' | 'csv') {
    setLoading(true)
    let content: string
    let mimeType: string

    if (format === 'json') {
      content = JSON.stringify(entries, null, 2)
      mimeType = 'application/json'
    } else {
      const headers: Array<keyof Pick<Entry, 'id' | 'dept' | 'type' | 'title' | 'body' | 'entry_date' | 'priority' | 'author_name' | 'academic_year' | 'student_count' | 'external_link' | 'collaborating_org' | 'created_at'>> = ['id', 'dept', 'type', 'title', 'body', 'entry_date', 'priority', 'author_name', 'academic_year', 'student_count', 'external_link', 'collaborating_org', 'created_at']
      const rows = entries.map(e => headers.map(h => {
        const val = e[h]
        return typeof val === 'string' ? `"${val.replace(/"/g, '""')}"` : val ?? ''
      }).join(','))
      content = [headers.join(','), ...rows].join('\n')
      mimeType = 'text/csv'
    }

    const blob = new Blob([content], { type: mimeType })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `parul-hub-${new Date().toISOString().slice(0, 10)}.${format}`
    a.click()
    URL.revokeObjectURL(url)
    setLoading(false)
  }

  return (
    <div className="animate-fade-in">
      <div className="mb-6">
        <h1 className="text-2xl font-serif text-foreground">Export data</h1>
        <p className="text-sm text-muted-foreground mt-1">Download all knowledge base entries</p>
      </div>

      <div className="grid grid-cols-2 gap-6">
        <div className="hub-card">
          <h2 className="font-semibold text-foreground mb-1">Export as JSON</h2>
          <p className="text-sm text-muted-foreground mb-4">Full data including all fields and metadata. Best for backup.</p>
          <button className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-primary text-primary-foreground text-sm font-medium hover:bg-brand-dark transition-colors disabled:opacity-50"
            onClick={() => exportData('json')} disabled={loading}>
            <Download className="w-4 h-4" /> Download JSON
          </button>
        </div>
        <div className="hub-card">
          <h2 className="font-semibold text-foreground mb-1">Export as CSV</h2>
          <p className="text-sm text-muted-foreground mb-4">Open directly in Excel or Google Sheets.</p>
          <button className="inline-flex items-center gap-2 px-4 py-2 rounded-lg border border-border text-sm font-medium text-foreground hover:bg-accent transition-colors disabled:opacity-50"
            onClick={() => exportData('csv')} disabled={loading}>
            <Download className="w-4 h-4" /> Download CSV
          </button>
        </div>
      </div>
    </div>
  )
}
