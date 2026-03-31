/**
 * Local in-memory + localStorage data store.
 */

import type { AppRole } from './constants'

// ── Types ──────────────────────────────────────────────────────────────────

export interface Attachment {
  id: string
  entry_id: string
  file_name: string
  file_type: 'pdf' | 'image'
  file_size: number
}

export interface Entry {
  id: string
  title: string
  dept: string
  type: string
  body: string
  priority: string
  entry_date: string
  created_by: string | null
  tags: string[]
  author_name: string
  academic_year: string
  student_count: number | null
  external_link: string
  collaborating_org: string
  created_at: string
  attachments: Attachment[]
}

export interface Profile {
  id: string
  full_name: string
  email: string
  department: string
}

export interface TeamRecord {
  id: string        // slug, e.g. 'marketing'
  name: string      // display name, e.g. 'Marketing'
  color: string     // e.g. 'pink', 'blue', 'violet', ...
  isBuiltIn: boolean
}

export const BUILT_IN_TEAMS: TeamRecord[] = [
  { id: 'branding', name: 'Branding', color: 'pink',  isBuiltIn: true },
  { id: 'content',  name: 'Content',  color: 'blue',  isBuiltIn: true },
]

export const TEAM_COLOR_MAP: Record<string, {
  bg: string; bgRound: string; text: string; text700: string
  badge: string; headerBg: string; bar: string
}> = {
  pink:    { bg: 'bg-pink-50',    bgRound: 'bg-pink-100',    text: 'text-pink-600',    text700: 'text-pink-700',    badge: 'bg-pink-100 text-pink-700',    headerBg: 'bg-pink-50',    bar: 'bg-pink-500' },
  blue:    { bg: 'bg-blue-50',    bgRound: 'bg-blue-100',    text: 'text-blue-600',    text700: 'text-blue-700',    badge: 'bg-blue-100 text-blue-700',    headerBg: 'bg-blue-50',    bar: 'bg-blue-500' },
  violet:  { bg: 'bg-violet-50',  bgRound: 'bg-violet-100',  text: 'text-violet-600',  text700: 'text-violet-700',  badge: 'bg-violet-100 text-violet-700', headerBg: 'bg-violet-50',  bar: 'bg-violet-500' },
  amber:   { bg: 'bg-amber-50',   bgRound: 'bg-amber-100',   text: 'text-amber-600',   text700: 'text-amber-700',   badge: 'bg-amber-100 text-amber-700',   headerBg: 'bg-amber-50',   bar: 'bg-amber-500' },
  rose:    { bg: 'bg-rose-50',    bgRound: 'bg-rose-100',    text: 'text-rose-600',    text700: 'text-rose-700',    badge: 'bg-rose-100 text-rose-700',    headerBg: 'bg-rose-50',    bar: 'bg-rose-500' },
  emerald: { bg: 'bg-emerald-50', bgRound: 'bg-emerald-100', text: 'text-emerald-600', text700: 'text-emerald-700', badge: 'bg-emerald-100 text-emerald-700', headerBg: 'bg-emerald-50', bar: 'bg-emerald-500' },
  orange:  { bg: 'bg-orange-50',  bgRound: 'bg-orange-100',  text: 'text-orange-600',  text700: 'text-orange-700',  badge: 'bg-orange-100 text-orange-700', headerBg: 'bg-orange-50',  bar: 'bg-orange-500' },
  cyan:    { bg: 'bg-cyan-50',    bgRound: 'bg-cyan-100',    text: 'text-cyan-600',    text700: 'text-cyan-700',    badge: 'bg-cyan-100 text-cyan-700',    headerBg: 'bg-cyan-50',    bar: 'bg-cyan-500' },
}

export const FALLBACK_COLOR = TEAM_COLOR_MAP.violet

export interface UserRecord extends Profile {
  role: AppRole
  team: string | null       // null for super_admin; 'branding', 'content', or custom team id
  managed_by: string | null // team lead (sub_admin) ID for members; null for everyone else
}

// ── Seed users (one per role×team combination) ─────────────────────────────

