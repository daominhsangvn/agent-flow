"use client";

import type { ReactNode } from "react";

type AuthProviderProperties = {
  children?: ReactNode;
  nonce?: string;
  privacyUrl?: string;
  termsUrl?: string;
  helpUrl?: string;
  logoUrl?: string;
};

/**
 * Better Auth keeps its client state in module-level stores, so no context is
 * required. The component stays as the app's single mount point for identity
 * and accepts the props the layout already passes.
 */
export const AuthProvider = ({ children }: AuthProviderProperties) => children;
