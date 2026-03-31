import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { api } from "@/lib/api";
import { getErrorMessage } from "@/lib/error-utils";
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
} from "@/lib/app-types";
import { useAuth } from "./useAuth";

interface AppDataContextType {
  entries: Entry[];
  users: AppUser[];
  teams: TeamRecord[];
  brandingRows: BrandingTableRow[];
  loading: boolean;
  error: string;
  refreshAll: () => Promise<void>;
  addEntry: (input: CreateEntryInput) => Promise<Entry>;
  deleteEntry: (id: string) => Promise<void>;
  addUser: (input: CreateUserInput) => Promise<AppUser>;
  updateUser: (id: string, patch: UpdateUserInput) => Promise<AppUser>;
  deleteUser: (id: string) => Promise<void>;
  addTeam: (input: CreateTeamInput) => Promise<TeamRecord>;
  deleteTeam: (id: string) => Promise<void>;
  addBrandingRow: (input?: BrandingRowInput) => Promise<BrandingTableRow>;
  updateBrandingRow: (id: string, patch: BrandingRowInput) => Promise<BrandingTableRow>;
  deleteBrandingRow: (id: string) => Promise<void>;
}

const AppDataContext = createContext<AppDataContextType | null>(null);

export function AppDataProvider({ children }: { children: ReactNode }) {
  const { user } = useAuth();
  const [entries, setEntries] = useState<Entry[]>([]);
  const [users, setUsers] = useState<AppUser[]>([]);
  const [teams, setTeams] = useState<TeamRecord[]>([]);
  const [brandingRows, setBrandingRows] = useState<BrandingTableRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const refreshAll = useCallback(async () => {
    if (!user) {
      setEntries([]);
      setUsers([]);
      setTeams([]);
      setBrandingRows([]);
      setError("");
      return;
    }

    setLoading(true);
    setError("");
    try {
      const data = await api.bootstrap();
      setEntries(data.entries);
      setUsers(data.users);
      setTeams(data.teams);
      setBrandingRows(data.brandingRows);
    } catch (err: unknown) {
      setError(getErrorMessage(err, "Failed to load application data."));
    } finally {
      setLoading(false);
    }
  }, [user]);

  useEffect(() => {
    void refreshAll();
  }, [refreshAll]);

  const contextValue = useMemo<AppDataContextType>(() => ({
    entries,
    users,
    teams,
    brandingRows,
    loading,
    error,
    refreshAll,
    async addEntry(input) {
      const { entry } = await api.createEntry(input);
      setEntries((current) => [entry, ...current]);
      return entry;
    },
    async deleteEntry(id) {
      await api.deleteEntry(id);
      setEntries((current) => current.filter((entry) => entry.id !== id));
    },
    async addUser(input) {
      const { user: createdUser } = await api.createUser(input);
      setUsers((current) => [...current, createdUser]);
      return createdUser;
    },
    async updateUser(id, patch) {
      const { user: updatedUser } = await api.updateUser(id, patch);
      setUsers((current) => current.map((user) => (user.id === id ? updatedUser : user)));
      return updatedUser;
    },
    async deleteUser(id) {
      await api.deleteUser(id);
      setUsers((current) => current.filter((user) => user.id !== id));
    },
    async addTeam(input) {
      const { team } = await api.createTeam(input);
      setTeams((current) => [...current, team].sort((a, b) => a.name.localeCompare(b.name)));
      return team;
    },
    async deleteTeam(id) {
      await api.deleteTeam(id);
      setTeams((current) => current.filter((team) => team.id !== id));
      setUsers((current) =>
        current.map((user) => (user.team === id ? { ...user, team: null } : user)),
      );
    },
    async addBrandingRow(input = {}) {
      const { brandingRow } = await api.createBrandingRow(input);
      setBrandingRows((current) => [...current, brandingRow]);
      return brandingRow;
    },
    async updateBrandingRow(id, patch) {
      const { brandingRow } = await api.updateBrandingRow(id, patch);
      setBrandingRows((current) =>
        current.map((row) => (row.id === id ? brandingRow : row)),
      );
      return brandingRow;
    },
    async deleteBrandingRow(id) {
      await api.deleteBrandingRow(id);
      setBrandingRows((current) => current.filter((row) => row.id !== id));
    },
  }), [brandingRows, entries, error, loading, refreshAll, teams, users]);

  return <AppDataContext.Provider value={contextValue}>{children}</AppDataContext.Provider>;
}

export function useAppData() {
  const context = useContext(AppDataContext);
  if (!context) {
    throw new Error("useAppData must be used within AppDataProvider.");
  }
  return context;
}
