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
import LandingPage from "@/pages/LandingPage";
import ResetPasswordPage from "@/pages/ResetPassword";
import VerifyEmailPage from "@/pages/VerifyEmail";
import { useAuth, getRoleDashboard } from "@/hooks/useAuth";

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
import BrandingAdminShell, { MaybeBrandingAdminShell } from "@/pages/branding/BrandingAdminShell";
import BrandingProjectsAssign from "@/pages/branding/BrandingProjectsAssign";
import BrandingSubAdminDashboard from "@/pages/branding/BrandingSubAdminDashboard";
import BrandingUserDashboard from "@/pages/branding/BrandingUserDashboard";
import BrandingTeamPanel from "@/pages/branding/BrandingTeamPanel";
import BrandingBrowse from "@/pages/branding/BrandingBrowse";

// Media Ops (self-contained prototype, served at /media)
import MediaOps from "@/pages/media/MediaOps";

// Design team
import DesignAdminDashboard from "@/pages/design/DesignAdminDashboard";
import DesignAdminShell, { MaybeDesignAdminShell } from "@/pages/design/DesignAdminShell";
import DesignProjectsAssign from "@/pages/design/DesignProjectsAssign";
import DesignSubAdminDashboard from "@/pages/design/DesignSubAdminDashboard";
import DesignUserDashboard from "@/pages/design/DesignUserDashboard";
import DesignTeamPanel from "@/pages/design/DesignTeamPanel";
import DesignBrowse from "@/pages/design/DesignBrowse";

// Content team
import ContentAdminDashboard from "@/pages/content/ContentAdminDashboard";
import ContentSubAdminDashboard from "@/pages/content/ContentSubAdminDashboard";
import ContentUserDashboard from "@/pages/content/ContentUserDashboard";

// Outreach team
import OutreachDashboard from "@/pages/outreach/OutreachDashboard";
import OutreachCampaigns from "@/pages/outreach/OutreachCampaigns";
import OutreachCampaignDetail from "@/pages/outreach/OutreachCampaignDetail";
import OutreachCalendar from "@/pages/outreach/OutreachCalendar";
import OutreachAnalytics from "@/pages/outreach/OutreachAnalytics";
import OutreachAlerts from "@/pages/outreach/OutreachAlerts";
import OutreachAllPages from "@/pages/outreach/OutreachAllPages";
import OutreachCreators from "@/pages/outreach/OutreachCreators";
import OutreachCreatorDetail from "@/pages/outreach/OutreachCreatorDetail";
import OutreachPageDetail from "@/pages/outreach/OutreachPageDetail";
import OutreachAI from "@/pages/outreach/OutreachAI";
import VideoMyVideos from "@/pages/outreach/video/VideoMyVideos";
import VideoDetail from "@/pages/outreach/video/VideoDetail";
import VideoQueue from "@/pages/outreach/video/VideoQueue";
import VideoPublished from "@/pages/outreach/video/VideoPublished";
import VideoSocialPages from "@/pages/outreach/video/VideoSocialPages";
import VideoCalendar from "@/pages/outreach/video/VideoCalendar";
import VideoEventDetail from "@/pages/outreach/video/VideoEventDetail";
import VideoTodo from "@/pages/outreach/video/VideoTodo";
import VideoNotifications from "@/pages/outreach/video/VideoNotifications";
import VideoDashboard from "@/pages/outreach/video/VideoDashboard";
import VideoSearch from "@/pages/outreach/video/VideoSearch";
import VideoEditorLog from "@/pages/outreach/video/VideoEditorLog";
import VideoUsers from "@/pages/outreach/video/VideoUsers";
import VideoReview from "@/pages/outreach/video/VideoReview";
import VideoScheduled from "@/pages/outreach/video/VideoScheduled";
import VideoCampaigns from "@/pages/outreach/video/VideoCampaigns";
import VideoDrive from "@/pages/outreach/video/VideoDrive";
import VideoActivity from "@/pages/outreach/video/VideoActivity";

