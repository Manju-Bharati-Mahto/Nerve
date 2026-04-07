# Nerve Frontend Component Inventory

**Date:** 2026-04-07T16:15:44+05:30
**Part:** Frontend SPA (`src/`)

## Overview

The frontend uses a two-layer component model:

- a small set of app-specific shell and guard components in `src/components/`
- a broad primitive library in `src/components/ui/`

Route-level composition happens mostly inside `src/pages/`, with those pages assembling primitives and provider-backed data rather than exporting many additional mid-level feature components.

## App-Specific Shared Components

### Layout and Navigation

- `AppLayout.tsx`: authenticated layout frame
- `AppSidebar.tsx`: shared navigation/sidebar chrome
- `NavLink.tsx`: route-aware navigation link wrapper

### Access Control

- `RoleGuard.tsx`: protects route elements by role and optional team restrictions

## Provider-Backed Composition Points

These are not visual components in `src/components/`, but they are the main orchestration surfaces the UI depends on:

- `AuthProvider` in `src/hooks/useAuth.tsx`
- `AppDataProvider` in `src/hooks/useAppData.tsx`

## Route-Level Screens

### Shared and Public Screens

- Login, reset password, verify email
- Browse
- Add entry
- Team panel
- AI query
- AI newsletter
- Admin export
- Not found

### Super Admin Screens

- Super admin dashboard
- Super admin users
- Super admin settings

### Branding Screens

- Branding admin dashboard
- Branding sub-admin dashboard
- Branding user dashboard
- Branding team panel
- Branding browse

### Content Screens

- Content admin dashboard
- Content sub-admin dashboard
- Content user dashboard

## Primitive UI Library (`src/components/ui`)

There are 49 primitive files in the current UI library. The most important categories are:

### Inputs and Forms

- `input.tsx`
- `textarea.tsx`
- `checkbox.tsx`
- `select.tsx`
- `radio-group.tsx`
- `switch.tsx`
- `slider.tsx`
- `input-otp.tsx`
- `form.tsx`
- `calendar.tsx`

### Buttons and Actions

- `button.tsx`
- `toggle.tsx`
- `toggle-group.tsx`
- `dropdown-menu.tsx`
- `context-menu.tsx`
- `command.tsx`

### Layout and Containers

- `card.tsx`
- `sheet.tsx`
- `drawer.tsx`
- `dialog.tsx`
- `collapsible.tsx`
- `accordion.tsx`
- `resizable.tsx`
- `scroll-area.tsx`
- `separator.tsx`
- `sidebar.tsx`

### Navigation and Structure

- `breadcrumb.tsx`
- `navigation-menu.tsx`
- `pagination.tsx`
- `tabs.tsx`
- `menubar.tsx`

### Data Display and Feedback

- `badge.tsx`
- `avatar.tsx`
- `table.tsx`
- `chart.tsx`
- `progress.tsx`
- `skeleton.tsx`
- `alert.tsx`
- `alert-dialog.tsx`
- `toast.tsx`
- `toaster.tsx`
- `sonner.tsx`
- `tooltip.tsx`
- `hover-card.tsx`

## Design System Characteristics

- Tailwind utility styling
- Radix-based accessible primitives
- Lower-case file names for primitive components
- App-specific components use PascalCase file names
- The repo favors composition over heavyweight abstraction layers

## Reuse Guidance

- Prefer `src/components/ui/*` before creating new primitive wrappers.
- Put new route-level experiences in `src/pages/` unless they are reused across multiple routes.
- Put app shell, access-control, or cross-page presentation helpers in `src/components/`.
- Keep API and auth behavior in hooks or `src/lib/api.ts`, not inside UI primitives.

## Brownfield Notes

- The page layer is more feature-heavy than the shared component layer; many business interactions live directly inside page files.
- Because the design system surface is already broad, new UI work should almost always start by checking for an existing primitive first.
- Branding features are spread across route pages rather than isolated under a separate frontend module folder.

---

_Generated using BMAD Method `document-project` workflow_
