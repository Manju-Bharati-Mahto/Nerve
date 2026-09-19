import { useEffect } from 'react'
import { useAuth } from '@/hooks/useAuth'
import { isActiveCreator } from '@/lib/creator-access'

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
 *
 * `?as=creator` tells the app which state endpoint to open with. A Creator
 * Network member has no Media Ops state — GET /state refuses them by design —
 * so without the hint their first load is always a failed request they then
 * recover from. The hint is a hint and nothing else: the app still asks the
 * server who they are, and every answer is re-derived there. Forging it buys
 * nothing, because /creator/state applies the same checks either way.
 */
export default function MediaOps() {
  const { profile, team } = useAuth()
  /* Media Ops staff who are ALSO enrolled on the network — an Admin holding a
     Creator Admin profile — must not get the creator-only shell: they have
     real Media Ops state and every other module besides. The hint marks the
     people for whom /state genuinely has nothing, which is exactly the people
     who are not on the media or SMC teams. */
  const creatorOnly = isActiveCreator(profile?.creator) && team !== 'media' && team !== 'smc'
  useEffect(() => {
    window.location.replace(creatorOnly ? '/api/media-ops/?as=creator' : '/api/media-ops/')
  }, [creatorOnly])
  return null
}
