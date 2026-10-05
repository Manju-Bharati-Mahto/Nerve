/* ═══════════════════════════════════════════════════════════════════════════
   The sign-in response must describe the user the same way /auth/me does.

   WHY THIS IS A TEST AND NOT A COMMENT. The first navigation after signing in
   is decided from the login response; every navigation after it is decided
   from /auth/me. When the two disagree, the app makes one decision on landing
   and the opposite one on reload — and the only symptom is a route that
   behaves differently on the first visit than on the second.

   That is not hypothetical. `capabilities` was returned by /auth/me and not by
   /auth/login. Nothing noticed while every landing page was gated on ROLE,
   because a role arrives in both payloads. The first capability-gated landing
   page — an Inventory Manager's BrandOps dashboard — was refused on arrival,
   redirected to itself, and rendered as a white screen that a manual reload
   cleared. `creator` had already been added here once for the same reason,
   with the same reasoning in a comment; a comment did not stop the next field
   from being forgotten.

   The check is on the source rather than on a running server because
   server/index.ts starts listening and schedules automations on import, so it
   cannot be mounted in a test. The repo does this elsewhere for the same
   reason — see db-pool-safety.test.ts.
   ═══════════════════════════════════════════════════════════════════════════ */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const SRC = readFileSync("server/index.ts", "utf8");

/** The body of one express handler, from its route line to the next route. */
function handler(route: string): string {
  const start = SRC.indexOf(route);
  if (start === -1) throw new Error(`handler not found: ${route}`);
  const rest = SRC.slice(start + route.length);
  const end = rest.search(/\napp\.(get|post|put|patch|delete|use)\(/);
  return rest.slice(0, end === -1 ? undefined : end);
}

/** The keys a handler puts on the `user` object it returns. */
function userKeys(body: string): string[] {
  const m = body.match(/res\.json\(\{\s*user:\s*\{([\s\S]*?)\}\s*\}\)/);
  if (!m) throw new Error("no `res.json({ user: { … } })` in this handler");

  /* Split on the commas that separate properties — not on any inside a nested
     call or object — then read each property's name. Shorthand (`creator`)
     counts exactly like `creator: creator`, which is the whole point: the
     field that went missing was written in shorthand. */
  const parts: string[] = [];
  let depth = 0, current = "";
  for (const ch of m[1]) {
    if ("([{".includes(ch)) depth++;
    else if (")]}".includes(ch)) depth--;
    if (ch === "," && depth === 0) { parts.push(current); current = ""; continue; }
    current += ch;
  }
  parts.push(current);

  return parts
    .map(p => p.trim())
    .filter(Boolean)
    .map(p => p.startsWith("...") ? `...${p.slice(3).trim()}` : p.split(":")[0].trim())
    .sort();
}

describe("/auth/login and /auth/me describe the same user", () => {
  it("return exactly the same set of fields", () => {
    const login = userKeys(handler(`app.post("/api/auth/login"`));
    const me = userKeys(handler(`app.get("/api/auth/me"`));
    expect(login).toEqual(me);
  });

  it("includes the fields the first navigation is decided on", () => {
    const login = userKeys(handler(`app.post("/api/auth/login"`));
    /* capabilities: an Inventory Manager's landing page is gated on one.
       creator:      an active creator's landing page is decided by it.
       role/team:    arrive inside the spread user row. */
    expect(login).toContain("capabilities");
    expect(login).toContain("creator");
    expect(login).toContain("...user");
  });

  it("never returns the password hash from either", () => {
    for (const route of [`app.post("/api/auth/login"`, `app.get("/api/auth/me"`]) {
      const body = handler(route);
      expect(body).toMatch(/password_hash:\s*undefined/);
    }
  });
});
