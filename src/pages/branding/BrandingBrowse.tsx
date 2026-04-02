import { useCallback, useEffect, useRef, useState } from 'react'
import { useAuth } from '@/hooks/useAuth'
import { useAppData } from '@/hooks/useAppData'
import { brandingApi } from '@/lib/branding-api'
import type { BrandingDesign, DesignVoter } from '@/lib/branding-types'
import {
  Search, Upload, X, Tag, User, Calendar, Layers,
  Trash2, ZoomIn, ChevronLeft, ChevronRight, Filter,
  ThumbsUp, ThumbsDown, Clock,
} from 'lucide-react'

// ── Time helpers ───────────────────────────────────────────────────────────

const ONE_HOUR_MS = 60 * 60 * 1000

function msUntilExpiry(createdAt: string): number {
  return ONE_HOUR_MS - (Date.now() - new Date(createdAt).getTime())
}

function formatCountdown(ms: number): string {
  if (ms <= 0) return '0:00'
  const totalSecs = Math.floor(ms / 1000)
  const mins = Math.floor(totalSecs / 60)
  const secs = totalSecs % 60
  return `${mins}:${secs.toString().padStart(2, '0')}`
}

// ── Vote buttons (shared between card and lightbox) ────────────────────────

interface VoteBarProps {
  design: BrandingDesign
  onVote: (id: string, type: 'up' | 'down' | null) => void
  size?: 'sm' | 'md'
}

function VoteBar({ design, onVote, size = 'sm' }: VoteBarProps) {
  const iconCls = size === 'md' ? 'w-4 h-4' : 'w-3.5 h-3.5'
  const btnBase = size === 'md'
    ? 'flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm font-medium transition-colors'
    : 'flex items-center gap-1 px-2 py-1 rounded-md text-xs font-medium transition-colors'

  function toggle(type: 'up' | 'down') {
    onVote(design.id, design.user_vote === type ? null : type)
  }

  return (
    <div className="flex items-center gap-1.5">
      <button
        onClick={e => { e.stopPropagation(); toggle('up') }}
        className={`${btnBase} ${
          design.user_vote === 'up'
            ? 'bg-green-100 text-green-700'
            : 'bg-black/20 text-white hover:bg-black/30'
        }`}
        title="Upvote"
      >
        <ThumbsUp className={iconCls} />
        <span>{design.upvotes}</span>
      </button>
      <button
        onClick={e => { e.stopPropagation(); toggle('down') }}
        className={`${btnBase} ${
          design.user_vote === 'down'
            ? 'bg-red-100 text-red-700'
            : 'bg-black/20 text-white hover:bg-black/30'
        }`}
        title="Downvote"
      >
        <ThumbsDown className={iconCls} />
        <span>{design.downvotes}</span>
      </button>
    </div>
  )
}

// lightbox variant with light background buttons
function VoteBarLight({ design, onVote }: { design: BrandingDesign; onVote: (id: string, t: 'up' | 'down' | null) => void }) {
  function toggle(type: 'up' | 'down') {
    onVote(design.id, design.user_vote === type ? null : type)
  }
  return (
    <div className="flex items-center gap-2">
      <button
        onClick={() => toggle('up')}
        className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm font-medium border transition-colors ${
          design.user_vote === 'up'
            ? 'bg-green-100 text-green-700 border-green-300'
            : 'border-border text-muted-foreground hover:bg-accent'
        }`}
      >
        <ThumbsUp className="w-4 h-4" />
        {design.upvotes}
      </button>
      <button
        onClick={() => toggle('down')}
        className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm font-medium border transition-colors ${
          design.user_vote === 'down'
            ? 'bg-red-100 text-red-700 border-red-300'
            : 'border-border text-muted-foreground hover:bg-accent'
        }`}
      >
        <ThumbsDown className="w-4 h-4" />
        {design.downvotes}
      </button>
    </div>
  )
}

// ── Upload Dialog ──────────────────────────────────────────────────────────

interface UploadDialogProps {
  categories: string[]
  onUploaded: (design: BrandingDesign) => void
  onClose: () => void
}