// BrandOps — the branding department's frame inventory and vendor work
import BoDashboard from "@/pages/branding/ops/BoDashboard";
import BoFrames from "@/pages/branding/ops/BoFrames";
import BoInUse from "@/pages/branding/ops/BoInUse";
import BoAllocate from "@/pages/branding/ops/BoAllocate";
import BoReturn from "@/pages/branding/ops/BoReturn";
import BoRequests from "@/pages/branding/ops/BoRequests";
import BoQuotations from "@/pages/branding/ops/BoQuotations";
import BoApprovals from "@/pages/branding/ops/BoApprovals";
import BoWorkOrders from "@/pages/branding/ops/BoWorkOrders";
import BoVisits from "@/pages/branding/ops/BoVisits";
import BoCompletion from "@/pages/branding/ops/BoCompletion";
import BoDeliveries from "@/pages/branding/ops/BoDeliveries";
import BoVendors from "@/pages/branding/ops/BoVendors";
import BoInstitutes from "@/pages/branding/ops/BoInstitutes";
import BoReports from "@/pages/branding/ops/BoReports";
import BoActivity from "@/pages/branding/ops/BoActivity";

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
            <Route path="/reset-password" element={<ResetPasswordPage />} />
            <Route path="/verify-email" element={<VerifyEmailPage />} />
            <Route path="/" element={<RootRoute />} />

            {/* ── Media Ops — full-screen self-contained app (own shell, no chrome) ── */}
            <Route path="/media" element={
              <RoleGuard allowed={['super_admin', 'admin', 'sub_admin', 'user']} team={['media', 'smc']} allowActiveCreator>
                <MediaOps />
              </RoleGuard>
            } />

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
                <RoleGuard
                  allowed={['super_admin', 'admin', 'branding_reports_admin']}
                  team="branding"
                  anyCapability={['branding:view_team_dashboard']}
                >
                  <BrandingAdminDashboard />
                </RoleGuard>
              } />
              <Route path="/branding/kra" element={
                <RoleGuard allowed={['super_admin', 'admin']} team="branding">
                  <BrandingAdminDashboard />
                </RoleGuard>
              } />
              <Route path="/branding/leaves" element={
                <RoleGuard allowed={['super_admin', 'admin']} team="branding">
                  <BrandingAdminDashboard />
                </RoleGuard>
              } />
              <Route path="/branding/leave-calendar" element={
                <RoleGuard
                  allowed={['super_admin', 'admin']}
                  team="branding"
                  anyCapability={['branding:leave_calendar']}
                >
                  <BrandingAdminDashboard />
                </RoleGuard>
              } />
              <Route path="/branding/categories" element={
                <RoleGuard
                  allowed={['super_admin', 'admin', 'branding_reports_admin']}
                  team="branding"
                  anyCapability={['branding:manage_categories']}
                >
                  <BrandingAdminDashboard />
                </RoleGuard>
              } />
              <Route path="/branding/projects" element={
                <RoleGuard
                  allowed={['super_admin', 'admin', 'task_owner', 'task_manager']}
                  team="branding"
                  anyCapability={['branding:assign_projects']}
                >
                  <BrandingAdminShell>
                    <BrandingProjectsAssign />
                  </BrandingAdminShell>
                </RoleGuard>
              } />
              <Route path="/branding/sub-admin" element={
                <RoleGuard allowed={['super_admin', 'admin', 'sub_admin', 'task_owner', 'task_manager']} team="branding">
                  <BrandingSubAdminDashboard />
                </RoleGuard>
              } />
              <Route path="/branding/user" element={
                <RoleGuard allowed={['super_admin', 'admin', 'sub_admin', 'user', 'task_owner', 'task_manager']} team="branding">
                  <BrandingUserDashboard />
                </RoleGuard>
              } />
              <Route path="/branding/team" element={
                <RoleGuard allowed={['super_admin', 'admin', 'sub_admin', 'task_owner', 'task_manager']} team="branding">
                  <MaybeBrandingAdminShell>
                    <BrandingTeamPanel />
                  </MaybeBrandingAdminShell>
                </RoleGuard>
              } />
              <Route path="/branding/browse" element={
                <RoleGuard allowed={['super_admin', 'admin', 'sub_admin', 'user', 'task_owner', 'task_manager']} team="branding">
                  <MaybeBrandingAdminShell>
                    <BrandingBrowse />
                  </MaybeBrandingAdminShell>
                </RoleGuard>
              } />

              {/* ── Design team routes ── */}
              <Route path="/design/dashboard" element={
                <RoleGuard
                  allowed={['super_admin', 'admin', 'design_reports_admin']}
                  team="design"
                  anyCapability={['design:view_team_dashboard']}
                >
                  <DesignAdminDashboard />
                </RoleGuard>
              } />
              <Route path="/design/kra" element={
                <RoleGuard allowed={['super_admin', 'admin']} team="design">
                  <DesignAdminDashboard />
                </RoleGuard>
              } />
              <Route path="/design/leaves" element={
                <RoleGuard allowed={['super_admin', 'admin']} team="design">
                  <DesignAdminDashboard />
                </RoleGuard>
              } />
              <Route path="/design/leave-calendar" element={
                <RoleGuard
                  allowed={['super_admin', 'admin']}
                  team="design"
                  anyCapability={['design:leave_calendar']}
                >
                  <DesignAdminDashboard />
                </RoleGuard>
              } />
              <Route path="/design/categories" element={
                <RoleGuard
                  allowed={['super_admin', 'admin', 'design_reports_admin']}
                  team="design"
                  anyCapability={['design:manage_categories']}
                >
                  <DesignAdminDashboard />
                </RoleGuard>
              } />
              <Route path="/design/projects" element={
                <RoleGuard
                  allowed={['super_admin', 'admin', 'task_owner', 'task_manager']}
                  team="design"
                  anyCapability={['design:assign_projects']}
                >
                  <DesignAdminShell>
                    <DesignProjectsAssign />
                  </DesignAdminShell>
                </RoleGuard>
              } />
              <Route path="/design/sub-admin" element={
                <RoleGuard allowed={['super_admin', 'admin', 'sub_admin', 'task_owner', 'task_manager']} team="design">
                  <DesignSubAdminDashboard />
                </RoleGuard>
              } />
              <Route path="/design/user" element={
                <RoleGuard allowed={['super_admin', 'admin', 'sub_admin', 'user', 'task_owner', 'task_manager']} team="design">
                  <DesignUserDashboard />
                </RoleGuard>
              } />
              <Route path="/design/team" element={
                <RoleGuard allowed={['super_admin', 'admin', 'sub_admin', 'task_owner', 'task_manager']} team="design">
                  <MaybeDesignAdminShell>
                    <DesignTeamPanel />
                  </MaybeDesignAdminShell>
                </RoleGuard>
              } />
              <Route path="/design/browse" element={
                <RoleGuard allowed={['super_admin', 'admin', 'sub_admin', 'user', 'task_owner', 'task_manager']} team="design">
                  <MaybeDesignAdminShell>
                    <DesignBrowse />
                  </MaybeDesignAdminShell>
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

              {/* ── Outreach team routes ── */}
              <Route path="/outreach/dashboard" element={
                <RoleGuard allowed={['super_admin', 'outreach_manager']} team="outreach">
                  <OutreachDashboard />
                </RoleGuard>
              } />
              <Route path="/outreach/campaigns" element={
                <RoleGuard allowed={['super_admin', 'outreach_manager']} team="outreach">
                  <OutreachCampaigns />
                </RoleGuard>
              } />
              <Route path="/outreach/campaigns/:campaignId" element={
                <RoleGuard allowed={['super_admin', 'outreach_manager']} team="outreach">
                  <OutreachCampaignDetail />
                </RoleGuard>
              } />
              <Route path="/outreach/calendar" element={
                <RoleGuard allowed={['super_admin', 'outreach_manager']} team="outreach">
                  <OutreachCalendar />
                </RoleGuard>
              } />
              <Route path="/outreach/analytics" element={
                <RoleGuard allowed={['super_admin', 'outreach_manager']} team="outreach">
                  <OutreachAnalytics />
                </RoleGuard>
              } />
              <Route path="/outreach/alerts" element={
                <RoleGuard allowed={['super_admin', 'outreach_manager']} team="outreach">
                  <OutreachAlerts />
                </RoleGuard>
              } />
              <Route path="/outreach/pages" element={
                <RoleGuard allowed={['super_admin', 'outreach_manager']} team="outreach">
                  <OutreachAllPages />
                </RoleGuard>
              } />
              <Route path="/outreach/pages/:pageId" element={
                <RoleGuard allowed={['super_admin', 'outreach_manager']} team="outreach">
                  <OutreachPageDetail />
                </RoleGuard>
              } />
              <Route path="/outreach/creators" element={
                <RoleGuard allowed={['super_admin', 'outreach_manager']} team="outreach">
                  <OutreachCreators />
                </RoleGuard>
              } />
              <Route path="/outreach/creators/:creatorId" element={
                <RoleGuard allowed={['super_admin', 'outreach_manager']} team="outreach">
                  <OutreachCreatorDetail />
                </RoleGuard>
              } />
              <Route path="/outreach/ai" element={
                <RoleGuard allowed={['super_admin', 'outreach_manager']} team="outreach">
                  <OutreachAI />
                </RoleGuard>
              } />

              {/* ── Outreach video workflow ──
                  Two ways in, and a tab opens on either. By ROLE, as before:
                  editors and publishers reach their own areas, managers and
                  super admins see everything. Or by CAPABILITY: the outreach
                  manager administers their team and switches tabs on per
                  person, so someone can be given a tab their role alone would
                  not open. The same key gates the API behind each tab — the
                  nav is a convenience, never the control. */}
              <Route path="/outreach/video/my-videos" element={
                <RoleGuard allowed={['super_admin', 'admin', 'outreach_manager', 'outreach_editor']} team="outreach"
                  anyCapability={['outreach:my_videos']}>
                  <VideoMyVideos />
                </RoleGuard>
              } />
              <Route path="/outreach/video/videos/:videoId" element={
                <RoleGuard allowed={['super_admin', 'admin', 'outreach_manager', 'outreach_editor', 'outreach_publisher']} team="outreach">
                  <VideoDetail />
                </RoleGuard>
              } />
              <Route path="/outreach/video/queue" element={
                <RoleGuard allowed={['super_admin', 'admin', 'outreach_manager', 'outreach_publisher']} team="outreach"
                  anyCapability={['outreach:queue']}>
                  <VideoQueue />
                </RoleGuard>
              } />
              <Route path="/outreach/video/published" element={
                <RoleGuard allowed={['super_admin', 'admin', 'outreach_manager', 'outreach_editor', 'outreach_publisher']} team="outreach"
                  anyCapability={['outreach:published']}>
                  <VideoPublished />
                </RoleGuard>
              } />
              {/* Every workflow role's sidebar lists this page and the API
                  serves each its own projection of it, so the guard admits
                  the publisher too — leaving them out bounced the
                  publisher's "Social Media Pages" link back to the queue. */}
              <Route path="/outreach/video/social-pages" element={
                <RoleGuard allowed={['super_admin', 'admin', 'outreach_manager', 'outreach_editor', 'outreach_publisher']} team="outreach"
                  anyCapability={['outreach:social_pages']}>
                  <VideoSocialPages />
                </RoleGuard>
              } />
              {/* §11 events: the manager keeps the calendar, the editor sees
                  only the assignments on their own To-Do List. */}
              <Route path="/outreach/video/calendar" element={
                <RoleGuard allowed={['super_admin', 'admin', 'outreach_manager']} team="outreach"
                  anyCapability={['outreach:calendar']}>
                  <VideoCalendar />
                </RoleGuard>
              } />
              <Route path="/outreach/video/todo" element={
                <RoleGuard allowed={['super_admin', 'admin', 'outreach_manager', 'outreach_editor']} team="outreach"
                  anyCapability={['outreach:todo']}>
                  <VideoTodo />
                </RoleGuard>
              } />
              <Route path="/outreach/video/events/:eventId" element={
                <RoleGuard allowed={['super_admin', 'admin', 'outreach_manager', 'outreach_editor']} team="outreach">
                  <VideoEventDetail />
                </RoleGuard>
              } />
              <Route path="/outreach/video/notifications" element={
                <RoleGuard allowed={['super_admin', 'admin', 'outreach_manager', 'outreach_editor', 'outreach_publisher']} team="outreach"
                  anyCapability={['outreach:notifications']}>
                  <VideoNotifications />
                </RoleGuard>
              } />
              {/* §20 KPIs and §4.2 user management are Manager/Admin ground;
                  §18 search is scoped per role by the API. */}
              <Route path="/outreach/video/dashboard" element={
                <RoleGuard allowed={['super_admin', 'admin', 'outreach_manager']} team="outreach"
                  anyCapability={['outreach:video_dashboard']}>
                  <VideoDashboard />
                </RoleGuard>
              } />
              <Route path="/outreach/video/all" element={
                <RoleGuard allowed={['super_admin', 'admin', 'outreach_manager', 'outreach_editor', 'outreach_publisher']} team="outreach"
                  anyCapability={['outreach:all_videos']}>
                  <VideoSearch />
                </RoleGuard>
              } />
              <Route path="/outreach/video/editor-log" element={
                <RoleGuard allowed={['super_admin', 'admin', 'outreach_manager', 'outreach_publisher']} team="outreach"
                  anyCapability={['outreach:editor_log']}>
                  <VideoEditorLog />
                </RoleGuard>
              } />
              {/* §11 review loop and §4 scheduling, and §7 campaigns. */}
              <Route path="/outreach/video/review" element={
                <RoleGuard allowed={['super_admin', 'admin', 'outreach_manager']} team="outreach"
                  anyCapability={['outreach:review']}>
                  <VideoReview />
                </RoleGuard>
              } />
              <Route path="/outreach/video/scheduled" element={
                <RoleGuard allowed={['super_admin', 'admin', 'outreach_manager', 'outreach_publisher']} team="outreach"
                  anyCapability={['outreach:scheduled']}>
                  <VideoScheduled />
                </RoleGuard>
              } />
              <Route path="/outreach/video/campaigns" element={
                <RoleGuard allowed={['super_admin', 'admin', 'outreach_manager', 'outreach_editor', 'outreach_publisher']} team="outreach"
                  anyCapability={['outreach:campaigns']}>
                  <VideoCampaigns />
                </RoleGuard>
              } />
              {/* §9 — the outreach team connects its own Google Drive here.
                  Administration, so role-only: there is no tab grant for it. */}
              <Route path="/outreach/video/drive" element={
                <RoleGuard allowed={['super_admin', 'admin', 'outreach_manager']} team="outreach">
                  <VideoDrive />
                </RoleGuard>
              } />
              <Route path="/outreach/video/users" element={
                <RoleGuard allowed={['super_admin', 'admin', 'outreach_manager']} team="outreach"
                  anyCapability={['outreach:users']}>
                  <VideoUsers />
                </RoleGuard>
              } />
              {/* §16 — every role gets an Activity view; the API scopes an
                  editor's to their own videos and assigned events. */}
              <Route path="/outreach/video/activity" element={
                <RoleGuard allowed={['super_admin', 'admin', 'outreach_manager', 'outreach_editor', 'outreach_publisher']} team="outreach"
                  anyCapability={['outreach:activity']}>
                  <VideoActivity />
                </RoleGuard>
              } />

              {/* ── BrandOps (branding inventory & vendor work) ──
                  Branding admins reach every tab by role. An Inventory Manager
                  has no role-level access and gets in only on the capability
                  their admin granted, which is the same key the API checks. */}
              <Route path="/branding/ops/dashboard" element={
                <RoleGuard allowed={['super_admin', 'admin', 'sub_admin']} team="branding"
                  anyCapability={['brandops:dashboard']}>
                  <MaybeBrandingAdminShell>
                    <BoDashboard />
                  </MaybeBrandingAdminShell>
                </RoleGuard>
              } />
              <Route path="/branding/ops/frames" element={
                <RoleGuard allowed={['super_admin', 'admin', 'sub_admin']} team="branding"
                  anyCapability={['brandops:frame_inventory']}>
                  <MaybeBrandingAdminShell>
                    <BoFrames />
                  </MaybeBrandingAdminShell>
                </RoleGuard>
              } />
              <Route path="/branding/ops/in-use" element={
                <RoleGuard allowed={['super_admin', 'admin', 'sub_admin']} team="branding"
                  anyCapability={['brandops:in_use']}>
                  <MaybeBrandingAdminShell>
                    <BoInUse />
                  </MaybeBrandingAdminShell>
                </RoleGuard>
              } />
              <Route path="/branding/ops/allocate" element={
                <RoleGuard allowed={['super_admin', 'admin', 'sub_admin']} team="branding"
                  anyCapability={['brandops:allocate']}>
                  <MaybeBrandingAdminShell>
                    <BoAllocate />
                  </MaybeBrandingAdminShell>
                </RoleGuard>
              } />
              <Route path="/branding/ops/return" element={
                <RoleGuard allowed={['super_admin', 'admin', 'sub_admin']} team="branding"
                  anyCapability={['brandops:frame_return']}>
                  <MaybeBrandingAdminShell>
                    <BoReturn />
                  </MaybeBrandingAdminShell>
                </RoleGuard>
              } />
              <Route path="/branding/ops/requests" element={
                <RoleGuard allowed={['super_admin', 'admin', 'sub_admin']} team="branding"
                  anyCapability={['brandops:requests']}>
                  <MaybeBrandingAdminShell>
                    <BoRequests />
                  </MaybeBrandingAdminShell>
                </RoleGuard>
              } />
              <Route path="/branding/ops/quotations" element={
                <RoleGuard allowed={['super_admin', 'admin', 'sub_admin']} team="branding"
                  anyCapability={['brandops:quotations']}>
                  <MaybeBrandingAdminShell>
                    <BoQuotations />
                  </MaybeBrandingAdminShell>
                </RoleGuard>
              } />
              <Route path="/branding/ops/approvals" element={
                <RoleGuard allowed={['super_admin', 'admin', 'sub_admin']} team="branding"
                  anyCapability={['brandops:approvals']}>
                  <MaybeBrandingAdminShell>
                    <BoApprovals />
                  </MaybeBrandingAdminShell>
                </RoleGuard>
              } />
              <Route path="/branding/ops/work-orders" element={
                <RoleGuard allowed={['super_admin', 'admin', 'sub_admin']} team="branding"
                  anyCapability={['brandops:work_orders']}>
                  <MaybeBrandingAdminShell>
                    <BoWorkOrders />
                  </MaybeBrandingAdminShell>
                </RoleGuard>
              } />
              <Route path="/branding/ops/visits" element={
                <RoleGuard allowed={['super_admin', 'admin', 'sub_admin']} team="branding"
                  anyCapability={['brandops:vendor_visits']}>
                  <MaybeBrandingAdminShell>
                    <BoVisits />
                  </MaybeBrandingAdminShell>
                </RoleGuard>
              } />
              <Route path="/branding/ops/completion" element={
                <RoleGuard allowed={['super_admin', 'admin', 'sub_admin']} team="branding"
                  anyCapability={['brandops:completion']}>
                  <MaybeBrandingAdminShell>
                    <BoCompletion />
                  </MaybeBrandingAdminShell>
                </RoleGuard>
              } />
              <Route path="/branding/ops/deliveries" element={
                <RoleGuard allowed={['super_admin', 'admin', 'sub_admin']} team="branding"
                  anyCapability={['brandops:material_delivery']}>
                  <MaybeBrandingAdminShell>
                    <BoDeliveries />
                  </MaybeBrandingAdminShell>
                </RoleGuard>
              } />
              <Route path="/branding/ops/vendors" element={
                <RoleGuard allowed={['super_admin', 'admin', 'sub_admin']} team="branding"
                  anyCapability={['brandops:vendors']}>
                  <MaybeBrandingAdminShell>
                    <BoVendors />
                  </MaybeBrandingAdminShell>
                </RoleGuard>
              } />
              <Route path="/branding/ops/institutes" element={
                <RoleGuard allowed={['super_admin', 'admin', 'sub_admin']} team="branding"
                  anyCapability={['brandops:institutes']}>
                  <MaybeBrandingAdminShell>
                    <BoInstitutes />
                  </MaybeBrandingAdminShell>
                </RoleGuard>
              } />
              <Route path="/branding/ops/reports" element={
                <RoleGuard allowed={['super_admin', 'admin', 'sub_admin']} team="branding"
                  anyCapability={['brandops:reports']}>
                  <MaybeBrandingAdminShell>
                    <BoReports />
                  </MaybeBrandingAdminShell>
                </RoleGuard>
              } />
              <Route path="/branding/ops/activity" element={
                <RoleGuard allowed={['super_admin', 'admin', 'sub_admin']} team="branding"
                  anyCapability={['brandops:activity']}>
                  <MaybeBrandingAdminShell>
                    <BoActivity />
                  </MaybeBrandingAdminShell>
                </RoleGuard>
              } />
              <Route path="/branding/ops" element={<Navigate to="/branding/ops/dashboard" replace />} />

              {/* ── Shared admin tools ── */}
              <Route path="/admin/export" element={
                <RoleGuard allowed={['super_admin', 'admin', 'sub_admin', 'user']}>
                  <MaybeBrandingAdminShell>
                    <AdminExportPage />
                  </MaybeBrandingAdminShell>
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

              {/* ── Add entry — all except branding team ── */}
              <Route path="/add" element={
                <RoleGuard allowed={['super_admin', 'admin', 'sub_admin', 'user']} excludeTeam="branding">
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

// Root route — logged-in users go straight to their role dashboard;
// logged-out visitors see the landing page (scroll-driven neuron
// animation + embedded login form at the end of scroll).
function RootRoute() {
  const { user, role, team, loading } = useAuth()
  if (loading) return null
  if (user && role) return <Navigate to={getRoleDashboard(role, team, user.creator)} replace />
  return <LandingPage />
}

export default App;
