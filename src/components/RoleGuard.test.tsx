/* ═══════════════════════════════════════════════════════════════════════════
   RoleGuard — refusing access must never send someone back to the page that
   refused them.

   WHY THIS FILE EXISTS. The guard answers a refusal by redirecting to the
   person's own landing page. That is right as long as the landing page admits
   them, and every role-gated home does. A CAPABILITY-gated home does not: an
   Inventory Manager lands on the BrandOps dashboard, which is itself behind
   `brandops:dashboard`, so an account with no tabs ticked was refused, sent to
   the dashboard, refused again, and so on. The browser renders that as a white
   screen — no error, no content, nothing in the console.

   The member dialog allows creating exactly that account on purpose ("an
   Inventory Manager with nothing ticked here can sign in but has no modules"),
   so this is a state the product intends, not a state to make unreachable.
   ═══════════════════════════════════════════════════════════════════════════ */
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter, Route, Routes } from "react-router-dom";

/* The guard reads identity from useAuth and nothing else, so the whole matrix
   below is expressible by swapping one mocked return value. */
let AUTH: Record<string, unknown> = {};
vi.mock("@/hooks/useAuth", async () => {
  const actual = await vi.importActual<typeof import("@/hooks/useAuth")>("@/hooks/useAuth");
  return { ...actual, useAuth: () => AUTH };
});

import RoleGuard from "./RoleGuard";

afterEach(cleanup);

function mount(path: string, element: React.ReactNode) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path={path} element={element} />
        <Route path="/branding/user" element={<p>branding member home</p>} />
        <Route path="/branding/dashboard" element={<p>branding admin home</p>} />
        <Route path="/dashboard" element={<p>generic home</p>} />
      </Routes>
    </MemoryRouter>,
  );
}

const opsDashboard = (children: React.ReactNode) => (
  <RoleGuard allowed={["super_admin", "admin", "sub_admin"]} team="branding"
    anyCapability={["brandops:dashboard"]}>
    {children}
  </RoleGuard>
);

describe("an Inventory Manager with no tabs granted", () => {
  it("is told so, instead of being redirected to the page that just refused them", () => {
    AUTH = { role: "inventory_manager", team: "branding", loading: false,
             profile: { capabilities: [] } };
    mount("/branding/ops/dashboard", opsDashboard(<p>BrandOps dashboard</p>));

    expect(screen.queryByText("BrandOps dashboard")).toBeNull();
    expect(screen.getByText(/No modules yet/i)).toBeTruthy();
    expect(screen.getByText(/Ask your team admin/i)).toBeTruthy();
  });

  it("sees their granted tab normally once one is ticked", () => {
    AUTH = { role: "inventory_manager", team: "branding", loading: false,
             profile: { capabilities: ["brandops:dashboard"] } };
    mount("/branding/ops/dashboard", opsDashboard(<p>BrandOps dashboard</p>));

    expect(screen.getByText("BrandOps dashboard")).toBeTruthy();
    expect(screen.queryByText(/No modules yet/i)).toBeNull();
  });

  it("is still refused a tab they were not granted", () => {
    AUTH = { role: "inventory_manager", team: "branding", loading: false,
             profile: { capabilities: ["brandops:dashboard"] } };
    render(
      <MemoryRouter initialEntries={["/branding/ops/vendors"]}>
        <Routes>
          <Route path="/branding/ops/vendors" element={
            <RoleGuard allowed={["super_admin", "admin", "sub_admin"]} team="branding"
              anyCapability={["brandops:vendors"]}>
              <p>vendors</p>
            </RoleGuard>
          } />
          <Route path="/branding/ops/dashboard" element={<p>sent to their own dashboard</p>} />
        </Routes>
      </MemoryRouter>,
    );

    expect(screen.queryByText("vendors")).toBeNull();
    expect(screen.getByText("sent to their own dashboard")).toBeTruthy();
  });
});

describe("the refusal path for everyone else is unchanged", () => {
  it("still redirects a branding member away from a tab they lack", () => {
    AUTH = { role: "user", team: "branding", loading: false, profile: { capabilities: [] } };
    mount("/branding/ops/dashboard", opsDashboard(<p>BrandOps dashboard</p>));

    expect(screen.queryByText("BrandOps dashboard")).toBeNull();
    expect(screen.getByText("branding member home")).toBeTruthy();
  });

  it("admits a branding admin on role alone, with no capability granted", () => {
    AUTH = { role: "admin", team: "branding", loading: false, profile: { capabilities: [] } };
    mount("/branding/ops/dashboard", opsDashboard(<p>BrandOps dashboard</p>));

    expect(screen.getByText("BrandOps dashboard")).toBeTruthy();
  });

  it("renders nothing while identity is still loading, rather than guessing", () => {
    AUTH = { role: null, team: null, loading: true, profile: null };
    const { container } = mount("/branding/ops/dashboard", opsDashboard(<p>BrandOps dashboard</p>));

    expect(container.textContent).toBe("");
  });
});