function UploadDialog({ categories, onUploaded, onClose }: UploadDialogProps) {
  const [file, setFile] = useState<File | null>(null)
  const [preview, setPreview] = useState<string>('')
  const [title, setTitle] = useState('')
  const [description, setDescription] = useState('')
  const [category, setCategory] = useState('')
  const [customCategory, setCustomCategory] = useState('')
  const [tagsInput, setTagsInput] = useState('')
  const [uploading, setUploading] = useState(false)
  const [err, setErr] = useState('')
  const fileRef = useRef<HTMLInputElement>(null)

  function onFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0]
    if (!f) return
    setFile(f)
    setPreview(URL.createObjectURL(f))
    if (!title) setTitle(f.name.replace(/\.[^.]+$/, '').replace(/[-_]/g, ' '))
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!file) { setErr('Please select an image.'); return }
    if (!title.trim()) { setErr('Title is required.'); return }
    setUploading(true); setErr('')
    try {
      const fd = new FormData()
      fd.append('image', file)
      fd.append('title', title.trim())
      fd.append('description', description.trim())
      fd.append('category', (category === '__custom__' ? customCategory : category).trim())
      fd.append('tags', tagsInput.split(',').map(t => t.trim()).filter(Boolean).join(','))
      const { design } = await brandingApi.uploadDesign(fd)
      onUploaded(design)
      onClose()
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : 'Upload failed.')
    } finally { setUploading(false) }
  }

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
      <div className="bg-card border border-border rounded-2xl shadow-2xl w-full max-w-lg max-h-[90vh] overflow-y-auto">
        <div className="flex items-center justify-between px-5 py-4 border-b border-border sticky top-0 bg-card rounded-t-2xl">
          <h2 className="text-sm font-semibold text-foreground">Upload Design</h2>
          <button onClick={onClose} className="text-muted-foreground hover:text-foreground"><X className="w-4 h-4" /></button>
        </div>
        <form onSubmit={handleSubmit} className="p-5 space-y-4">
          <div
            onClick={() => fileRef.current?.click()}
            className="relative border-2 border-dashed border-border rounded-xl overflow-hidden cursor-pointer hover:border-pink-400 transition-colors bg-muted/30"
            style={{ minHeight: 180 }}
          >
            {preview
              ? <img src={preview} alt="preview" className="w-full object-contain max-h-64" />
              : <div className="flex flex-col items-center justify-center py-12 gap-2 text-muted-foreground">
                  <Upload className="w-8 h-8" />
                  <span className="text-sm">Click to select an image</span>
                  <span className="text-xs">PNG, JPG, WEBP · max 10 MB</span>
                </div>
            }
            <input ref={fileRef} type="file" accept="image/*" className="hidden" onChange={onFileChange} />
          </div>
          <div>
            <label className="text-xs font-medium text-muted-foreground block mb-1">Title *</label>
            <input className="w-full border border-border rounded-lg px-3 py-2 text-sm bg-background"
              value={title} onChange={e => setTitle(e.target.value)} placeholder="Social media post for Convocation" />
          </div>
          <div>
            <label className="text-xs font-medium text-muted-foreground block mb-1">Description</label>
            <textarea className="w-full border border-border rounded-lg px-3 py-2 text-sm bg-background resize-none"
              rows={2} value={description} onChange={e => setDescription(e.target.value)} placeholder="Brief description…" />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-xs font-medium text-muted-foreground block mb-1">Category</label>
              <select className="w-full border border-border rounded-lg px-3 py-2 text-sm bg-background"
                value={category} onChange={e => setCategory(e.target.value)}>
                <option value="">— None —</option>
                {categories.map(c => <option key={c} value={c}>{c}</option>)}
                <option value="__custom__">Other (type below)</option>
              </select>
            </div>
            {category === '__custom__' && (
              <div>
                <label className="text-xs font-medium text-muted-foreground block mb-1">Custom Category</label>
                <input className="w-full border border-border rounded-lg px-3 py-2 text-sm bg-background"
                  value={customCategory} onChange={e => setCustomCategory(e.target.value)} placeholder="e.g. Merchandise" />
              </div>
            )}
          </div>
          <div>
            <label className="text-xs font-medium text-muted-foreground block mb-1">Tags (comma-separated)</label>
            <input className="w-full border border-border rounded-lg px-3 py-2 text-sm bg-background"
              value={tagsInput} onChange={e => setTagsInput(e.target.value)} placeholder="convocation, social-media, 2024" />
          </div>
          {err && <p className="text-xs text-red-500">{err}</p>}
          <div className="flex gap-2 justify-end pt-1">
            <button type="button" onClick={onClose}
              className="px-4 py-2 text-sm rounded-lg border border-border text-muted-foreground hover:bg-accent">Cancel</button>
            <button type="submit" disabled={uploading}
              className="px-4 py-2 text-sm rounded-lg bg-pink-600 text-white hover:bg-pink-700 disabled:opacity-50 flex items-center gap-2">
              <Upload className="w-3.5 h-3.5" />{uploading ? 'Uploading…' : 'Upload'}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}

