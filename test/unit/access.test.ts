import { describe, it, expect } from "vitest";
import { AccessControl, type AccessDecision } from "../../src/access.js";

describe("AccessControl", () => {
  it("allows whitelisted open_id", () => {
    const ac = new AccessControl({
      allowedOpenIds: ["ou_alice"],
      allowedChatIds: ["oc_team"],
      unauthorizedBehavior: "ignore",
    });
    const decision: AccessDecision = ac.check("ou_alice");
    expect(decision).toEqual({ allowed: true });
  });

  it("denies non-whitelisted open_id with ignore behavior", () => {
    const ac = new AccessControl({
      allowedOpenIds: ["ou_alice"],
      allowedChatIds: ["oc_team"],
      unauthorizedBehavior: "ignore",
    });
    expect(ac.check("ou_bob")).toEqual({
      allowed: false,
      action: "ignore",
    });
  });

  it("denies non-whitelisted open_id with reject behavior", () => {
    const ac = new AccessControl({
      allowedOpenIds: ["ou_alice"],
      allowedChatIds: ["oc_team"],
      unauthorizedBehavior: "reject",
    });
    expect(ac.check("ou_bob")).toEqual({
      allowed: false,
      action: "reject",
    });
  });

  it("denies when whitelist is empty", () => {
    const ac = new AccessControl({
      allowedOpenIds: [],
      allowedChatIds: ["oc_team"],
      unauthorizedBehavior: "ignore",
    });
    expect(ac.check("ou_alice")).toEqual({
      allowed: false,
      action: "ignore",
    });
  });
});

describe("AccessControl chat allowlist (COREBYTE hardening)", () => {
  const ac = new AccessControl({
    allowedOpenIds: ["ou_alice"],
    allowedChatIds: ["oc_team", "oc_ops"],
    unauthorizedBehavior: "ignore",
  });

  it("allows listed chat ids", () => {
    expect(ac.isChatAllowed("oc_team")).toBe(true);
    expect(ac.isChatAllowed("oc_ops")).toBe(true);
  });

  it("denies unlisted chat ids", () => {
    expect(ac.isChatAllowed("oc_random")).toBe(false);
  });

  it("denies missing or empty chat ids", () => {
    expect(ac.isChatAllowed(undefined)).toBe(false);
    expect(ac.isChatAllowed("")).toBe(false);
  });

  it("chat allowlist is independent of the open_id allowlist", () => {
    expect(ac.check("ou_alice")).toEqual({ allowed: true });
    expect(ac.isChatAllowed("ou_alice")).toBe(false);
  });
});
