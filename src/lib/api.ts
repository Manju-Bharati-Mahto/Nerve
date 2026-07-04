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
  getUserCapabilities: (id: string) =>
    request<{ capabilities: string[] }>(`/users/${id}/capabilities`),
  setUserCapabilities: (id: string, capabilities: string[]) =>
    request<{ capabilities: string[] }>(`/users/${id}/capabilities`, {
      method: "PUT",
      body: JSON.stringify({ capabilities }),
    }),
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
  getSettings: () =>
    request<{ settings: Record<string, string> }>("/settings"),
  updateSettings: (patch: Record<string, string>) =>
    request<{ ok: boolean; settings: Record<string, string> }>("/settings", {
      method: "PATCH",
      body: JSON.stringify(patch),
    }),
  updateMe: (patch: { full_name?: string; department?: string }) =>
    request<{ user: AppUser }>("/users/me", {
      method: "PATCH",
      body: JSON.stringify(patch),
    }),
  uploadAvatar: (file: File) => {
    const formData = new FormData()
    formData.append("avatar", file)
    return fetch(`${API_BASE_URL}/users/me/avatar`, {
      method: "POST",
      credentials: "include",
      body: formData,
    }).then(async r => {
      const payload = await r.json().catch(() => ({}))
      if (!r.ok) throw new Error(payload.message || "Upload failed.")
      return payload as { user: AppUser; avatar_url: string }
    })
  },
  forgotPassword: (email: string) =>
    request<{ ok: boolean }>("/auth/forgot-password", {
      method: "POST",
      body: JSON.stringify({ email }),
    }),
  resetPassword: (token: string, password: string) =>
    request<{ ok: boolean }>("/auth/reset-password", {
      method: "POST",
      body: JSON.stringify({ token, password }),
    }),
  sendVerification: (email: string) =>
    request<{ ok: boolean }>("/auth/send-verification", {
      method: "POST",
      body: JSON.stringify({ email }),
    }),
  verifyEmail: (token: string) =>
    request<{ ok: boolean }>(`/auth/verify-email?token=${token}`),

  // OTP — public (forgot password on login page)
  sendOtp: (email: string) =>
    request<{ ok: boolean }>("/auth/send-otp", {
      method: "POST",
      body: JSON.stringify({ email }),
    }),
  verifyOtp: (email: string, otp: string) =>
    request<{ ok: boolean; token: string }>("/auth/verify-otp", {
      method: "POST",
      body: JSON.stringify({ email, otp }),
    }),

  // OTP — authenticated (profile change password)
  sendChangeOtp: () =>
    request<{ ok: boolean }>("/auth/send-change-otp", { method: "POST" }),
  verifyChangeOtp: (otp: string) =>
    request<{ ok: boolean; token: string }>("/auth/verify-change-otp", {
      method: "POST",
      body: JSON.stringify({ otp }),
    }),

  // Outreach — pages
  listOutreachPages: () => request<{ pages: ServerOutreachPage[] }>("/outreach/pages"),
  createOutreachPage: (input: Partial<ServerOutreachPage>) =>
    request<{ page: ServerOutreachPage }>("/outreach/pages", {
      method: "POST",
      body: JSON.stringify(input),
    }),
  updateOutreachPage: (id: string, patch: Partial<ServerOutreachPage>) =>
    request<{ page: ServerOutreachPage }>(`/outreach/pages/${id}`, {
      method: "PATCH",
      body: JSON.stringify(patch),
    }),
  deleteOutreachPage: (id: string) =>
    request<{ ok: boolean }>(`/outreach/pages/${id}`, { method: "DELETE" }),

  // Outreach — creators (same shape as pages but a separate directory)
  listOutreachCreators: () => request<{ creators: ServerOutreachCreator[] }>("/outreach/creators"),
  createOutreachCreator: (input: Partial<ServerOutreachCreator>) =>
    request<{ creator: ServerOutreachCreator }>("/outreach/creators", {
      method: "POST",
      body: JSON.stringify(input),
    }),
  updateOutreachCreator: (id: string, patch: Partial<ServerOutreachCreator>) =>
    request<{ creator: ServerOutreachCreator }>(`/outreach/creators/${id}`, {
      method: "PATCH",
      body: JSON.stringify(patch),
    }),
  deleteOutreachCreator: (id: string) =>
    request<{ ok: boolean }>(`/outreach/creators/${id}`, { method: "DELETE" }),

  // Outreach — campaigns
  listOutreachCampaigns: () => request<{ campaigns: ServerOutreachCampaign[] }>("/outreach/campaigns"),
  createOutreachCampaign: (input: Partial<ServerOutreachCampaign>) =>
    request<{ campaign: ServerOutreachCampaign }>("/outreach/campaigns", {
      method: "POST",
      body: JSON.stringify(input),
    }),
  updateOutreachCampaign: (id: string, patch: Partial<ServerOutreachCampaign>) =>
    request<{ campaign: ServerOutreachCampaign }>(`/outreach/campaigns/${id}`, {
      method: "PATCH",
      body: JSON.stringify(patch),
    }),
  deleteOutreachCampaign: (id: string) =>
    request<{ ok: boolean }>(`/outreach/campaigns/${id}`, { method: "DELETE" }),

  // Outreach — posts
  listOutreachPosts: () => request<{ posts: ServerOutreachPost[] }>("/outreach/posts"),
  createOutreachPosts: (posts: Partial<ServerOutreachPost>[]) =>
    request<{ posts: ServerOutreachPost[] }>("/outreach/posts", {
      method: "POST",
      body: JSON.stringify({ posts }),
    }),
  deleteOutreachPost: (id: string) =>
    request<{ ok: boolean }>(`/outreach/posts/${id}`, { method: "DELETE" }),

  // Outreach — sync
  syncOutreach: (handles?: string[]) =>
    request<{
      ok: true;
      synced_pages: number;
      upserted_posts: number;
      skipped: { handle: string; reason: string }[];
      attribution: { matched: number; unmatched: number };
      refreshed_live_posts: number;
    }>("/outreach/sync", {
      method: "POST",
      body: JSON.stringify(handles ? { handles } : {}),
    }),

  // Outreach — fetch metrics for specific post / reel URLs and save under
  // either a page (campaign required) or a creator (campaign optional).
  fetchOutreachPostsByUrls: (input: {
    urls: string[];
    page_id?: string;
    creator_id?: string;
    campaign_id?: string;
    creative_variant?: string;
  }) =>
    request<{
      ok: true;
      posts: ServerOutreachPost[];
      skipped: { url: string; reason: string }[];
    }>("/outreach/posts/fetch-by-urls", {
      method: "POST",
      body: JSON.stringify(input),
    }),
};

