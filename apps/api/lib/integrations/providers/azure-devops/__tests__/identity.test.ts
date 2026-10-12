import { describe, expect, it } from "vitest";
import {
  BOT,
  botAccount,
  HUMAN,
  identityRef,
  identityString,
  revisedBy,
} from "@/lib/integrations/providers/azure-devops/__tests__/azure-devops.test-fixtures";
import {
  adoIdentityActor,
  adoIdentityLabel,
  isAdoBotIdentity,
  parseAdoIdentity,
} from "@/lib/integrations/providers/azure-devops/identity";

describe("parseAdoIdentity", () => {
  it("reads an IdentityRef object", () => {
    expect(parseAdoIdentity(identityRef(HUMAN))).toEqual({
      id: HUMAN.id,
      uniqueName: HUMAN.uniqueName,
      displayName: HUMAN.displayName,
      descriptor: HUMAN.descriptor,
    });
  });

  it("splits a 'Display Name <email>' string", () => {
    expect(parseAdoIdentity(identityString(HUMAN))).toEqual({
      id: null,
      uniqueName: HUMAN.uniqueName,
      displayName: HUMAN.displayName,
      descriptor: null,
    });
  });

  it("recognises a bare email, a DOMAIN\\user name and a GUID", () => {
    expect(parseAdoIdentity(" jamal@contoso.com ")?.uniqueName).toBe(
      "jamal@contoso.com"
    );
    expect(parseAdoIdentity(String.raw`CONTOSO\jamal`)?.uniqueName).toBe(
      String.raw`CONTOSO\jamal`
    );
    expect(parseAdoIdentity(HUMAN.id)?.id).toBe(HUMAN.id);
  });

  it("treats any other string as a display name only", () => {
    expect(parseAdoIdentity("Jamal Hartnett")).toEqual({
      id: null,
      uniqueName: null,
      displayName: "Jamal Hartnett",
      descriptor: null,
    });
  });

  it("falls back to the 'name' property of a service hook revisedBy", () => {
    const identity = parseAdoIdentity({ name: identityString(HUMAN) });
    expect(identity?.uniqueName).toBe(HUMAN.uniqueName);
    expect(identity?.displayName).toBe(HUMAN.displayName);
  });

  it("returns null for empty or unusable values", () => {
    expect(parseAdoIdentity("")).toBeNull();
    expect(parseAdoIdentity({})).toBeNull();
    expect(parseAdoIdentity(null)).toBeNull();
    expect(parseAdoIdentity(42)).toBeNull();
  });
});

describe("isAdoBotIdentity", () => {
  it("matches the bot by identity id", () => {
    expect(isAdoBotIdentity(identityRef(BOT), botAccount)).toBe(true);
    expect(isAdoBotIdentity({ id: BOT.id.toUpperCase() }, botAccount)).toBe(
      true
    );
  });

  it("matches the bot by the email inside 'Name <email>' case-insensitively", () => {
    expect(
      isAdoBotIdentity(
        `AgentFlow Bot <${BOT.uniqueName.toUpperCase()}>`,
        botAccount
      )
    ).toBe(true);
  });

  it("matches the bot by unique name or descriptor even when the id differs", () => {
    expect(
      isAdoBotIdentity({ id: HUMAN.id, uniqueName: BOT.uniqueName }, botAccount)
    ).toBe(true);
    expect(isAdoBotIdentity({ descriptor: BOT.descriptor }, botAccount)).toBe(
      true
    );
  });

  it("does not match other people or display names", () => {
    expect(isAdoBotIdentity(revisedBy(HUMAN), botAccount)).toBe(false);
    expect(isAdoBotIdentity(BOT.displayName, botAccount)).toBe(false);
    expect(isAdoBotIdentity(undefined, botAccount)).toBe(false);
  });

  it("never matches without a known bot account", () => {
    expect(isAdoBotIdentity(identityRef(BOT), null)).toBe(false);
  });
});

describe("identity labels and actors", () => {
  it("prefers the display name", () => {
    expect(adoIdentityLabel(identityRef(HUMAN))).toBe(HUMAN.displayName);
    expect(adoIdentityLabel(HUMAN.uniqueName)).toBe(HUMAN.uniqueName);
    expect(adoIdentityLabel(null)).toBeNull();
  });

  it("uses the id, then the unique name, as the actor id", () => {
    expect(adoIdentityActor(revisedBy(HUMAN))).toEqual({
      id: HUMAN.id,
      displayName: HUMAN.displayName,
    });
    expect(adoIdentityActor(identityString(HUMAN))).toEqual({
      id: HUMAN.uniqueName,
      displayName: HUMAN.displayName,
    });
    expect(adoIdentityActor(undefined)).toBeNull();
  });
});
