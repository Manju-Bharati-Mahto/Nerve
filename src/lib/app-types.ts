import type { AppRole, AppTeam } from "./constants";

export interface Attachment {
  id: string;
  entry_id: string;
  file_name: string;
  file_type: "pdf" | "image";
  file_size: number;
}

export interface Entry {
  id: string;
  title: string;
  dept: string;
  type: string;
  body: string;
  priority: "Normal" | "High" | "Key highlight";
  entry_date: string;
  created_by: string | null;
  tags: string[];
  author_name: string;
  academic_year: string;
  student_count: number | null;
  external_link: string;
  collaborating_org: string;
  created_at: string;
  attachments: Attachment[];
}

export interface TeamRecord {
  id: string;
  name: string;
  color: string;
  isBuiltIn: boolean;
}

export interface BrandingTableRow {
  id: string;
  category: string;
  sub_category: string;
  time_taken: string;
  team_member: string;
  project_name: string;
  additional_info: string;
  created_at: string;
  updated_at: string;
}

export interface AppUser {
  id: string;
  full_name: string;
  email: string;
  department: string;
  role: AppRole;
  team: AppTeam | null;
  managed_by: string | null;
  created_at: string;
  updated_at: string;
}

export interface CreateEntryInput {
  title: string;
  dept: string;
  type: string;
  body: string;
  priority: "Normal" | "High" | "Key highlight";
  entry_date: string;
  created_by: string | null;
  tags: string[];
  author_name: string;
  academic_year: string;
  student_count: number | null;
  external_link: string;
  collaborating_org: string;
}

export interface CreateUserInput {
  full_name: string;
  email: string;
  password: string;
  department: string;
  role: AppRole;
  team: string | null;
  managed_by: string | null;
}

export interface UpdateUserInput {
  full_name?: string;
  email?: string;
  password?: string;
  department?: string;
  role?: AppRole;
  team?: string | null;
  managed_by?: string | null;
}

export interface CreateTeamInput {
  name: string;
  color: string;
}

export interface BrandingRowInput {
  category?: string;
  sub_category?: string;
  time_taken?: string;
  team_member?: string;
  project_name?: string;
  additional_info?: string;
}
