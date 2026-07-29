import { useEffect } from 'react'

/**
 * Nerve Media Ops — mount point.
 *
 * The Media Ops UI is the self-contained prototype served by the Express API at
 * /api/media-ops/ (a full-screen app with its own sidebar + topbar + hash routing).
 *
 * We navigate the top-level browser to it rather than embedding an <iframe>. The
 * server sets a site-wide `X-Frame-Options: DENY` (anti-clickjacking), which blocks
 * ALL framing — even same-origin — so an iframe cannot render it. A top-level
 * navigation is not framed, so that header does not apply. It's a same-origin page,
 * so the session cookie flows and the prototype's data layer calls /api/v1/media/*.
 *
 * RoleGuard on the /media route still gates access before this redirect runs.
 */
export default function MediaOps() {
  useEffect(() => {
    window.location.replace('/api/media-ops/')
  }, [])
  return null
}
