import { useCallback, useEffect, useState } from 'react'
import {
  HardDrive, CheckCircle2, AlertCircle, Loader2, ExternalLink, RefreshCw, LogIn, Unplug, FolderOpen,
} from 'lucide-react'
import {
  getDriveStatus, saveDriveClient, setDriveAccount, startDriveConnect, chooseDriveFolder,
  disconnectDrive, syncAllToDrive, formatWhen, type DriveStatus,
} from '@/lib/outreach-video-data'

/**
 * Video Workflow → Google Drive (Campaign & Content Management PRD §9).
 *
 * Where the outreach team connects the Google account that holds every
 * campaign's videos, captions and published work. It lives here, in the
 * outreach video workflow, because it is the outreach team's Drive — not
 * Media Ops', and not the casting account's.
 *
 * Three steps, and the page only shows the one that is next:
 *   1. Tell Google about this Nerve (once) — an OAuth client from Google Cloud
 *      Console. Skipped when the server already provides one.
 *   2. Sign in as the outreach account. Any other account is refused.
 *   3. Done — the folder is created, and everything that happens in the
 *      workflow is mirrored into it from then on.
 */
export default function VideoDrive() {
  const [status, setStatus] = useState<DriveStatus | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    try {
      setStatus(await getDriveStatus())
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load the Drive settings.')
    }
  }, [])

  useEffect(() => { void refresh() }, [refresh])

  /* The Google sign-in happens in a popup; its closing page posts a message
     back so this page can update without the person reloading. */
  useEffect(() => {
    function onMessage(e: MessageEvent) {
      if (e.origin !== window.location.origin) return
      const d = e.data as { type?: string; ok?: boolean; message?: string }
      if (d?.type !== 'nerve-outreach-drive') return
      setBusy(null)
      if (d.ok) { setNotice(d.message ?? 'Google Drive connected.'); setError(null) }
      else setError(d.message ?? 'Google Drive was not connected.')
      void refresh()
    }
    window.addEventListener('message', onMessage)
    return () => window.removeEventListener('message', onMessage)
  }, [refresh])

  async function run(key: string, fn: () => Promise<unknown>, done?: string) {
    setBusy(key)
    setError(null)
    setNotice(null)
    try {
      await fn()
      if (done) setNotice(done)
      await refresh()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'That did not work. Please try again.')
    } finally {
      setBusy(null)
    }
  }

  async function connect() {
    setBusy('connect')
    setError(null)
    setNotice(null)
    try {
      const url = await startDriveConnect()
      const popup = window.open(url, 'nerve-outreach-drive', 'width=520,height=680')
      // A blocked popup must not leave the button spinning forever.
      if (!popup) { window.location.href = url; return }
      const watch = window.setInterval(() => {
        if (popup.closed) { window.clearInterval(watch); setBusy(b => (b === 'connect' ? null : b)); void refresh() }
      }, 800)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not start the Google sign-in.')
      setBusy(null)
    }
  }

  if (!status) {
    return (
      <div className="animate-fade-in space-y-5">
        <Header />
        {error
          ? <Banner kind="error">{error}</Banner>
          : <div className="hub-card text-center py-12 text-sm text-muted-foreground">
              <Loader2 className="w-4 h-4 animate-spin inline mr-2" /> Loading…
            </div>}
      </div>
    )
  }

  const envWins = status.source === 'env'
  const needsClient = status.client === 'none'

  return (
    <div className="animate-fade-in space-y-5 max-w-3xl">
      <Header />

      {error && <Banner kind="error">{error}</Banner>}
      {notice && <Banner kind="ok">{notice}</Banner>}

      {/* ── Where things stand ─────────────────────────────────────────── */}
      <div className="hub-card space-y-3">
        {envWins ? (
          <div className="flex items-start gap-2 text-sm">
            <CheckCircle2 className="w-4 h-4 mt-0.5 text-emerald-600 shrink-0" />
            <p className="text-foreground">
              Google Drive is set up on the server, so the workflow is already using it.
              Anything connected below only takes over if that server setting is removed.
            </p>
          </div>
        ) : status.connected ? (
          <div className="space-y-2">
            <div className="flex items-start gap-2 text-sm">
              <CheckCircle2 className="w-4 h-4 mt-0.5 text-emerald-600 shrink-0" />
              <p className="text-foreground">
                <b>Connected</b> as <span className="font-mono">{status.account_email}</span>
                {status.connected_at && <> · since {formatWhen(status.connected_at)}</>}
                {status.connected_by_name && <> · by {status.connected_by_name}</>}
              </p>
            </div>
            {status.folder && (
              <div className="flex items-center gap-2 flex-wrap text-sm pl-6">
                <span className="text-muted-foreground">Folder:</span>
                <b className="text-foreground">{status.folder.name ?? status.default_folder_name}</b>
                {status.folder.url && (
                  <a href={status.folder.url} target="_blank" rel="noopener noreferrer"
                    className="text-xs px-2.5 py-1 rounded-lg bg-blue-100 text-blue-700 hover:opacity-80 inline-flex items-center gap-1">
                    <ExternalLink className="w-3 h-3" /> Open in Drive
                  </a>
                )}
              </div>
            )}
          </div>
        ) : status.source === 'local' ? (
          <div className="flex items-start gap-2 text-sm">
            <AlertCircle className="w-4 h-4 mt-0.5 text-amber-600 shrink-0" />
            <p className="text-foreground">
              <b>Using a local folder on the server</b> (DRIVE_LOCAL_ROOT) — fine for development, but
              nothing reaches Google Drive. Connecting an account below takes over from it.
            </p>
          </div>
        ) : (
          <div className="flex items-start gap-2 text-sm">
            <AlertCircle className="w-4 h-4 mt-0.5 text-amber-600 shrink-0" />
            <p className="text-foreground">
              <b>Not connected yet.</b> Until it is, the video workflow cannot store uploads.
            </p>
          </div>
        )}

        <div className="text-[12px] text-muted-foreground border-t border-border pt-3">
          Inside the folder, every campaign gets the layout from the PRD:
          <pre className="mt-1.5 font-mono text-[11px] leading-5 text-foreground/80">{`${status.folder?.name ?? status.default_folder_name}/
└── Social Media Campaigns/
    └── VLF 2027/
        ├── Videos/      ← uploaded videos, until published
        ├── Captions/    ← one file per video: caption, description, every remark
        └── Published/   ← videos move here when they go out`}</pre>
        </div>
      </div>

      {/* ── 1. The Google account ──────────────────────────────────────── */}
      <AccountCard status={status} busy={busy === 'account'}
        onSave={email => run('account', () => setDriveAccount(email), 'Saved.')} />

      {/* ── 2. Tell Google about this Nerve (once) ─────────────────────── */}
      {needsClient
        ? <ClientCard status={status} busy={busy === 'client'}
            onSave={(id, secret) => run('client', () => saveDriveClient(id, secret), 'OAuth client saved. Now sign in with Google.')} />
        : (
          <details className="hub-card">
            <summary className="text-sm text-foreground cursor-pointer">
              Google OAuth client: {status.client === 'env' ? 'from the server' : 'saved here'}
              <span className="font-mono text-[11px] text-muted-foreground ml-2">{status.client_id}</span>
            </summary>
            <div className="mt-3 space-y-2 text-[12px] text-muted-foreground">
              <p>This authorised redirect URI must be registered on that client in Google Cloud Console:</p>
              <CopyField value={status.redirect_uri} />
              {status.client === 'app' && (
                <ClientCard status={status} busy={busy === 'client'} embedded
                  onSave={(id, secret) => run('client', () => saveDriveClient(id, secret), 'OAuth client replaced.')} />
              )}
            </div>
          </details>
        )}

      {/* ── 3. Sign in ─────────────────────────────────────────────────── */}
      <div className="hub-card space-y-3">
        <h2 className="text-sm font-semibold text-foreground">
          {status.connected ? 'Reconnect' : 'Sign in with Google'}
        </h2>
        <p className="text-[12px] text-muted-foreground">
          Sign in as <span className="font-mono text-foreground">{status.expected_email}</span>.
          Google will ask to allow Drive access. Signing in with any other account is refused,
          so videos can never end up in the wrong Drive.
        </p>
        <div className="flex items-center gap-2 flex-wrap">
          <button onClick={connect} disabled={needsClient || busy !== null}
            className="px-4 py-2 rounded-lg bg-orange-600 text-white text-sm font-medium hover:opacity-90 disabled:opacity-40 inline-flex items-center gap-2">
            {busy === 'connect' ? <Loader2 className="w-4 h-4 animate-spin" /> : <LogIn className="w-4 h-4" />}
            {status.connected ? 'Reconnect with Google' : 'Sign in with Google and connect Drive'}
          </button>
          {needsClient && <span className="text-[12px] text-muted-foreground">Add the OAuth client above first.</span>}
        </div>
      </div>

      {/* ── Once connected ─────────────────────────────────────────────── */}
      {status.connected && (
        <>
          <FolderCard busy={busy === 'folder'} accountEmail={status.account_email}
            onUse={folder => run('folder', () => chooseDriveFolder(folder), 'Folder changed.')} />

          <div className="hub-card space-y-3">
            <h2 className="text-sm font-semibold text-foreground">Sync everything to Drive</h2>
            <p className="text-[12px] text-muted-foreground">
              The workflow keeps Drive up to date by itself at every step. Use this after connecting,
              or if Drive was unreachable for a while: it rewrites every video's caption file and
              puts each video in Videos/ or Published/ according to its status.
            </p>
            <button disabled={busy !== null}
              onClick={() => run('sync', async () => {
                const r = await syncAllToDrive()
                setNotice(r.failed.length
                  ? `Synced ${r.synced} video${r.synced === 1 ? '' : 's'}; ${r.failed.length} could not be: ${r.failed.map(f => f.title).join(', ')}.`
                  : `Synced ${r.synced} video${r.synced === 1 ? '' : 's'} to Drive.`)
              })}
              className="px-4 py-2 rounded-lg border border-border text-sm text-foreground hover:bg-accent disabled:opacity-40 inline-flex items-center gap-2">
              {busy === 'sync' ? <Loader2 className="w-4 h-4 animate-spin" /> : <RefreshCw className="w-4 h-4" />}
              Sync now
            </button>
          </div>

          <div className="hub-card space-y-3">
            <h2 className="text-sm font-semibold text-foreground">Disconnect</h2>
            <p className="text-[12px] text-muted-foreground">
              The folder and everything in it stays in Drive. The workflow stops being able to
              store uploads until an account is connected again.
            </p>
            <button disabled={busy !== null}
              onClick={() => {
                if (!confirm('Disconnect Google Drive? Uploads will stop working until it is connected again.')) return
                void run('disconnect', disconnectDrive, 'Disconnected. Nothing in Drive was deleted.')
              }}
              className="px-4 py-2 rounded-lg border border-rose-200 text-sm text-rose-600 hover:bg-rose-50 disabled:opacity-40 inline-flex items-center gap-2">
              <Unplug className="w-4 h-4" /> Disconnect
            </button>
          </div>
        </>
      )}
    </div>
  )
}

