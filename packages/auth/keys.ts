import { createEnv } from "@t3-oss/env-nextjs";
import { z } from "zod";
import { AuthMode } from "./auth-mode";

export const keys = () =>
  createEnv({
    emptyStringAsUndefined: true,
    server: {
      AUTH_MODE: z
        .enum([AuthMode.Session, AuthMode.LocalTrusted])
        .default(AuthMode.Session)
        .optional(),
      // Where server code reaches apps/api for sessions and JWKS. Defaults to
      // NEXT_PUBLIC_API_URL; set it when the internal address differs (Docker).
      AUTH_API_URL: z.url().optional(),
    },
    client: {
      NEXT_PUBLIC_LOGO_URL: z.url().optional(),
    },
    runtimeEnv: {
      AUTH_MODE: process.env.AUTH_MODE,
      AUTH_API_URL: process.env.AUTH_API_URL,
      NEXT_PUBLIC_LOGO_URL: process.env.NEXT_PUBLIC_LOGO_URL,
    },
  });
