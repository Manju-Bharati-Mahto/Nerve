/**
 * Nerve Media Ops — mount point.
 *
 * Per the build decision (serve the prototype exactly, wire it to a real
 * backend), the Media Ops UI is the self-contained prototype. It is served by the
 * Express API at /api/media-ops/index.html (not as an nginx static file) so it
 * rides the same /api proxy as the media endpoints and is exempt from the global
 * X-Frame-Options: DENY (served with SAMEORIGIN) — otherwise the iframe is blocked.
 * It owns its own full-screen shell (sidebar + topbar), so we render it edge-to-edge
 * with no surrounding app chrome.
 *
 * The iframe is same-origin, so the session cookie flows through and the
 * prototype's data layer calls /api/v1/media/*.
 */
export default function MediaOps() {
  return (
    <iframe
      title="Nerve Media Ops"
      src="/api/media-ops/index.html"
      style={{ position: 'fixed', inset: 0, width: '100vw', height: '100dvh', border: 'none' }}
      allow="clipboard-write; camera"
    />
  )
}
