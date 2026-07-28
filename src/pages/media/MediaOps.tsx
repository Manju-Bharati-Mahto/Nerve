/**
 * Nerve Media Ops — mount point.
 *
 * Per the build decision (serve the prototype exactly, wire it to a real
 * backend), the Media Ops UI is the self-contained prototype served from
 * /media-ops/index.html. It owns its own full-screen shell (sidebar + topbar),
 * so we render it edge-to-edge in an iframe with no surrounding app chrome.
 *
 * The iframe is same-origin, so the session cookie flows through and the
 * prototype's data layer can call /api/v1/media/* (wired progressively, Phase 1+).
 */
export default function MediaOps() {
  return (
    <iframe
      title="Nerve Media Ops"
      src="/media-ops/index.html"
      style={{ position: 'fixed', inset: 0, width: '100vw', height: '100dvh', border: 'none' }}
      allow="clipboard-write; camera"
    />
  )
}
