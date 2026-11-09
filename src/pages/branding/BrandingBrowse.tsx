import { useCallback, useEffect, useRef, useState } from 'react'
import { useAuth } from '@/hooks/useAuth'
import { useAppData } from '@/hooks/useAppData'
import { brandingApi } from '@/lib/branding-api'
import { checkImageFile, IMAGE_ACCEPT } from '@/lib/image-file'
import type { BrandingDesign, DesignVoter } from '@/lib/branding-types'
import {
  Search, Upload, X, Tag,
  Trash2, ZoomIn, ChevronLeft, ChevronRight, Filter,
  ThumbsUp, ThumbsDown, Clock, ImageOff, Images,
} from 'lucide-react'
import { DS, cx, Avatar, Badge, BlockHeader, Card, EmptyState, FieldTile, Modal, Spinner } from './ds'

// ── Time helpers ───────────────────────────────────────────────────────────

const ONE_HOUR_MS = 60 * 60 * 1000
// Countdown chips turn from amber to rose in the final stretch of the window.
const URGENT_MS = 10 * 60 * 1000

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

// ── Vote pill styling (shared) ─────────────────────────────────────────────

const VOTE_IDLE = 'bg-white border border-[#C5CAD1] text-[#6B7280] hover:bg-[#F9FAFB]'
const VOTE_UP = 'bg-emerald-50 text-emerald-700 ring-1 ring-emerald-200 border border-transparent'
const VOTE_DOWN = 'bg-rose-50 text-rose-700 ring-1 ring-rose-200 border border-transparent'

// ── Vote buttons (shared between card and lightbox) ────────────────────────

interface VoteBarProps {
  design: BrandingDesign
  onVote: (id: string, type: 'up' | 'down' | null) => void
  size?: 'sm' | 'md'
}

function VoteBar({ design, onVote, size = 'sm' }: VoteBarProps) {
  const iconCls = size === 'md' ? 'w-4 h-4' : 'w-3.5 h-3.5'
  const btnBase = size === 'md'
    ? 'inline-flex items-center gap-1.5 px-3 py-1.5 rounded-[4px] text-sm font-semibold transition-colors cursor-pointer shadow-sm'
    : 'inline-flex items-center gap-1 px-2.5 py-1 rounded-[4px] text-xs font-semibold transition-colors cursor-pointer shadow-sm'

  function toggle(type: 'up' | 'down') {
    onVote(design.id, design.user_vote === type ? null : type)
  }

  return (
    <div className="flex items-center gap-1.5">
      <button
        type="button"
        onClick={e => { e.stopPropagation(); toggle('up') }}
        className={cx(btnBase, design.user_vote === 'up' ? VOTE_UP : VOTE_IDLE)}
        title="Upvote"
      >
        <ThumbsUp className={iconCls} />
        <span className="font-semibold">{design.upvotes}</span>
      </button>
      <button
        type="button"
        onClick={e => { e.stopPropagation(); toggle('down') }}
        className={cx(btnBase, design.user_vote === 'down' ? VOTE_DOWN : VOTE_IDLE)}
        title="Downvote"
      >
        <ThumbsDown className={iconCls} />
        <span className="font-semibold">{design.downvotes}</span>
      </button>
    </div>
  )
}

