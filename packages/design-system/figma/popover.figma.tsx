import { Button } from "@agentflow-ai/design-system/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@agentflow-ai/design-system/components/ui/popover";
import figma from "@figma/code-connect";

const FIGMA_URL =
  "https://www.figma.com/design/py1Sc5dZnNzqPOYXDqJuAU/AgentFlow-Design-System?node-id=13-888";

figma.connect(PopoverContent, FIGMA_URL, {
  props: {
    content: figma.children("Content"),
  },
  example: ({ content }) => (
    <Popover>
      <PopoverTrigger asChild>
        <Button variant="outline">Open</Button>
      </PopoverTrigger>
      <PopoverContent>{content}</PopoverContent>
    </Popover>
  ),
});
