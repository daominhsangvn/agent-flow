import type { AuthState, HasParams } from "./types";

/**
 * What `auth()` returns on the server and in middleware. Same member names as
 * the Clerk auth object the app was written against.
 */
export type AuthObject = AuthState & {
  /** The session JWT to forward to apps/api as `Authorization: Bearer`. */
  getToken: () => Promise<string | null>;
  has: (params: HasParams) => boolean;
  redirectToSignIn: (options?: { returnBackUrl?: string }) => never;
  redirectToSignUp: (options?: { returnBackUrl?: string }) => never;
};

/** The lazy `auth` accessor handed to middleware handlers. */
export type MiddlewareAuth = () => Promise<AuthObject>;