export const SEED_USERS: UserRecord[] = [
  { id: 'sa-001', full_name: 'Super Admin',
    email: 'super@parul.ac.in',
    department: 'University-Wide', role: 'super_admin', team: null,       managed_by: null },
  { id: 'ba-001', full_name: 'Branding Admin',
    email: 'brand-admin@parul.ac.in',
    department: 'University-Wide', role: 'admin',       team: 'branding', managed_by: null },
  { id: 'ca-001', full_name: 'Content Admin',
    email: 'content-admin@parul.ac.in',
    department: 'University-Wide', role: 'admin',       team: 'content',  managed_by: null },
  { id: 'bs-001', full_name: 'Branding Lead',
    email: 'brand-lead@parul.ac.in',
    department: 'Engineering',     role: 'sub_admin',   team: 'branding', managed_by: null },
  { id: 'cs-001', full_name: 'Content Lead',
    email: 'content-lead@parul.ac.in',
    department: 'Engineering',     role: 'sub_admin',   team: 'content',  managed_by: null },
  { id: 'bu-001', full_name: 'Branding User',
    email: 'brand-user@parul.ac.in',
    department: 'Design',          role: 'user',        team: 'branding', managed_by: 'bs-001' },
  { id: 'cu-001', full_name: 'Content User',
    email: 'content-user@parul.ac.in',
    department: 'Sciences',        role: 'user',        team: 'content',  managed_by: 'cs-001' },
]

// ── Seed entries ───────────────────────────────────────────────────────────