function Header() {
  return (
    <div className="flex items-center gap-3">
      <div className="w-10 h-10 rounded-xl bg-orange-100 flex items-center justify-center">
        <HardDrive className="w-5 h-5 text-orange-600" />
      </div>
      <div>
        <h1 className="text-xl font-serif text-foreground">Google Drive</h1>
        <p className="text-sm text-muted-foreground">
          Where every campaign's videos, captions and published work are kept.
        </p>
      </div>
    </div>
  )
}

function Banner({ kind, children }: { kind: 'error' | 'ok'; children: React.ReactNode }) {
  const cls = kind === 'error' ? 'text-rose-600' : 'text-emerald-700'
  const Icon = kind === 'error' ? AlertCircle : CheckCircle2
  return (
    <div className={`hub-card flex items-start gap-2 text-sm ${cls}`}>
      <Icon className="w-4 h-4 mt-0.5 shrink-0" /> <span>{children}</span>
    </div>
  )
}

function CopyField({ value }: { value: string }) {
  return (
    <input className="hub-input font-mono text-[11px]" value={value} readOnly
      onClick={e => (e.target as HTMLInputElement).select()} title="Click to select" />
  )
}

function AccountCard({ status, busy, onSave }: {
  status: DriveStatus; busy: boolean; onSave: (email: string) => void
}) {
  const [email, setEmail] = useState(status.expected_email)
  useEffect(() => { setEmail(status.expected_email) }, [status.expected_email])
  const changed = email.trim().toLowerCase() !== status.expected_email

  return (
    <div className="hub-card space-y-2">
      <h2 className="text-sm font-semibold text-foreground">The outreach Google account</h2>
      <p className="text-[12px] text-muted-foreground">
        The Drive that holds the workflow. Only this account can be connected.
      </p>
      <div className="flex items-center gap-2">
        <input className="hub-input font-mono" value={email} onChange={e => setEmail(e.target.value)} />
        <button onClick={() => onSave(email)} disabled={busy || !changed || !email.trim()}
          className="px-3 py-2 rounded-lg border border-border text-sm text-foreground hover:bg-accent disabled:opacity-40 shrink-0">
          {busy ? 'Saving…' : 'Save'}
        </button>
      </div>
      {status.connected && changed && (
        <p className="text-[11px] text-amber-700">
          Changing this does not move anything already in Drive. Reconnect afterwards with the new account.
        </p>
      )}
    </div>
  )
}

