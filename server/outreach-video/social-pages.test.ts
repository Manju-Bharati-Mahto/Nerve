// @vitest-environment node
/**
 * §8.2 / §25 — the Editor analytics restriction.
 *
 * This is the one rule in the PRD written as a security requirement rather than
 * a UI preference ("even by direct request"), so it is tested as one: the
 * question each case asks is whether a number an editor must not see could
 * reach them through the API response.
 */
import { describe, it, expect } from "vitest";
import { socialPagesForRole, isAnalyticsRestricted } from "./social-pages.js";

/** A page carrying every metric the real outreach_pages row does. */
const page = {
  id: "aapdujunagadh",
  handle: "aapdujunagadh",
  platform: "instagram",
  last_synced_at: "2026-09-13T15:37:34.398Z",
  followers: 368372,
  inventory_posts: 26,
  inventory_stories: 25,
  geography: "Gujarat",
  state: "Gujarat",
  follower_tier: "4",
  engagement_rate: 4.2,
  avg_reach: 91000,
};

describe("§25 editors and analytics", () => {
  it("treats the editor role — and only the editor role — as restricted", () => {
    expect(isAnalyticsRestricted("editor")).toBe(true);
    expect(isAnalyticsRestricted("manager")).toBe(false);
    expect(isAnalyticsRestricted("publisher")).toBe(false);
    expect(isAnalyticsRestricted("admin")).toBe(false);
  });

  it("gives an editor exactly the three fields §8.2 allows", () => {
    const { pages } = socialPagesForRole([page], "editor");
    expect(Object.keys(pages[0]).sort()).toEqual(["connected", "handle", "id", "platform"]);
  });

  it("lets no follower count, engagement or reach figure through", () => {
    const { pages, analyticsVisible } = socialPagesForRole([page], "editor");
    const serialised = JSON.stringify(pages);
    expect(analyticsVisible).toBe(false);
    for (const leak of ["368372", "engagement_rate", "avg_reach", "91000", "follower"]) {
      expect(serialised).not.toContain(leak);
    }
  });

  it("still tells the editor where content is destined for — platform, handle, connected", () => {
    const { pages } = socialPagesForRole([page], "editor");
    expect(pages[0]).toEqual({
      id: "aapdujunagadh",
      handle: "aapdujunagadh",
      platform: "instagram",
      connected: true,
    });
  });

  it("reports a never-synced page as not connected", () => {
    const { pages } = socialPagesForRole([{ ...page, last_synced_at: null }], "editor");
    expect((pages[0] as { connected: boolean }).connected).toBe(false);
  });

  it("hides a newly added metric from editors by default, because the shape is an allowlist", () => {
    // The failure mode this guards against: someone adds a metric to the page
    // model later, and a delete-the-bad-fields implementation quietly leaks it.
    const withNewMetric = { ...page, brand_new_insight_score: 99 };
    const { pages } = socialPagesForRole([withNewMetric], "editor");
    expect(JSON.stringify(pages)).not.toContain("brand_new_insight_score");
    expect(JSON.stringify(pages)).not.toContain("99");
  });

  it("passes pages through untouched for roles that may see analytics", () => {
    for (const role of ["manager", "publisher", "admin"] as const) {
      const { pages, analyticsVisible } = socialPagesForRole([page], role);
      expect(analyticsVisible).toBe(true);
      expect(pages[0]).toEqual(page);
    }
  });
});