const SEED_ENTRIES: Entry[] = [
  // Branding entries
  {
    id: 'e-001', title: 'International MOU with TU Delft for AI Research',
    dept: 'Engineering', type: 'MOU / Partnership', priority: 'Key highlight',
    entry_date: '2026-03-10', created_by: 'ba-001', tags: ['mou', 'ai', 'international'],
    author_name: 'Dr. Rajesh Kumar', academic_year: '2025-26', student_count: null,
    external_link: '', collaborating_org: 'TU Delft, Netherlands',
    body: 'Parul University signed an MOU with TU Delft, Netherlands for collaborative AI research, student exchange programs, and joint publications. The agreement covers a 5-year period and includes funding for 10 PhD scholars.',
    created_at: '2026-03-10T08:00:00Z', attachments: [],
  },
  {
    id: 'e-002', title: 'Engineering Department Achieves 95% Placement Rate',
    dept: 'Engineering', type: 'Placement', priority: 'Key highlight',
    entry_date: '2026-03-05', created_by: 'ba-001', tags: ['placement', 'engineering'],
    author_name: 'Prof. Anjali Shah', academic_year: '2025-26', student_count: 420,
    external_link: '', collaborating_org: '',
    body: 'The Engineering department has achieved a record 95% placement rate for the batch of 2026, with students placed at top companies including Google, Microsoft, Infosys, and TCS. Average package stands at ₹8.5 LPA.',
    created_at: '2026-03-05T10:00:00Z', attachments: [],
  },
  {
    id: 'e-006', title: 'Architecture Students Win National Design Competition',
    dept: 'Architecture', type: 'Achievement', priority: 'Key highlight',
    entry_date: '2026-02-01', created_by: 'bs-001', tags: ['award', 'design', 'students'],
    author_name: 'Prof. Amit Desai', academic_year: '2025-26', student_count: 5,
    external_link: '', collaborating_org: 'Council of Architecture India',
    body: 'A team of 5 Architecture students won the National Design Competition organized by the Council of Architecture India. Their project "Green Vertical Cities" was selected from over 300 entries across 80 institutions.',
    created_at: '2026-02-01T14:00:00Z', attachments: [],
  },
  {
    id: 'e-007', title: 'Annual Founders Day Celebration',
    dept: 'University-Wide', type: 'Event', priority: 'High',
    entry_date: '2026-01-25', created_by: 'bu-001', tags: ['event', 'founders day'],
    author_name: 'Communications Team', academic_year: '2025-26', student_count: 5000,
    external_link: '', collaborating_org: '',
    body: 'Parul University celebrated its Annual Founders Day with a grand ceremony attended by over 5,000 students, faculty, and alumni. The event featured felicitation of top performers, cultural performances, and an address by the Chancellor.',
    created_at: '2026-01-25T08:00:00Z', attachments: [],
  },
  {
    id: 'e-010', title: 'Design Department Partners with Adobe for Creative Suite',
    dept: 'Design', type: 'MOU / Partnership', priority: 'Normal',
    entry_date: '2026-01-10', created_by: 'ba-001', tags: ['adobe', 'software', 'design'],
    author_name: 'Prof. Neha Gupta', academic_year: '2025-26', student_count: 200,
    external_link: '', collaborating_org: 'Adobe Inc.',
    body: 'Parul University\'s Design Department has partnered with Adobe to provide all 200 design students with free access to the full Adobe Creative Suite including Photoshop, Illustrator, Premiere Pro, and After Effects for their entire academic tenure.',
    created_at: '2026-01-10T11:00:00Z', attachments: [],
  },
  {
    id: 'e-008', title: 'Medical College Gets NABH Accreditation',
    dept: 'Medical', type: 'Achievement', priority: 'Key highlight',
    entry_date: '2026-01-20', created_by: 'ba-001', tags: ['accreditation', 'nabh'],
    author_name: 'Dr. Vikram Singh', academic_year: '2025-26', student_count: null,
    external_link: '', collaborating_org: 'National Accreditation Board for Hospitals',
    body: 'Parul Institute of Medical Sciences and Research has been granted NABH accreditation, recognizing excellence in patient care, infrastructure, and clinical outcomes. This makes it one of only 3 private medical colleges in Gujarat with this distinction.',
    created_at: '2026-01-20T10:00:00Z', attachments: [],
  },
  // Content entries
  {
    id: 'e-003', title: 'Physiotherapy Research Published in Nature Medicine',
    dept: 'Physiotherapy', type: 'Research', priority: 'Key highlight',
    entry_date: '2026-02-20', created_by: 'ca-001', tags: ['research', 'publication'],
    author_name: 'Dr. Meena Patel', academic_year: '2025-26', student_count: null,
    external_link: '', collaborating_org: 'AIIMS Delhi',
    body: 'The Department of Physiotherapy published a landmark research paper on non-invasive neural stimulation for stroke rehabilitation in Nature Medicine, a Q1 journal with impact factor 87.2.',
    created_at: '2026-02-20T09:00:00Z', attachments: [],
  },
  {
    id: 'e-004', title: 'New Pharmaceutical Simulation Lab Inaugurated',
    dept: 'Pharmacy', type: 'Program update', priority: 'High',
    entry_date: '2026-02-15', created_by: 'cs-001', tags: ['lab', 'program'],
    author_name: 'Dr. Suresh Joshi', academic_year: '2025-26', student_count: null,
    external_link: '', collaborating_org: '',
    body: 'A new pharmaceutical simulation lab has been added to the Pharmacy curriculum. The lab features advanced drug synthesis simulation software, HPLC systems, and analytical instruments, benefiting over 800 pharmacy students.',
    created_at: '2026-02-15T11:00:00Z', attachments: [],
  },
  {
    id: 'e-005', title: 'MBA Entrepreneurship Track Launched',
    dept: 'Management', type: 'Program update', priority: 'Normal',
    entry_date: '2026-02-10', created_by: 'ca-001', tags: ['mba', 'entrepreneurship'],
    author_name: 'Prof. Kavita Rao', academic_year: '2025-26', student_count: 60,
    external_link: '', collaborating_org: 'Gujarat Startup Ecosystem',
    body: 'The Management Department has launched a specialized MBA track in Entrepreneurship in collaboration with the Gujarat Startup Ecosystem. The track includes mentorship from 20 industry leaders and a seed fund of ₹5 lakh for top projects.',
    created_at: '2026-02-10T09:00:00Z', attachments: [],
  },
  {
    id: 'e-009', title: 'Law School Moot Court Team Reaches International Finals',
    dept: 'Law', type: 'Student activity', priority: 'High',
    entry_date: '2026-01-15', created_by: 'cu-001', tags: ['moot', 'law', 'students'],
    author_name: 'Prof. Priya Nair', academic_year: '2025-26', student_count: 4,
    external_link: '', collaborating_org: '',
    body: 'The Parul Law School moot court team has qualified for the Philip C. Jessup International Law Moot Court Competition finals to be held in Washington DC. The team defeated 12 other law schools in the national rounds.',
    created_at: '2026-01-15T13:00:00Z', attachments: [],
  },
  {
    id: 'e-011', title: 'Annual Science Fair Draws Record Participation',
    dept: 'Sciences', type: 'Student activity', priority: 'Normal',
    entry_date: '2025-12-15', created_by: 'cu-001', tags: ['science', 'fair'],
    author_name: 'Dr. Anil Mehta', academic_year: '2025-26', student_count: 600,
    external_link: '', collaborating_org: '',
    body: 'The Annual Science Fair 2025 saw record participation with 600 students presenting 180 projects across Biology, Chemistry, Physics, and Environmental Sciences.',
    created_at: '2025-12-15T09:00:00Z', attachments: [],
  },
  {
    id: 'e-012', title: 'University Ranks in Top 100 NIRF 2025',
    dept: 'University-Wide', type: 'General update', priority: 'Key highlight',
    entry_date: '2025-12-01', created_by: 'ca-001', tags: ['nirf', 'ranking'],
    author_name: 'Vice Chancellor Office', academic_year: '2025-26', student_count: null,
    external_link: '', collaborating_org: '',
    body: 'Parul University has been ranked among the top 100 universities in India in the NIRF Rankings 2025, improving its position by 18 places from last year.',
    created_at: '2025-12-01T12:00:00Z', attachments: [],
  },
]

