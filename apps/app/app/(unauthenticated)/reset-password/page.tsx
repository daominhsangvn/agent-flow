import { createMetadata } from "@repo/seo/metadata";
import type { Metadata } from "next";
import dynamic from "next/dynamic";

const ResetPassword = dynamic(() =>
  import("@repo/auth/components/reset-password").then(
    (mod) => mod.ResetPassword
  )
);

export const metadata: Metadata = createMetadata({
  title: "Reset password",
  description: "Choose a new password for your account.",
});

const ResetPasswordPage = () => <ResetPassword />;

export default ResetPasswordPage;
