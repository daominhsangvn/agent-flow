import { FeatureFlagAdapterProvider } from "@repo/app/shared/feature-flags/provider";
import { createStaticFeatureFlagAdapter } from "@repo/app/shared/feature-flags/static-feature-flag-adapter";
import { PROCESS_FORM_EDITOR_FEATURE_FLAG_KEY } from "@repo/app/shared/lib/feature-flags";
import type { ReactNode } from "react";

const processFormFlagOn = createStaticFeatureFlagAdapter({
  enabledFlags: [PROCESS_FORM_EDITOR_FEATURE_FLAG_KEY],
});

/**
 * The process editor with its Form tab: the process-form-editor flag is off
 * by default (the process is edited as YAML only). Use as render()'s wrapper.
 */
export function ProcessFormEnabled({ children }: { children: ReactNode }) {
  return (
    <FeatureFlagAdapterProvider adapter={processFormFlagOn}>
      {children}
    </FeatureFlagAdapterProvider>
  );
}
