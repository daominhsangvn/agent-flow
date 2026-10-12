import { Label } from "@agentflow-ai/design-system/components/ui/label";
import figma from "@figma/code-connect";

const FIGMA_URL =
  "https://www.figma.com/design/py1Sc5dZnNzqPOYXDqJuAU/AgentFlow-Design-System?node-id=6837-15447";

figma.connect(Label, FIGMA_URL, {
  props: {
    children: figma.string("Label"),
  },
  example: ({ children }) => <Label>{children}</Label>,
});
