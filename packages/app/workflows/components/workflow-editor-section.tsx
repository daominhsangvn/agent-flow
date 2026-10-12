"use client";

import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@repo/design-system/components/ui/card";
import type { ReactNode } from "react";

export type WorkflowEditorSectionProps = {
  title: string;
  description: ReactNode;
  children: ReactNode;
};

/** One titled section (Basics, Triggers, Pre actions, Agent team, Post actions) of the workflow editor. */
export function WorkflowEditorSection({
  title,
  description,
  children,
}: Readonly<WorkflowEditorSectionProps>) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>
          <h2 className="font-semibold text-base">{title}</h2>
        </CardTitle>
        <CardDescription>{description}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">{children}</CardContent>
    </Card>
  );
}
