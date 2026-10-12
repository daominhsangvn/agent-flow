"use client";

import { IntegrationProviderKey } from "@repo/api/src/types/integration";
import {
  AzureDevOpsGlyph,
  BitbucketGlyph,
  GitHubMark,
  JiraGlyph,
  MicrosoftTeamsGlyph,
} from "@repo/design-system/components/ui/brand-icons";
import { cn } from "@repo/design-system/lib/utils";
import { FolderGit2Icon, PlugIcon, WebhookIcon } from "lucide-react";
import type { ComponentType } from "react";

type IconComponent = ComponentType<{
  className?: string;
  "aria-hidden"?: boolean | "true" | "false";
}>;

/**
 * The only provider-specific hardcode the integrations UI allows: a brand
 * glyph per built-in provider key. Any other provider (one added to the
 * registry later) renders the generic plug icon, so the UI never breaks on an
 * unknown key.
 */
const PROVIDER_ICONS = new Map<string, IconComponent>([
  [IntegrationProviderKey.Jira, JiraGlyph],
  [IntegrationProviderKey.AzureDevOps, AzureDevOpsGlyph],
  [IntegrationProviderKey.MicrosoftTeams, MicrosoftTeamsGlyph],
  [IntegrationProviderKey.Webhook, WebhookIcon],
  [IntegrationProviderKey.GitHub, GitHubMark],
  [IntegrationProviderKey.Bitbucket, BitbucketGlyph],
  [IntegrationProviderKey.LocalGit, FolderGit2Icon],
]);

export type ProviderIconProps = {
  provider: string;
  className?: string;
};

export function ProviderIcon({
  provider,
  className,
}: Readonly<ProviderIconProps>) {
  const Icon = getProviderIcon(provider);
  return (
    <Icon aria-hidden="true" className={cn("size-4 shrink-0", className)} />
  );
}

export function getProviderIcon(provider: string): IconComponent {
  return PROVIDER_ICONS.get(provider) ?? PlugIcon;
}
