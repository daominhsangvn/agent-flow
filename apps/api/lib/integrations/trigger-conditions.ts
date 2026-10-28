import {
  type IntegrationFieldDescriptor,
  IntegrationFieldKind,
} from "@repo/api/src/types/integration";
import type { InboundEvent, ReviewSignalFacts } from "./types";

/**
 * Shared logic of the "conditions" triggers (jira.issue_conditions,
 * azure_devops.work_item_conditions): the admin picks several conditions
 * (assigned to the bot, a label or tag, a mention) and whether all or any of
 * them must hold.
 *
 * A run starts on an occurrence (a change, a creation, a comment) that makes
 * at least one chosen condition true. With `all`, every other chosen
 * condition must already hold at that moment, so the order in which they
 * became true does not matter: "assigned and labeled ai-ready" starts when
 * the second of the two happens. A mention is a moment, not a state: it
 * holds only for the occurrence that is the mention itself.
 */

export const TriggerConditionMatch = {
  /** Every chosen condition holds (AND). */
  All: "all",
  /** At least one chosen condition (OR). */
  Any: "any",
} as const;
export type TriggerConditionMatch =
  (typeof TriggerConditionMatch)[keyof typeof TriggerConditionMatch];

/** One chosen-or-not condition, evaluated for one occurrence. */
export type TriggerConditionState = {
  /** The admin chose this condition. */
  enabled: boolean;
  /** The condition holds after the occurrence. */
  holds: boolean;
  /** The occurrence made the condition true (it did not hold before). */
  activated: boolean;
};

/**
 * True when the occurrence activated a chosen condition and, with `all`,
 * every chosen condition holds. No chosen condition never matches.
 */
export function triggerConditionsMatch(
  conditions: readonly TriggerConditionState[],
  match: TriggerConditionMatch
): boolean {
  const chosen = conditions.filter((condition) => condition.enabled);
  if (!chosen.some((condition) => condition.activated)) {
    return false;
  }
  return (
    match === TriggerConditionMatch.Any ||
    chosen.every((condition) => condition.holds)
  );
}

export const TRIGGER_CONDITION_MATCH_FIELD: IntegrationFieldDescriptor = {
  key: "match",
  label: "Combine the conditions",
  kind: IntegrationFieldKind.Select,
  defaultValue: TriggerConditionMatch.All,
  options: [
    { value: TriggerConditionMatch.All, label: "All of them (AND)" },
    { value: TriggerConditionMatch.Any, label: "Any of them (OR)" },
  ],
  description:
    "all: a run starts when the last of the chosen conditions becomes true while the others already hold, in any order. any: a run starts when any of them becomes true.",
};

export const TRIGGER_CONDITIONS_REQUIRED_MESSAGE =
  "Choose at least one condition";

/**
 * The review signal of a provider's conditions events (the
 * IntegrationProviderDefinition `reviewSignal` hook): every occurrence that
 * labels the item or mentions the bot yields one conditions event, so other
 * event types of the same occurrence answer nothing.
 */
export function conditionsReviewSignal(options: {
  triggerType: string;
  addedLabelsAttribute: string;
  mentionedAttribute: string;
}): (event: InboundEvent) => ReviewSignalFacts | null {
  return (event) => {
    if (event.triggerType !== options.triggerType) {
      return null;
    }
    const added = event.attributes[options.addedLabelsAttribute];
    return {
      addedLabels: Array.isArray(added) ? added : [],
      mentioned: event.attributes[options.mentionedAttribute] === true,
    };
  };
}
