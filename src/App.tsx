import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter, Route, Routes, Navigate } from "react-router-dom";
import { Toaster as Sonner } from "@/components/ui/sonner";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import { AuthProvider } from "@/hooks/useAuth";
import { AppDataProvider } from "@/hooks/useAppData";
import AppLayout from "@/components/AppLayout";
import RoleGuard from "@/components/RoleGuard";

// Public
import LoginPage from "@/pages/Login";

// Shared
import BrowsePage from "@/pages/Browse";
import AddEntryPage from "@/pages/AddEntry";
import TeamPanel from "@/pages/TeamPanel";

// Super Admin
import SuperAdminDashboard from "@/pages/SuperAdminDashboard";
import SuperAdminUsers from "@/pages/SuperAdminUsers";
import SuperAdminSettings from "@/pages/SuperAdminSettings";

// Admin shared
import AdminExportPage from "@/pages/AdminExport";
import AIQueryPage from "@/pages/AIQuery";
import AINewsletterPage from "@/pages/AINewsletter";

// Branding team
import BrandingAdminDashboard from "@/pages/branding/BrandingAdminDashboard";
import BrandingSubAdminDashboard from "@/pages/branding/BrandingSubAdminDashboard";
import BrandingUserDashboard from "@/pages/branding/BrandingUserDashboard";

// Content team
import ContentAdminDashboard from "@/pages/content/ContentAdminDashboard";
import ContentSubAdminDashboard from "@/pages/content/ContentSubAdminDashboard";
import ContentUserDashboard from "@/pages/content/ContentUserDashboard";

import NotFound from "./pages/NotFound.tsx";

const queryClient = new QueryClient();

const App = () => (
  <QueryClientProvider client={queryClient}>
    <AuthProvider>
      <AppDataProvider>
        <TooltipProvider>
          <Toaster />
          <Sonner />
          <BrowserRouter>
            <Routes>
            {/* Public */}
            <Route path="/login" element={<LoginPage />} />
            <Route path="/" element={<Navigate to="/login" replace />} />

            {/* All authenticated routes */}
            <Route element={<AppLayout />}>

              {/* ── Super Admin only ── */}
              <Route path="/super-admin/dashboard" element={
                <RoleGuard allowed={['super_admin']}>
                  <SuperAdminDashboard />
                </RoleGuard>
              } />
              <Route path="/super-admin/users" element={
                <RoleGuard allowed={['super_admin']}>
                  <SuperAdminUsers />
                </RoleGuard>
              } />
              <Route path="/super-admin/settings" element={
                <RoleGuard allowed={['super_admin']}>
                  <SuperAdminSettings />
                </RoleGuard>
              } />

              {/* ── Branding team routes ── */}
              <Route path="/branding/dashboard" element={
                <RoleGuard allowed={['super_admin', 'admin']} team="branding">
                  <BrandingAdminDashboard />
                </RoleGuard>
              } />
              <Route path="/branding/sub-admin" element={
                <RoleGuard allowed={['super_admin', 'admin', 'sub_admin']} team="branding">
                  <BrandingSubAdminDashboard />
                </RoleGuard>
              } />
              <Route path="/branding/user" element={
                <RoleGuard allowed={['super_admin', 'admin', 'sub_admin', 'user']} team="branding">
                  <BrandingUserDashboard />
                </RoleGuard>
              } />
              <Route path="/branding/team" element={
                <RoleGuard allowed={['super_admin', 'admin', 'sub_admin']} team="branding">
                  <TeamPanel />
                </RoleGuard>
              } />

              {/* ── Content team routes ── */}
              <Route path="/content/dashboard" element={
                <RoleGuard allowed={['super_admin', 'admin']} team="content">
                  <ContentAdminDashboard />
                </RoleGuard>
              } />
              <Route path="/content/sub-admin" element={
                <RoleGuard allowed={['super_admin', 'admin', 'sub_admin']} team="content">
                  <ContentSubAdminDashboard />
                </RoleGuard>
              } />
              <Route path="/content/user" element={
                <RoleGuard allowed={['super_admin', 'admin', 'sub_admin', 'user']} team="content">
                  <ContentUserDashboard />
                </RoleGuard>
              } />
              <Route path="/content/team" element={
                <RoleGuard allowed={['super_admin', 'admin', 'sub_admin']} team="content">
                  <TeamPanel />
                </RoleGuard>
              } />

              {/* ── Shared admin tools ── */}
              <Route path="/admin/export" element={
                <RoleGuard allowed={['super_admin', 'admin', 'sub_admin', 'user']}>
                  <AdminExportPage />
                </RoleGuard>
              } />
              <Route path="/ai/query" element={
                <RoleGuard allowed={['super_admin', 'admin', 'sub_admin', 'user']}>
                  <AIQueryPage />
                </RoleGuard>
              } />
              <Route path="/ai/newsletter" element={
                <RoleGuard allowed={['super_admin', 'admin', 'sub_admin', 'user']}>
                  <AINewsletterPage />
                </RoleGuard>
              } />

              {/* ── Add entry — all except bare user ── */}
              <Route path="/add" element={
                <RoleGuard allowed={['super_admin', 'admin', 'sub_admin', 'user']}>
                  <AddEntryPage />
                </RoleGuard>
              } />

              {/* ── Browse — all authenticated ── */}
              <Route path="/browse" element={<BrowsePage />} />

              {/* ── Team panel (super admin sees both) ── */}
              <Route path="/team" element={
                <RoleGuard allowed={['super_admin', 'admin', 'sub_admin']}>
                  <TeamPanel />
                </RoleGuard>
              } />

              {/* Legacy redirects */}
              <Route path="/dashboard" element={<Navigate to="/super-admin/dashboard" replace />} />
              <Route path="/sub-admin/dashboard" element={<Navigate to="/" replace />} />
              <Route path="/user/dashboard" element={<Navigate to="/" replace />} />

            </Route>

            <Route path="*" element={<NotFound />} />
            </Routes>
          </BrowserRouter>
        </TooltipProvider>
      </AppDataProvider>
    </AuthProvider>
  </QueryClientProvider>
);

export default App;
