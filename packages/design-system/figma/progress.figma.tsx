import { Progress } from "@agentflow-ai/design-system/components/ui/progress";
import figma from "@figma/code-connect";

const FIGMA_URL =
  "https://www.figma.com/design/py1Sc5dZnNzqPOYXDqJuAU/AgentFlow-Design-System?node-id=2768-27760";

figma.connect(Progress, FIGMA_URL, {
  example: () => <Progress value={33} />,
});