// ── Lightbox ───────────────────────────────────────────────────────────────

interface LightboxProps {
  designs: BrandingDesign[]
  index: number
  canDelete: (d: BrandingDesign) => boolean
  isAdminLevel: boolean     // admin/super_admin — no time restriction
  canSeeVoters: boolean
  onDelete: (id: string) => void
  onVote: (id: string, type: 'up' | 'down' | null) => void
  onClose: () => void
  onNavigate: (i: number) => void
}

function Lightbox({ designs, index, canDelete, isAdminLevel, canSeeVoters, onDelete, onVote, onClose, onNavigate }: LightboxProps) {
  const d = designs[index]
  const [voters, setVoters] = useState<DesignVoter[]>([])
  const [votersLoading, setVotersLoading] = useState(false)
  const [showVoters, setShowVoters] = useState(false)
  const [countdown, setCountdown] = useState(0)

  // Reset voters panel and countdown when navigating
  useEffect(() => {
    setShowVoters(false); setVoters([])
    if (d && !isAdminLevel) {
      const remaining = Math.max(0, msUntilExpiry(d.created_at))
      setCountdown(remaining)
    }
  }, [index, d, isAdminLevel])

  useEffect(() => {
    if (isAdminLevel || !d) return
    const tick = setInterval(() => {
      const remaining = Math.max(0, msUntilExpiry(d.created_at))
      setCountdown(remaining)
      if (remaining === 0) clearInterval(tick)
    }, 1000)
    return () => clearInterval(tick)
  }, [index, d, isAdminLevel])

  async function loadVoters() {
    setVotersLoading(true)
    try {
      const { voters: v } = await brandingApi.getVoters(d.id)
      setVoters(v)
      setShowVoters(true)
    } catch { /* ignore */ }
    finally { setVotersLoading(false) }
  }

  if (!d) return null

  return (
    <div className="fixed inset-0 bg-black/80 flex items-center justify-center z-50"
      onClick={onClose}>
      <div className="relative flex items-center gap-3 max-w-5xl w-full mx-4"
        onClick={e => e.stopPropagation()}>

        <button onClick={() => onNavigate(index - 1)} disabled={index === 0}
          className="p-2 rounded-full bg-white/10 text-white hover:bg-white/20 disabled:opacity-20 shrink-0">
          <ChevronLeft className="w-5 h-5" />
        </button>

        <div className="flex-1 bg-card rounded-2xl overflow-hidden shadow-2xl flex flex-col md:flex-row max-h-[85vh]">
          {/* Image */}
          <div className="flex-1 bg-black flex items-center justify-center min-h-64 max-h-[70vh] md:max-h-[85vh] relative">
            <img src={d.image_url} alt={d.title} className="max-w-full max-h-full object-contain" />
            {/* Vote overlay on image bottom */}
            <div className="absolute bottom-3 left-3">
              <VoteBar design={d} onVote={onVote} size="md" />
            </div>
          </div>

          {/* Info panel */}
          <div className="w-full md:w-72 p-5 flex flex-col gap-3 overflow-y-auto border-l border-border">
            <div className="flex items-start justify-between">
              <h2 className="text-base font-semibold text-foreground leading-snug">{d.title}</h2>
              <button onClick={onClose} className="text-muted-foreground hover:text-foreground shrink-0 ml-2">
                <X className="w-4 h-4" />
              </button>
            </div>

            {d.description && (
              <p className="text-sm text-muted-foreground leading-relaxed">{d.description}</p>
            )}

            {/* Vote counts (light version) */}
            <VoteBarLight design={d} onVote={onVote} />

            {/* Owner */}
            <div className="flex items-center gap-2.5 py-2.5 border-t border-border">
              <div className="w-8 h-8 rounded-full bg-pink-100 flex items-center justify-center shrink-0">
                <span className="text-xs font-bold text-pink-600">{(d.uploader_name || 'U')[0].toUpperCase()}</span>
              </div>
              <div>
                <p className="text-sm font-medium text-foreground">{d.uploader_name}</p>
                <p className="text-xs text-muted-foreground">Designer</p>
              </div>
            </div>

            <div className="space-y-1.5 border-t border-border pt-2">
              {d.category && (
                <div className="flex items-center gap-2 text-xs text-muted-foreground">
                  <Layers className="w-3.5 h-3.5 shrink-0" /><span>{d.category}</span>
                </div>
              )}
              <div className="flex items-center gap-2 text-xs text-muted-foreground">
                <Calendar className="w-3.5 h-3.5 shrink-0" />
                <span>{new Date(d.created_at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })}</span>
              </div>
              <div className="flex items-center gap-2 text-xs text-muted-foreground">
                <User className="w-3.5 h-3.5 shrink-0" /><span>Uploaded by {d.uploader_name}</span>
              </div>
            </div>

            {d.tags.length > 0 && (
              <div className="flex flex-wrap gap-1.5 border-t border-border pt-2">
                {d.tags.map(tag => (
                  <span key={tag} className="flex items-center gap-1 text-xs bg-pink-50 text-pink-700 px-2 py-0.5 rounded-full">
                    <Tag className="w-2.5 h-2.5" />{tag}
                  </span>
                ))}
              </div>
            )}

            {/* Admin: voter list */}
            {canSeeVoters && (
              <div className="border-t border-border pt-2">
                {!showVoters ? (
                  <button
                    onClick={loadVoters}
                    disabled={votersLoading}
                    className="text-xs text-pink-600 hover:underline disabled:opacity-50"
                  >
                    {votersLoading ? 'Loading…' : `View voters (${d.upvotes + d.downvotes})`}
                  </button>
                ) : (
                  <div className="space-y-1">
                    <div className="flex items-center justify-between mb-1.5">
                      <p className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">Voters</p>
                      <button onClick={() => setShowVoters(false)} className="text-xs text-muted-foreground hover:text-foreground">Hide</button>
                    </div>
                    {voters.length === 0 && <p className="text-xs text-muted-foreground">No votes yet.</p>}
                    {voters.map(v => (
                      <div key={v.user_id} className="flex items-center justify-between text-xs">
                        <span className="text-foreground truncate">{v.user_name}</span>
                        <span className={`font-medium shrink-0 ml-2 ${v.vote_type === 'up' ? 'text-green-600' : 'text-red-500'}`}>
                          {v.vote_type === 'up' ? '▲ Up' : '▼ Down'}
                        </span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}

            {canDelete(d) && (
              isAdminLevel ? (
                <button onClick={() => onDelete(d.id)}
                  className="mt-auto flex items-center gap-2 px-3 py-2 text-sm rounded-lg text-red-600 hover:bg-red-50 transition-colors">
                  <Trash2 className="w-4 h-4" />Delete design
                </button>
              ) : countdown > 0 ? (
                <button onClick={() => onDelete(d.id)}
                  className="mt-auto flex items-center gap-2 px-3 py-2 text-sm rounded-lg text-red-600 hover:bg-red-50 transition-colors">
                  <Trash2 className="w-4 h-4" />
                  Delete
                  <span className="ml-auto flex items-center gap-1 text-xs text-red-400">
                    <Clock className="w-3 h-3" />{formatCountdown(countdown)}
                  </span>
                </button>
              ) : (
                <div className="mt-auto flex items-center gap-2 px-3 py-2 text-xs text-muted-foreground bg-muted/50 rounded-lg">
                  <Clock className="w-3.5 h-3.5 shrink-0" />
                  Deletion window expired. Contact an admin.
                </div>
              )
            )}
          </div>
        </div>

        <button onClick={() => onNavigate(index + 1)} disabled={index === designs.length - 1}
          className="p-2 rounded-full bg-white/10 text-white hover:bg-white/20 disabled:opacity-20 shrink-0">
          <ChevronRight className="w-5 h-5" />
        </button>
      </div>
    </div>
  )
}

// ── Pinterest Card ─────────────────────────────────────────────────────────

function DesignCard({
  design, onOpen, onVote, showCountdown,
}: {
  design: BrandingDesign
  onOpen: () => void
  onVote: (id: string, type: 'up' | 'down' | null) => void
  showCountdown: boolean   // true when this is the current user's own upload within window
}) {
  const [loaded, setLoaded] = useState(false)
  const [imgError, setImgError] = useState(false)
  const [countdown, setCountdown] = useState(() => showCountdown ? Math.max(0, msUntilExpiry(design.created_at)) : 0)

  useEffect(() => {
    if (!showCountdown) return
    const tick = setInterval(() => {
      const remaining = Math.max(0, msUntilExpiry(design.created_at))
      setCountdown(remaining)
      if (remaining === 0) clearInterval(tick)
    }, 1000)
    return () => clearInterval(tick)
  }, [showCountdown, design.created_at])

  return (
    <div className="group relative cursor-pointer rounded-xl overflow-hidden bg-muted break-inside-avoid mb-3">
      <div onClick={onOpen} style={{ minHeight: 160 }}>
        <img
          src={design.image_url}
          alt={design.title}
          onLoad={() => setLoaded(true)}
          onError={() => setImgError(true)}
          className={`w-full object-cover transition-transform duration-300 group-hover:scale-105 ${loaded && !imgError ? 'opacity-100' : 'opacity-0'}`}
        />
        {!loaded && !imgError && <div className="absolute inset-0 bg-muted animate-pulse" />}
        {imgError && (
          <div className="absolute inset-0 flex items-center justify-center bg-muted">
            <div className="flex flex-col items-center gap-1.5 text-muted-foreground/50">
              <svg className="w-8 h-8" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5}
                  d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z" />
              </svg>
              <span className="text-[10px]">Preview unavailable</span>
            </div>
          </div>
        )}
      </div>

      {/* Countdown badge — top-left, only for own recent uploads */}
      {showCountdown && countdown > 0 && (
        <div className="absolute top-2 left-2 flex items-center gap-1 bg-black/60 text-white text-[10px] font-medium px-1.5 py-0.5 rounded-md pointer-events-none">
          <Clock className="w-2.5 h-2.5" />
          {formatCountdown(countdown)}
        </div>
      )}

      {/* Hover overlay */}
      <div className="absolute inset-0 bg-gradient-to-t from-black/75 via-black/10 to-transparent opacity-0 group-hover:opacity-100 transition-opacity duration-200 pointer-events-none" />

      {/* Bottom info + votes on hover */}
      <div className="absolute bottom-0 left-0 right-0 p-2.5 translate-y-1 opacity-0 group-hover:translate-y-0 group-hover:opacity-100 transition-all duration-200">
        <div className="flex items-end justify-between gap-2">
          <div className="min-w-0">
            <p className="text-white text-xs font-semibold line-clamp-1 drop-shadow">{design.title}</p>
            <div className="flex items-center gap-1 mt-0.5">
              <div className="w-4 h-4 rounded-full bg-pink-500 flex items-center justify-center shrink-0">
                <span className="text-[8px] font-bold text-white">{(design.uploader_name || 'U')[0].toUpperCase()}</span>
              </div>
              <span className="text-white/80 text-[10px] truncate">{design.uploader_name}</span>
            </div>
          </div>
          <VoteBar design={design} onVote={onVote} size="sm" />
        </div>
      </div>

      {/* Zoom hint */}
      <div className="absolute top-2 right-2 opacity-0 group-hover:opacity-100 transition-opacity duration-200 pointer-events-none">
        <ZoomIn className="w-4 h-4 text-white/80 drop-shadow" />
      </div>
    </div>
  )
}

// ── Main Page ──────────────────────────────────────────────────────────────

export default function BrandingBrowse() {
  const { user, role } = useAuth()
  const { users: allUsers } = useAppData()
  const isAdmin = role === 'admin' || role === 'super_admin'
  // Only admin and sub_admin can filter by uploader; brand users cannot
  const canFilterByUploader = role === 'admin' || role === 'super_admin' || role === 'sub_admin'
  // Only super_admin and brand admin can see who voted
  const canSeeVoters = role === 'super_admin' || role === 'admin'

  const [designs, setDesigns] = useState<BrandingDesign[]>([])
  const [loading, setLoading] = useState(true)

  // Filters
  const [search, setSearch] = useState('')
  const [filterCategory, setFilterCategory] = useState('')
  const [filterUploader, setFilterUploader] = useState('')
  const [filterDateFrom, setFilterDateFrom] = useState('')
  const [filterDateTo, setFilterDateTo] = useState('')
  const [filtersOpen, setFiltersOpen] = useState(false)

  // Dialogs
  const [showUpload, setShowUpload] = useState(false)
  const [lightboxIndex, setLightboxIndex] = useState<number | null>(null)

  const categories = [...new Set(designs.map(d => d.category).filter(Boolean))].sort()
  const brandingMembers = allUsers.filter(u => u.team === 'branding' && u.role !== 'super_admin')

  const loadDesigns = useCallback(async () => {
    setLoading(true)
    try {
      const { designs: list } = await brandingApi.getDesigns({
        search: search.trim() || undefined,
        category: filterCategory || undefined,
        uploaderId: filterUploader || undefined,
        dateFrom: filterDateFrom || undefined,
        dateTo: filterDateTo || undefined,
      })
      setDesigns(list)
    } catch { /* ignore */ }
    finally { setLoading(false) }
  }, [search, filterCategory, filterUploader, filterDateFrom, filterDateTo])

  useEffect(() => {
    const t = setTimeout(() => { void loadDesigns() }, search ? 300 : 0)
    return () => clearTimeout(t)
  }, [loadDesigns, search])

  function handleUploaded(design: BrandingDesign) {
    setDesigns(prev => [design, ...prev])
  }

  async function handleDelete(id: string) {
    if (!confirm('Delete this design? This cannot be undone.')) return
    try {
      await brandingApi.deleteDesign(id)
      setDesigns(prev => prev.filter(d => d.id !== id))
      setLightboxIndex(null)
    } catch (e: unknown) {
      alert(e instanceof Error ? e.message : 'Delete failed.')
    }
  }

  async function handleVote(id: string, voteType: 'up' | 'down' | null) {
    try {
      const result = await brandingApi.castVote(id, voteType)
      setDesigns(prev => prev.map(d =>
        d.id === id ? { ...d, upvotes: result.upvotes, downvotes: result.downvotes, user_vote: result.user_vote } : d
      ))
    } catch { /* ignore */ }
  }

  // Admin can always delete. Non-admins only within the 1-hour window.
  function canDelete(d: BrandingDesign) {
    if (isAdmin) return true
    return d.uploader_id === user?.id && msUntilExpiry(d.created_at) > 0
  }

  // Whether a card should show a countdown badge (own upload, within window)
  function showCountdown(d: BrandingDesign) {
    return !isAdmin && d.uploader_id === user?.id && msUntilExpiry(d.created_at) > 0
  }

  // Active filter count excludes uploader if user can't see it
  const activeFilterCount = [
    filterCategory,
    canFilterByUploader ? filterUploader : '',
    filterDateFrom,
    filterDateTo,
  ].filter(Boolean).length

  return (
    <div className="animate-fade-in space-y-5">
      {/* Header */}
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div>
          <h1 className="text-2xl font-serif text-foreground">Design Gallery</h1>
          <p className="text-sm text-muted-foreground mt-0.5">{designs.length} designs</p>
        </div>
        <button
          onClick={() => setShowUpload(true)}
          className="flex items-center gap-2 px-4 py-2 bg-pink-600 text-white rounded-xl text-sm hover:bg-pink-700 transition-colors shadow-sm"
        >
          <Upload className="w-4 h-4" />Upload Design
        </button>
      </div>

      {/* Search + Filter bar */}
      <div className="flex gap-2 flex-wrap">
        <div className="relative flex-1 min-w-48">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground pointer-events-none" />
          <input
            className="w-full border border-border rounded-xl pl-9 pr-3 py-2.5 text-sm bg-background"
            placeholder="Search designs, tags…"
            value={search}
            onChange={e => setSearch(e.target.value)}
          />
        </div>
        <button
          onClick={() => setFiltersOpen(o => !o)}
          className={`flex items-center gap-2 px-4 py-2.5 text-sm rounded-xl border transition-colors ${
            filtersOpen || activeFilterCount > 0
              ? 'border-pink-500 text-pink-600 bg-pink-50'
              : 'border-border text-muted-foreground hover:bg-accent'
          }`}
        >
          <Filter className="w-4 h-4" />
          Filters
          {activeFilterCount > 0 && (
            <span className="ml-0.5 w-4 h-4 rounded-full bg-pink-600 text-white text-[10px] flex items-center justify-center font-bold">
              {activeFilterCount}
            </span>
          )}
        </button>
      </div>

      {/* Filter panel */}
      {filtersOpen && (
        <div className="hub-card animate-fade-in">
          <div className={`grid gap-3 ${canFilterByUploader ? 'grid-cols-2 md:grid-cols-4' : 'grid-cols-1 md:grid-cols-3'}`}>
            <div>
              <label className="text-xs font-medium text-muted-foreground block mb-1">Category</label>
              <select className="w-full border border-border rounded-lg px-3 py-2 text-sm bg-background"
                value={filterCategory} onChange={e => setFilterCategory(e.target.value)}>
                <option value="">All categories</option>
                {categories.map(c => <option key={c} value={c}>{c}</option>)}
              </select>
            </div>
            {canFilterByUploader && (
              <div>
                <label className="text-xs font-medium text-muted-foreground block mb-1">Uploader</label>
                <select className="w-full border border-border rounded-lg px-3 py-2 text-sm bg-background"
                  value={filterUploader} onChange={e => setFilterUploader(e.target.value)}>
                  <option value="">All members</option>
                  {brandingMembers.map(m => (
                    <option key={m.id} value={m.id}>{m.full_name || m.email}</option>
                  ))}
                </select>
              </div>
            )}
            <div>
              <label className="text-xs font-medium text-muted-foreground block mb-1">From</label>
              <input type="date" className="w-full border border-border rounded-lg px-3 py-2 text-sm bg-background"
                value={filterDateFrom} onChange={e => setFilterDateFrom(e.target.value)} />
            </div>
            <div>
              <label className="text-xs font-medium text-muted-foreground block mb-1">To</label>
              <input type="date" className="w-full border border-border rounded-lg px-3 py-2 text-sm bg-background"
                value={filterDateTo} onChange={e => setFilterDateTo(e.target.value)} />
            </div>
          </div>
          {activeFilterCount > 0 && (
            <button
              onClick={() => { setFilterCategory(''); setFilterUploader(''); setFilterDateFrom(''); setFilterDateTo('') }}
              className="mt-3 text-xs text-pink-600 hover:underline"
            >
              Clear all filters
            </button>
          )}
        </div>
      )}

      {/* Gallery */}
      {loading ? (
        <div className="columns-2 md:columns-3 lg:columns-4 gap-3">
          {Array.from({ length: 8 }).map((_, i) => (
            <div key={i} className="mb-3 break-inside-avoid rounded-xl bg-muted animate-pulse"
              style={{ height: 120 + (i % 3) * 60 }} />
          ))}
        </div>
      ) : designs.length === 0 ? (
        <div className="text-center py-16">
          <p className="text-muted-foreground text-sm">
            {search || activeFilterCount > 0
              ? 'No designs match your filters.'
              : 'No designs uploaded yet. Be the first to upload!'}
          </p>
        </div>
      ) : (
        <div className="columns-2 md:columns-3 lg:columns-4 gap-3">
          {designs.map((d, i) => (
            <DesignCard key={d.id} design={d} onOpen={() => setLightboxIndex(i)} onVote={handleVote} showCountdown={showCountdown(d)} />
          ))}
        </div>
      )}

      {showUpload && (
        <UploadDialog categories={categories} onUploaded={handleUploaded} onClose={() => setShowUpload(false)} />
      )}

      {lightboxIndex !== null && (
        <Lightbox
          designs={designs}
          index={lightboxIndex}
          canDelete={canDelete}
          isAdminLevel={isAdmin}
          canSeeVoters={canSeeVoters}
          onDelete={handleDelete}
          onVote={handleVote}
          onClose={() => setLightboxIndex(null)}
          onNavigate={i => setLightboxIndex(i)}
        />
      )}
    </div>
  )
}
