import type { CreatorStanding } from './app-types'

/** Is this person currently a member of the Creator Network?
 *
 *  Membership is the PROFILE and its status — never the Nerve team string,
 *  never a module grant, never the Nerve role. A creator is an ordinary Nerve
 *  user (`role: 'user'`) who sits on `team: 'creator'`, and plenty of people
 *  sit on a team without being a member of anything; equally, Media Ops staff
 *  can hold a Creator Admin profile while staying on `team: 'media'`. Only the
 *  profile answers the question, which is why it is carried on the session.
 *
 *  Suspended and archived creators are NOT members. They keep every record and
 *  lose every right, so they are not sent into the network — the server refuses
 *  them at the door regardless, and this only decides where they are sent.
 *
 *  Presentation, in other words. Nothing here is a permission: every Creator
 *  Network endpoint re-derives standing server-side.
 */
export function isActiveCreator(creator: CreatorStanding | null | undefined): boolean {
  return !!creator && creator.status === 'active'
}