/** Step 1 — the OAuth client. Shown in full only when none is configured. */
function ClientCard({ status, busy, onSave, embedded }: {
  status: DriveStatus; busy: boolean; onSave: (id: string, secret: string) => void; embedded?: boolean
}) {
  const [id, setId] = useState('')
  const [secret, setSecret] = useState('')

  const fields = (
    <>
      <div className="grid sm:grid-cols-2 gap-3">
        <div>
          <label className="hub-label">Client ID</label>
          <input className="hub-input font-mono text-xs" value={id} onChange={e => setId(e.target.value)}
            placeholder="…apps.googleusercontent.com" autoComplete="off" spellCheck={false} />
        </div>
        <div>
          <label className="hub-label">Client secret</label>
          <input className="hub-input font-mono text-xs" type="password" value={secret}
            onChange={e => setSecret(e.target.value)} placeholder="GOCSPX-…" autoComplete="off" />
        </div>
      </div>
      <button onClick={() => onSave(id, secret)} disabled={busy || !id.trim() || !secret.trim()}
        className="px-4 py-2 rounded-lg border border-border text-sm text-foreground hover:bg-accent disabled:opacity-40">
        {busy ? 'Saving…' : embedded ? 'Replace client' : 'Save OAuth client'}
      </button>
    </>
  )
  if (embedded) return <div className="space-y-3 pt-2">{fields}</div>

  return (
    <div className="hub-card space-y-3">
      <h2 className="text-sm font-semibold text-foreground">Tell Google about this Nerve (once)</h2>
      <ol className="text-[12px] text-muted-foreground list-decimal ml-4 space-y-1.5">
        <li>
          Open <a className="text-blue-700 underline" href="https://console.cloud.google.com/apis/credentials"
            target="_blank" rel="noopener noreferrer">Google Cloud Console → Credentials</a>, signed in with a
          paruluniversity.ac.in account.
        </li>
        <li><b>APIs &amp; Services → Library</b>: enable the <b>Google Drive API</b>.</li>
        <li>
          <b>OAuth consent screen</b>: user type <b>Internal</b>. (An External app left in testing loses
          its sign-in after seven days.)
        </li>
        <li>
          <b>Create credentials → OAuth client ID</b>, type <b>Web application</b>, and add this
          <b> authorised redirect URI</b>:
          <div className="mt-1.5"><CopyField value={status.redirect_uri} /></div>
        </li>
        <li>Paste the client ID and secret below. They are stored encrypted.</li>
      </ol>
      {fields}
    </div>
  )
}

function FolderCard({ busy, accountEmail, onUse }: {
  busy: boolean; accountEmail: string | null; onUse: (folder: string) => void
}) {
  const [folder, setFolder] = useState('')
  return (
    <div className="hub-card space-y-2">
      <h2 className="text-sm font-semibold text-foreground">Use a different folder</h2>
      <p className="text-[12px] text-muted-foreground">
        Paste the link of a folder {accountEmail ?? 'the account'} can open. New uploads go there from
        then on; nothing already in Drive is moved.
      </p>
      <div className="flex items-center gap-2">
        <input className="hub-input" value={folder} onChange={e => setFolder(e.target.value)}
          placeholder="https://drive.google.com/drive/folders/…" />
        <button onClick={() => onUse(folder)} disabled={busy || !folder.trim()}
          className="px-3 py-2 rounded-lg border border-border text-sm text-foreground hover:bg-accent disabled:opacity-40 shrink-0 inline-flex items-center gap-1.5">
          <FolderOpen className="w-4 h-4" /> {busy ? 'Checking…' : 'Use folder'}
        </button>
      </div>
    </div>
  )
}
