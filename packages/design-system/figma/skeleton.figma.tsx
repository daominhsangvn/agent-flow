import { Skeleton } from "@agentflow-ai/design-system/components/ui/skeleton";
import figma from "@figma/code-connect";

const FIGMA_URL =
  "https://www.figma.com/design/py1Sc5dZnNzqPOYXDqJuAU/AgentFlow-Design-System?node-id=168-2123";

figma.connect(Skeleton, FIGMA_URL, {
  example: () => <Skeleton className="h-4 w-[250px]" />,
});