// ── localStorage helpers ───────────────────────────────────────────────────

export interface BrandingTableRow {
  id: string
  category: string       // dropdown — BRANDING_TYPES
  sub_category: string   // dropdown — DEPARTMENTS
  time_taken: string     // dropdown — TIME_OPTIONS
  team_member: string    // dropdown — branding team members
  project_name: string   // text
  additional_info: string// text
}

const KEYS = { entries: 'pu_entries', users: 'pu_users', teams: 'pu_teams', brandingRows: 'pu_branding_rows' }

function loadEntries(): Entry[] {
  try {
    const raw = localStorage.getItem(KEYS.entries)
    return raw ? JSON.parse(raw) : SEED_ENTRIES
  } catch { return SEED_ENTRIES }
}

function saveEntries(entries: Entry[]) {
  localStorage.setItem(KEYS.entries, JSON.stringify(entries))
}

function loadUsers(): UserRecord[] {
  try {
    const raw = localStorage.getItem(KEYS.users)
    if (!raw) return SEED_USERS
    const parsed: Array<UserRecord & { password?: string }> = JSON.parse(raw)
    return parsed.map(({ password: _password, ...u }) => ({
      ...u,
      team:       'team'       in u ? u.team       : null,
      managed_by: 'managed_by' in u ? u.managed_by : null,
    }))
  } catch { return SEED_USERS }
}

function saveUsers(users: UserRecord[]) {
  localStorage.setItem(KEYS.users, JSON.stringify(users))
}

function loadCustomTeams(): TeamRecord[] {
  try {
    const raw = localStorage.getItem(KEYS.teams)
    return raw ? JSON.parse(raw) : []
  } catch { return [] }
}

function saveCustomTeams(teams: TeamRecord[]) {
  localStorage.setItem(KEYS.teams, JSON.stringify(teams))
}

function loadBrandingRows(): BrandingTableRow[] {
  try {
    const raw = localStorage.getItem(KEYS.brandingRows)
    return raw ? JSON.parse(raw) : []
  } catch { return [] }
}

function saveBrandingRows(rows: BrandingTableRow[]) {
  localStorage.setItem(KEYS.brandingRows, JSON.stringify(rows))
}

// ── Public API ─────────────────────────────────────────────────────────────

export const db = {
  entries: {
    getAll(): Entry[] {
      return loadEntries().sort(
        (a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
      )
    },

    insert(data: Omit<Entry, 'id' | 'created_at' | 'attachments'>): Entry {
      const entries = loadEntries()
      const entry: Entry = {
        ...data,
        id: `e-${Date.now()}`,
        created_at: new Date().toISOString(),
        attachments: [],
      }
      entries.push(entry)
      saveEntries(entries)
      return entry
    },

    delete(id: string) {
      saveEntries(loadEntries().filter(e => e.id !== id))
    },
  },

  users: {
    getAll(): UserRecord[] {
      return loadUsers()
    },

    findByEmail(email: string): UserRecord | undefined {
      return loadUsers().find(u => u.email.toLowerCase() === email.toLowerCase())
    },

    findById(id: string): UserRecord | undefined {
      return loadUsers().find(u => u.id === id)
    },

    insert(data: Omit<UserRecord, 'id'>): UserRecord {
      const users = loadUsers()
      const newUser: UserRecord = { ...data, id: `u-${Date.now()}` }
      users.push(newUser)
      saveUsers(users)
      return newUser
    },

    updateRoleAndTeam(userId: string, role: AppRole, team: string | null) {
      saveUsers(loadUsers().map(u => u.id === userId ? { ...u, role, team } : u))
    },
  },

  brandingTable: {
    getAll(): BrandingTableRow[] {
      return loadBrandingRows()
    },
    save(rows: BrandingTableRow[]) {
      saveBrandingRows(rows)
    },
  },

  teams: {
    getAll(): TeamRecord[] {
      return [...BUILT_IN_TEAMS, ...loadCustomTeams()]
    },

    insert(name: string, color: string): TeamRecord {
      const custom = loadCustomTeams()
      const id = name.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '')
      const team: TeamRecord = { id, name, color, isBuiltIn: false }
      custom.push(team)
      saveCustomTeams(custom)
      return team
    },

    delete(id: string) {
      saveCustomTeams(loadCustomTeams().filter(t => t.id !== id))
    },
  },
}
