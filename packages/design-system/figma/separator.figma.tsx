import { Separator } from "@agentflow-ai/design-system/components/ui/separator";
import figma from "@figma/code-connect";

const FIGMA_URL =
  "https://www.figma.com/design/py1Sc5dZnNzqPOYXDqJuAU/AgentFlow-Design-System?node-id=2753-10017";

figma.connect(Separator, FIGMA_URL, {
  props: {
    orientation: figma.enum("Orientation", {
      Horizontal: "horizontal",
      Vertical: "vertical",
    }),
  },
  example: ({ orientation }) => <Separator orientation={orientation} />,
});
