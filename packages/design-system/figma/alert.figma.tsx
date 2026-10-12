import {
  Alert,
  AlertDescription,
  AlertTitle,
} from "@agentflow-ai/design-system/components/ui/alert";
import figma from "@figma/code-connect";

const FIGMA_URL =
  "https://www.figma.com/design/py1Sc5dZnNzqPOYXDqJuAU/AgentFlow-Design-System?node-id=152-2375";

figma.connect(Alert, FIGMA_URL, {
  props: {
    title: figma.string("Title"),
    description: figma.string("Description"),
    variant: figma.enum("Variant", {
      Default: "default",
      Destructive: "destructive",
    }),
  },
  example: ({ title, description, variant }) => (
    <Alert variant={variant}>
      <AlertTitle>{title}</AlertTitle>
      <AlertDescription>{description}</AlertDescription>
    </Alert>
  ),
});
