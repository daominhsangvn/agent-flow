import { toNextJsHandler } from "better-auth/next-js";
import { betterAuthHandler } from "@/lib/auth/better-auth";

// Better Auth endpoints (sign-in, sign-up, sessions, organizations, JWTs).
// The web app rewrites its own /api/auth/* here.
export const { GET, POST } = toNextJsHandler(betterAuthHandler);
