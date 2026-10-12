import { createEnv } from "@t3-oss/env-nextjs";
import { z } from "zod";

export const keys = () =>
  createEnv({
    emptyStringAsUndefined: true,
    server: {
      // PostgreSQL connection string (password auth). Required at runtime.
      DATABASE_URL: z.url().optional(),

      PGHOST: z.string().optional(),
      PGPORT: z.string().default("5432"),
      PGUSER: z.string().optional(),
      PGDATABASE: z.string().optional(),
      PGSCHEMA: z.string().optional(),
    },
    runtimeEnv: {
      DATABASE_URL: process.env.DATABASE_URL,
      PGHOST: process.env.PGHOST,
      PGPORT: process.env.PGPORT,
      PGUSER: process.env.PGUSER,
      PGDATABASE: process.env.PGDATABASE,
      PGSCHEMA: process.env.PGSCHEMA,
    },
  });
