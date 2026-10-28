import { describe, expect, it } from "vitest";
import {
  TriggerConditionMatch,
  type TriggerConditionState,
  triggerConditionsMatch,
} from "../trigger-conditions";

const off: TriggerConditionState = {
  enabled: false,
  holds: true,
  activated: true,
};
const justBecameTrue: TriggerConditionState = {
  enabled: true,
  holds: true,
  activated: true,
};
const alreadyTrue: TriggerConditionState = {
  enabled: true,
  holds: true,
  activated: false,
};
const notTrue: TriggerConditionState = {
  enabled: true,
  holds: false,
  activated: false,
};

describe("triggerConditionsMatch", () => {
  it("needs a chosen condition that the occurrence made true", () => {
    expect(triggerConditionsMatch([], TriggerConditionMatch.Any)).toBe(false);
    expect(triggerConditionsMatch([off], TriggerConditionMatch.Any)).toBe(
      false
    );
    expect(
      triggerConditionsMatch([alreadyTrue], TriggerConditionMatch.All)
    ).toBe(false);
    expect(
      triggerConditionsMatch([justBecameTrue, off], TriggerConditionMatch.All)
    ).toBe(true);
  });

  it("all: every other chosen condition must already hold", () => {
    expect(
      triggerConditionsMatch(
        [justBecameTrue, alreadyTrue],
        TriggerConditionMatch.All
      )
    ).toBe(true);
    expect(
      triggerConditionsMatch(
        [justBecameTrue, notTrue],
        TriggerConditionMatch.All
      )
    ).toBe(false);
  });

  it("any: one condition becoming true is enough", () => {
    expect(
      triggerConditionsMatch(
        [justBecameTrue, notTrue],
        TriggerConditionMatch.Any
      )
    ).toBe(true);
    expect(
      triggerConditionsMatch([notTrue, alreadyTrue], TriggerConditionMatch.Any)
    ).toBe(false);
  });
});
