"use client";

import { ExternalLinkIcon } from "lucide-react";
import { z } from "zod";

export function ExternalOrText({
  href,
  text,
}: Readonly<{ href: string | null; text: string }>) {
  if (!(href && isHttpUrl(href))) {
    return <span>{text}</span>;
  }
  return (
    <a
      className="inline-flex items-center gap-1 text-[var(--link)] hover:underline"
      href={href}
      rel="noreferrer noopener"
      target="_blank"
    >
      {text}
      <ExternalLinkIcon className="size-3" />
    </a>
  );
}

export function isHttpUrl(value: string): boolean {
  return httpUrlSchema.safeParse(value).success;
}

const httpUrlSchema = z.url({ protocol: /^https?$/ });