// lightbox variant shown in the info panel
function VoteBarLight({ design, onVote }: { design: BrandingDesign; onVote: (id: string, t: 'up' | 'down' | null) => void }) {
  function toggle(type: 'up' | 'down') {
    onVote(design.id, design.user_vote === type ? null : type)
  }
  const base = 'inline-flex items-center gap-1.5 px-3 py-1.5 rounded-[4px] text-sm font-semibold transition-colors cursor-pointer'
  return (
    <div className="flex items-center gap-2">
      <button
        type="button"
        onClick={() => toggle('up')}
        className={cx(base, design.user_vote === 'up' ? VOTE_UP : VOTE_IDLE)}
      >
        <ThumbsUp className="w-4 h-4" />
        <span className="font-semibold">{design.upvotes}</span>
      </button>
      <button
        type="button"
        onClick={() => toggle('down')}
        className={cx(base, design.user_vote === 'down' ? VOTE_DOWN : VOTE_IDLE)}
      >
        <ThumbsDown className="w-4 h-4" />
        <span className="font-semibold">{design.downvotes}</span>
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
    /* The server's rules (raster images only, 10 MB), checked as the file is
       picked so the reason shows at once instead of after the upload. */
    const problem = checkImageFile(f, 10 * 1024 * 1024)
    if (problem) {
      setErr(problem)
      e.target.value = ''
      return
    }
    setErr('')
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
    <Modal
      title="Upload Design"
      subtitle="Share a finished piece with the branding team."
      onClose={onClose}
      size="lg"
      footer={
        <>
          <button type="button" onClick={onClose} className={cx(DS.btn, DS.btnSecondary)}>Cancel</button>
          <button type="submit" form="branding-upload-form" disabled={uploading} className={cx(DS.btn, DS.btnPrimary)}>
            {uploading ? <Spinner className="border-white/40 border-t-white" /> : <Upload className="w-4 h-4" />}
            {uploading ? 'Uploading…' : 'Upload'}
          </button>
        </>
      }
    >
      <form id="branding-upload-form" onSubmit={handleSubmit} className="space-y-4">
        <div
          onClick={() => fileRef.current?.click()}
          className="relative border-2 border-dashed border-[#9CA3AF] rounded-[6px] overflow-hidden cursor-pointer bg-[#F9FAFB] hover:border-bp-400 hover:bg-bp-50/40 transition-colors"
          style={{ minHeight: 180 }}
        >
          {preview
            ? <img src={preview} alt="preview" className="w-full object-contain max-h-64" />
            : <div className="flex flex-col items-center justify-center py-12 gap-2">
                <div className="w-11 h-11 rounded-[6px] bg-bp-50 text-bp-700 grid place-items-center">
                  <Upload className="w-5 h-5" />
                </div>
                <span className="text-sm font-semibold text-[#111827] mt-1">Click to select an image</span>
                <span className={DS.muted}>PNG, JPG, WEBP · max 10 MB</span>
              </div>
          }
          <input ref={fileRef} type="file" accept={IMAGE_ACCEPT} className="hidden" onChange={onFileChange} />
        </div>
        <div>
          <label className={DS.label}>Title *</label>
          <input className={DS.input}
            value={title} onChange={e => setTitle(e.target.value)} placeholder="Social media post for Convocation" />
        </div>
        <div>
          <label className={DS.label}>Description</label>
          <textarea className={cx(DS.textarea, 'resize-none')}
            rows={2} value={description} onChange={e => setDescription(e.target.value)} placeholder="Brief description…" />
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div>
            <label className={DS.label}>Category</label>
            <select className={DS.select}
              value={category} onChange={e => setCategory(e.target.value)}>
              <option value="">— None —</option>
              {categories.map(c => <option key={c} value={c}>{c}</option>)}
              <option value="__custom__">Other (type below)</option>
            </select>
          </div>
          {category === '__custom__' && (
            <div>
              <label className={DS.label}>Custom Category</label>
              <input className={DS.input}
                value={customCategory} onChange={e => setCustomCategory(e.target.value)} placeholder="e.g. Merchandise" />
            </div>
          )}
        </div>
        <div>
          <label className={DS.label}>Tags</label>
          <input className={DS.input}
            value={tagsInput} onChange={e => setTagsInput(e.target.value)} placeholder="convocation, social-media, 2024" />
          <p className={DS.hint}>Comma-separated. Tags make designs easier to find in search.</p>
        </div>
        {err && <p className="text-xs font-semibold text-rose-600">{err}</p>}
      </form>
    </Modal>
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

const LIGHTBOX_NAV = 'w-10 h-10 rounded-[4px] bg-white text-[#374151] hover:bg-bp-600 hover:text-white grid place-items-center transition-colors duration-200 disabled:opacity-30 disabled:hover:bg-white disabled:hover:text-[#374151] disabled:cursor-not-allowed shrink-0 cursor-pointer shadow-lg'

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
    <div className="fixed inset-0 bg-[#111827] backdrop-blur-xs flex items-center justify-center z-50"
      onClick={onClose}>
      <div className="relative flex items-center gap-1.5 sm:gap-3 max-w-5xl w-full mx-2 sm:mx-4"
        onClick={e => e.stopPropagation()}>

        <button type="button" onClick={() => onNavigate(index - 1)} disabled={index === 0}
          className={LIGHTBOX_NAV} aria-label="Previous design">
          <ChevronLeft className="w-5 h-5" />
        </button>

        <div className="flex-1 bg-white rounded-[6px] overflow-hidden shadow-[0_24px_48px_-12px_rgba(16,24,40,0.25)] border border-[#C5CAD1] flex flex-col md:flex-row max-h-[85vh]">
          {/* Image */}
          <div className="flex-1 bg-[#111827] flex items-center justify-center min-h-64 max-h-[70vh] md:max-h-[85vh] relative">
            <img src={d.image_url} alt={d.title} className="max-w-full max-h-full object-contain" />
            {/* Vote overlay on image bottom */}
            <div className="absolute bottom-3 left-3">
              <VoteBar design={d} onVote={onVote} size="md" />
            </div>
          </div>

          {/* Info panel */}
          <div className="w-full md:w-72 p-4 flex flex-col gap-3 overflow-y-auto border-t md:border-t-0 md:border-l border-[#C5CAD1]">
            <div className="flex items-start justify-between gap-2">
              <h2 className={DS.h3}>{d.title}</h2>
              <button type="button" onClick={onClose} className={cx(DS.iconBtnSm, 'ml-2')} aria-label="Close">
                <X className="w-4 h-4" />
              </button>
            </div>

            {d.description && (
              <p className="text-sm text-[#6B7280] font-medium leading-relaxed">{d.description}</p>
            )}

            {/* Meta */}
            <div className="grid grid-cols-3 gap-2 border-t border-[#C5CAD1] pt-3">
              <FieldTile label="Uploader" value={d.uploader_name || '—'} />
              <FieldTile label="Category" value={d.category || '—'} />
              <FieldTile label="Uploaded" value={new Date(d.created_at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })} />
            </div>

            {/* Vote counts (light version) */}
            <VoteBarLight design={d} onVote={onVote} />

            {d.tags.length > 0 && (
              <div className="flex flex-wrap gap-1.5 border-t border-[#C5CAD1] pt-2.5">
                {d.tags.map(tag => (
                  <Badge key={tag} tone="info">
                    <Tag className="w-2.5 h-2.5" />{tag}
                  </Badge>
                ))}
              </div>
            )}

            {/* Admin: voter list */}
            {canSeeVoters && (
              <div className="border-t border-[#C5CAD1] pt-2.5">
                {!showVoters ? (
                  <button
                    type="button"
                    onClick={loadVoters}
                    disabled={votersLoading}
                    className="text-xs font-semibold text-bp-700 hover:text-bp-800 hover:underline disabled:opacity-50 cursor-pointer"
                  >
                    {votersLoading ? 'Loading…' : `View voters (${d.upvotes + d.downvotes})`}
                  </button>
                ) : (
                  <div className="space-y-1">
                    <div className="flex items-center justify-between mb-1.5">
                      <p className={DS.eyebrow}>Voters</p>
                      <button type="button" onClick={() => setShowVoters(false)} className="text-xs font-semibold text-[#6B7280] hover:text-[#111827] cursor-pointer">Hide</button>
                    </div>
                    {voters.length === 0 && <p className={DS.muted}>No votes yet.</p>}
                    {voters.map(v => (
                      <div key={v.user_id} className="flex items-center justify-between text-xs py-0.5">
                        <span className="text-[#111827] font-medium truncate">{v.user_name}</span>
                        <span className={cx('font-semibold shrink-0 ml-2', v.vote_type === 'up' ? 'text-emerald-600' : 'text-rose-600')}>
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
                <button type="button" onClick={() => onDelete(d.id)}
                  className={cx(DS.btn, DS.btnDanger, DS.btnSm, 'mt-auto w-full')}>
                  <Trash2 className="w-4 h-4" />Delete design
                </button>
              ) : countdown > 0 ? (
                <button type="button" onClick={() => onDelete(d.id)}
                  className={cx(DS.btn, DS.btnDanger, DS.btnSm, 'mt-auto w-full !justify-between')}>
                  <span className="inline-flex items-center gap-2"><Trash2 className="w-4 h-4" />Delete</span>
                  <Badge tone={countdown < URGENT_MS ? 'danger' : 'warning'}>
                    <Clock className="w-3 h-3" />{formatCountdown(countdown)}
                  </Badge>
                </button>
              ) : (
                <div className="mt-auto flex items-center gap-2 px-3 py-2 text-xs font-medium text-[#6B7280] bg-[#F9FAFB] border border-[#C5CAD1] rounded-[4px]">
                  <Clock className="w-3.5 h-3.5 shrink-0 text-[#9CA3AF]" />
                  Deletion window expired. Contact an admin.
                </div>
              )
            )}
          </div>
        </div>

        <button type="button" onClick={() => onNavigate(index + 1)} disabled={index === designs.length - 1}
          className={LIGHTBOX_NAV} aria-label="Next design">
          <ChevronRight className="w-5 h-5" />
        </button>
      </div>
    </div>
  )
}

// ── Gallery tile ───────────────────────────────────────────────────────────

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
    <div className="group bg-white rounded-[6px] border border-[#C5CAD1] overflow-hidden hover:border-bp-700 transition-colors duration-300 ease-out flex flex-col min-w-0">
      {/* Image area */}
      <div onClick={onOpen} className="relative aspect-[4/3] bg-[#F3F4F6] overflow-hidden cursor-pointer">
        <img
          src={design.image_url}
          alt={design.title}
          loading="lazy"
          onLoad={() => setLoaded(true)}
          onError={() => setImgError(true)}
          className={cx(
            'absolute inset-0 w-full h-full object-cover transition-all duration-500 ease-out group-hover:scale-[1.03]',
            loaded && !imgError ? 'opacity-100' : 'opacity-0',
          )}
        />
        {!loaded && !imgError && <div className="absolute inset-0 bg-[#F3F4F6] animate-pulse" />}
        {imgError && (
          <div className="absolute inset-0 flex items-center justify-center bg-[#F3F4F6]">
            <div className="flex flex-col items-center gap-1.5 text-[#9CA3AF]">
              <ImageOff className="w-7 h-7" />
              <span className="text-[11px] font-semibold">Preview unavailable</span>
            </div>
          </div>
        )}

        {/* Countdown badge — top-left, only for own recent uploads */}
        {showCountdown && countdown > 0 && (
          <div className="absolute top-2 left-2 pointer-events-none">
            <Badge tone={countdown < URGENT_MS ? 'danger' : 'warning'} className="shadow-sm">
              <Clock className="w-3 h-3" />{formatCountdown(countdown)}
            </Badge>
          </div>
        )}

        {/* Zoom hint */}
        <div className="absolute top-2 right-2 opacity-0 group-hover:opacity-100 transition-opacity duration-200 pointer-events-none">
          <span className="w-8 h-8 rounded-[4px] bg-white/95 text-[#374151] grid place-items-center shadow-sm">
            <ZoomIn className="w-4 h-4" />
          </span>
        </div>
      </div>

      {/* Caption */}
      <div className="p-3.5 flex flex-col gap-2.5">
        <div className="min-w-0">
          <p className="text-sm font-semibold text-[#111827] truncate" title={design.title}>{design.title}</p>
          <div className="flex items-center gap-2 mt-1.5 min-w-0">
            <Avatar name={design.uploader_name} size="xs" />
            <span className="text-[13px] font-medium text-[#6B7280] truncate">
              {design.uploader_name}
              {design.category && <> · {design.category}</>}
            </span>
          </div>
        </div>
        <VoteBar design={design} onVote={onVote} size="sm" />
      </div>
    </div>
  )
}

// ── Main Page ──────────────────────────────────────────────────────────────

export default function BrandingBrowse({ embedded = false }: { embedded?: boolean } = {}) {
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

  const filtersActive = filtersOpen || activeFilterCount > 0

  return (
    <div className="animate-fade-in space-y-4" data-embedded={embedded || undefined}>
      {/* Toolbar — the host shell owns the page title in both hosts, so this
          strip is only search, filters, the count and upload. */}
      <div className={cx(DS.card, 'p-4 flex flex-wrap items-center gap-3')}>
        <div className="relative flex-1 min-w-[200px] max-w-xs">
          <input
            className={cx(DS.input, '!pr-9')}
            placeholder="Search designs, tags…"
            value={search}
            onChange={e => setSearch(e.target.value)}
          />
          <Search className="w-4 h-4 text-[#9CA3AF] absolute right-3 top-1/2 -translate-y-1/2 pointer-events-none" />
        </div>
        <select
          className={cx(DS.select, '!w-auto')}
          value={filterCategory}
          onChange={e => setFilterCategory(e.target.value)}
          aria-label="Category"
        >
          <option value="">All categories</option>
          {categories.map(c => <option key={c} value={c}>{c}</option>)}
        </select>
        {canFilterByUploader && (
          <select
            className={cx(DS.select, '!w-auto')}
            value={filterUploader}
            onChange={e => setFilterUploader(e.target.value)}
            aria-label="Uploader"
          >
            <option value="">All members</option>
            {brandingMembers.map(m => (
              <option key={m.id} value={m.id}>{m.full_name || m.email}</option>
            ))}
          </select>
        )}
        <button
          type="button"
          onClick={() => setFiltersOpen(o => !o)}
          aria-expanded={filtersOpen}
          className={cx(DS.btn, DS.btnSecondary, filtersActive && 'border-bp-300 text-bp-800')}
        >
          <Filter className="w-4 h-4" />
          Filters
          {activeFilterCount > 0 && (
            <span className="ml-0.5 w-4 h-4 rounded-full bg-bp-700 text-white text-[10px] grid place-items-center font-semibold">
              {activeFilterCount}
            </span>
          )}
        </button>
        <span className="ml-auto text-[13px] font-semibold text-[#6B7280] tabular-nums">
          {designs.length} {designs.length === 1 ? 'design' : 'designs'}
        </span>
        <button
          type="button"
          onClick={() => setShowUpload(true)}
          className={cx(DS.btn, DS.btnPrimary)}
        >
          <Upload className="w-4 h-4" />Upload Design
        </button>
      </div>

      {/* Category chips */}
      {categories.length > 0 && (
        <div className="flex items-center gap-2 flex-wrap">
          <button
            type="button"
            onClick={() => setFilterCategory('')}
            className={cx(DS.pill, filterCategory === '' ? DS.pillOn : DS.pillOff)}
          >
            All
          </button>
          {categories.map(c => (
            <button
              key={c}
              type="button"
              onClick={() => setFilterCategory(c)}
              className={cx(DS.pill, filterCategory === c ? DS.pillOn : DS.pillOff)}
            >
              {c}
            </button>
          ))}
        </div>
      )}

      {/* Filter panel — date range */}
      {filtersOpen && (
        <Card className="animate-fade-in">
          <div className="grid gap-3 grid-cols-1 sm:grid-cols-2 md:grid-cols-4">
            <div>
              <label className={DS.label}>From</label>
              <input type="date" className={DS.input}
                value={filterDateFrom} onChange={e => setFilterDateFrom(e.target.value)} />
            </div>
            <div>
              <label className={DS.label}>To</label>
              <input type="date" className={DS.input}
                value={filterDateTo} onChange={e => setFilterDateTo(e.target.value)} />
            </div>
          </div>
          {activeFilterCount > 0 && (
            <button
              type="button"
              onClick={() => { setFilterCategory(''); setFilterUploader(''); setFilterDateFrom(''); setFilterDateTo('') }}
              className={cx(DS.btn, DS.btnGhost, DS.btnSm, 'mt-3 text-bp-700 hover:text-bp-800')}
            >
              Clear all filters
            </button>
          )}
        </Card>
      )}

      {/* Gallery */}
      <BlockHeader
        title="Designs"
        subtitle={`${designs.length} ${designs.length === 1 ? 'design' : 'designs'} from the branding team`}
        chip={filterCategory || 'All categories'}
        className="!mb-0"
      />
      {loading ? (
        <div className={cx(DS.card, 'flex items-center justify-center py-16')}>
          <Spinner className="w-6 h-6" />
        </div>
      ) : designs.length === 0 ? (
        <div className={DS.card}>
          <EmptyState
            icon={Images}
            title={search || activeFilterCount > 0 ? 'No designs match your filters' : 'No designs uploaded yet'}
            body={search || activeFilterCount > 0
              ? 'Try a different search term or clear the active filters.'
              : 'Be the first to share a design with the branding team.'}
            action={
              search || activeFilterCount > 0 ? undefined : (
                <button type="button" onClick={() => setShowUpload(true)} className={cx(DS.btn, DS.btnPrimary, DS.btnSm)}>
                  <Upload className="w-4 h-4" />Upload Design
                </button>
              )
            }
          />
        </div>
      ) : (
        <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-4">
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
