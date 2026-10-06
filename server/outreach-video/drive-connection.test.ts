// @vitest-environment node
/**
 * When reconnecting the outreach Drive may revoke the token it replaces.
 *
 * Google's revoke withdraws the whole grant — this account, this OAuth
 * client — not one token. Reconnecting with the same account through the same
 * client lands on that same grant, so revoking the "old" token killed the new
 * one too: the reconnect said "connected" and the very next request failed
 * with invalid_grant. The rule: revoke only a token known to belong to a
 * different grant.
 */
import { describe, expect, it } from "vitest";
import { shouldRevokePrevious } from "./drive-connection.js";

const CLIENT = "nerve.apps.googleusercontent.com";

describe("revoking the previous token on reconnect", () => {
  it("never revokes the same account through the same client", () => {
    expect(shouldRevokePrevious({ email: "outreach@pu.ac.in", clientId: CLIENT }, { email: "outreach@pu.ac.in", clientId: CLIENT })).toBe(false);
    // Case and whitespace are not a different account.
    expect(shouldRevokePrevious({ email: " Outreach@PU.ac.in ", clientId: CLIENT }, { email: "outreach@pu.ac.in", clientId: CLIENT })).toBe(false);
  });
  it("revokes when the account changed", () => {
    expect(shouldRevokePrevious({ email: "old@pu.ac.in", clientId: CLIENT }, { email: "outreach@pu.ac.in", clientId: CLIENT })).toBe(true);
  });
  it("revokes when the OAuth client changed", () => {
    expect(shouldRevokePrevious({ email: "outreach@pu.ac.in", clientId: "old.apps.googleusercontent.com" }, { email: "outreach@pu.ac.in", clientId: CLIENT })).toBe(true);
  });
  it("leaves a token alone when it cannot tell (a row from before the client was recorded)", () => {
    expect(shouldRevokePrevious({ email: "outreach@pu.ac.in", clientId: null }, { email: "outreach@pu.ac.in", clientId: CLIENT })).toBe(false);
    expect(shouldRevokePrevious({ email: null, clientId: null }, { email: "outreach@pu.ac.in", clientId: CLIENT })).toBe(false);
  });
});
