import type {
  AppUser,
  BrandingRowInput,
  BrandingTableRow,
  CreateEntryInput,
  CreateTeamInput,
  CreateUserInput,
  Entry,
  TeamRecord,
  UpdateUserInput,
} from "./app-types";

const API_BASE_URL = (import.meta.env.VITE_API_BASE_URL || "/api").replace(/\/$/, "");

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${API_BASE_URL}${path}`, {
    credentials: "include",
    headers: {
      "Content-Type": "application/json",
      ...(init?.headers || {}),
    },
    ...init,
  });

  const payload = await response.json().catch(() => ({}));

  if (!response.ok) {
    throw new Error(payload.message || "Request failed.");
  }

  return payload as T;
}

export const api = {
  getMe: () => request<{ user: AppUser | null }>("/auth/me"),
  login: (email: string, password: string) =>
    request<{ user: AppUser }>("/auth/login", {
      method: "POST",
      body: JSON.stringify({ email, password }),
    }),
  logout: () => request<{ ok: boolean }>("/auth/logout", { method: "POST" }),
  bootstrap: () =>
    request<{
      entries: Entry[];
      users: AppUser[];
      teams: TeamRecord[];
      brandingRows: BrandingTableRow[];
    }>("/bootstrap"),
  listEntries: () => request<{ entries: Entry[] }>("/entries"),
  createEntry: (entry: CreateEntryInput) =>
    request<{ entry: Entry }>("/entries", {
      method: "POST",
      body: JSON.stringify(entry),
    }),
  deleteEntry: (id: string) =>
    request<{ ok: boolean }>(`/entries/${id}`, { method: "DELETE" }),
  listUsers: () => request<{ users: AppUser[] }>("/users"),
  createUser: (user: CreateUserInput) =>
    request<{ user: AppUser }>("/users", {
      method: "POST",
      body: JSON.stringify(user),
    }),
  updateUser: (id: string, patch: UpdateUserInput) =>
    request<{ user: AppUser }>(`/users/${id}`, {
      method: "PATCH",
      body: JSON.stringify(patch),
    }),
  deleteUser: (id: string) =>
    request<{ ok: boolean }>(`/users/${id}`, { method: "DELETE" }),
  listTeams: () => request<{ teams: TeamRecord[] }>("/teams"),
  createTeam: (team: CreateTeamInput) =>
    request<{ team: TeamRecord }>("/teams", {
      method: "POST",
      body: JSON.stringify(team),
    }),
  deleteTeam: (id: string) =>
    request<{ ok: boolean }>(`/teams/${id}`, { method: "DELETE" }),
  listBrandingRows: () =>
    request<{ brandingRows: BrandingTableRow[] }>("/branding-rows"),
  createBrandingRow: (row: BrandingRowInput) =>
    request<{ brandingRow: BrandingTableRow }>("/branding-rows", {
      method: "POST",
      body: JSON.stringify(row),
    }),
  updateBrandingRow: (id: string, patch: BrandingRowInput) =>
    request<{ brandingRow: BrandingTableRow }>(`/branding-rows/${id}`, {
      method: "PATCH",
      body: JSON.stringify(patch),
    }),
  deleteBrandingRow: (id: string) =>
    request<{ ok: boolean }>(`/branding-rows/${id}`, { method: "DELETE" }),
};