// Server-side row shapes (snake_case). The outreach-data store maps these
// to camelCase before exposing to components.
export interface ServerOutreachPage {
  id: string;
  handle: string;
  geography: string;
  state: string;
  type: "state" | "pu";
  follower_tier: "1" | "2" | "3" | "4" | "5";
  content_types: ("static" | "reel" | "carousel")[];
  followers: number;
  inventory_posts: number;
  inventory_stories: number;
  notes: string;
  last_synced_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface ServerOutreachCreator {
  id: string;
  handle: string;
  geography: string;
  state: string;
  type: "state" | "pu";
  follower_tier: "1" | "2" | "3" | "4" | "5";
  content_types: ("static" | "reel" | "carousel")[];
  followers: number;
  inventory_posts: number;
  inventory_stories: number;
  notes: string;
  last_synced_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface ServerOutreachCampaign {
  id: string;
  name: string;
  start_date: string;
  end_date: string;
  state: string;
  goal: string;
  status: "planning" | "active" | "completed" | "paused";
  budget_posts: number;
  budget_stories: number;
  budget_reels: number;
  approvers: string[];
  creative_variants: string[];
  assigned_page_ids: string[];
  assigned_creator_ids: string[];
  created_at: string;
  updated_at: string;
}

export interface ServerOutreachPost {
  id: string;
  instagram_id: string | null;
  // A post belongs to exactly one of page_id or creator_id — never both.
  page_id: string | null;
  creator_id: string | null;
  campaign_id: string | null;
  date: string;
  type: "static" | "reel" | "story" | "carousel";
  creative_variant: string | null;
  caption: string;
  status: "draft" | "scheduled" | "pending_approval" | "published";
  likes: number;
  comments: number;
  views: number;
  saves: number;
  shares: number;
  media_url: string | null;
  permalink: string | null;
  synced_at: string | null;
  added_as_live: boolean;
}
