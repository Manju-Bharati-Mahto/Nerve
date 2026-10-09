// @vitest-environment node
import { describe, expect, it } from "vitest";
import { handleKey, normalisePageHandle, normalisePageLink } from "./outreach-page-edit.js";

const handle = (platform: "instagram" | "facebook", raw: string) => {
  const r = normalisePageHandle(platform, raw);
  return r.ok ? r.handle : null;
};
const link = (platform: "instagram" | "facebook", raw: string) => {
  const r = normalisePageLink(platform, raw);
  return r.ok ? r.link : null;
};

describe("normalisePageHandle", () => {
  it("takes a bare name, an @name or a pasted profile URL", () => {
    expect(handle("instagram", "newname")).toBe("newname");
    expect(handle("instagram", "  @new.name_1 ")).toBe("new.name_1");
    expect(handle("instagram", "https://www.instagram.com/newname/?hl=en")).toBe("newname");
    expect(handle("instagram", "instagram.com/newname")).toBe("newname");
    expect(handle("facebook", "https://m.facebook.com/My.City-Page/")).toBe("My.City-Page");
    expect(handle("facebook", "fb.com/mycity")).toBe("mycity");
  });

  it("refuses what the sync could never find, instead of cutting it down", () => {
    // The client's parser turned "my page" into "my" — a different account.
    expect(handle("instagram", "my page")).toBeNull();
    expect(handle("instagram", "a".repeat(31))).toBeNull();
    expect(handle("instagram", "")).toBeNull();
    expect(handle("instagram", "   ")).toBeNull();
    expect(handle("instagram", "name/with/slash")).toBeNull();
    expect(handle("facebook", "my page")).toBeNull();
  });

  it("refuses a post link or numeric profile pasted as the page", () => {
    expect(handle("instagram", "https://www.instagram.com/p/C0abc123/")).toBeNull();
    expect(handle("instagram", "https://www.instagram.com/reel/C0abc123/")).toBeNull();
    expect(handle("facebook", "https://www.facebook.com/profile.php?id=1000123")).toBeNull();
    expect(normalisePageHandle("facebook", "https://www.facebook.com/profile.php?id=1").ok).toBe(false);
  });

  it("does not read the other platform's URL as a handle", () => {
    expect(handle("instagram", "https://www.facebook.com/mycity")).toBeNull();
  });
});

describe("normalisePageLink", () => {
  it("clears with ''", () => {
    expect(link("instagram", "")).toBe("");
    expect(link("facebook", "   ")).toBe("");
  });

  it("accepts an http(s) link on the page's own platform", () => {
    expect(link("instagram", "https://www.instagram.com/x/")).toBe("https://www.instagram.com/x/");
    expect(link("instagram", "http://instagram.com/x")).toBe("http://instagram.com/x");
    expect(link("instagram", "instagram.com/x")).toBe("https://instagram.com/x");
    expect(link("facebook", "https://www.facebook.com/mycity")).toBe("https://www.facebook.com/mycity");
    expect(link("facebook", "https://m.facebook.com/mycity")).toBe("https://m.facebook.com/mycity");
    expect(link("facebook", "https://fb.com/mycity")).toBe("https://fb.com/mycity");
  });

  it("refuses another scheme, plain text, another platform or another site", () => {
    expect(link("instagram", "ftp://instagram.com/x")).toBeNull();
    expect(link("instagram", "javascript:alert(1)")).toBeNull();
    expect(link("instagram", "not a url")).toBeNull();
    expect(link("instagram", "https://facebook.com/x")).toBeNull();
    expect(link("facebook", "https://www.instagram.com/x/")).toBeNull();
    expect(link("instagram", "https://instagram.com.evil.example/x")).toBeNull();
    expect(link("instagram", "https://notinstagram.com/x")).toBeNull();
  });

  it("refuses the bare site, which is not a page", () => {
    expect(link("instagram", "https://www.instagram.com/")).toBeNull();
    expect(link("facebook", "facebook.com")).toBeNull();
  });

  it("says which platform's link it wanted", () => {
    const r = normalisePageLink("instagram", "https://facebook.com/x");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.problem).toMatch(/Instagram link/);
  });
});

describe("handleKey", () => {
  it("ignores case and a leading @", () => {
    expect(handleKey("@AmazingDwarka")).toBe(handleKey("amazingdwarka"));
  });
});
