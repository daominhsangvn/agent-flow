import {
  decryptSecret,
  encryptSecret,
  SecretPurpose,
} from "@/lib/secret-encryption";

/**
 * Encrypts an integration token with the local AES-256-GCM envelope
 * (`ENCRYPTION_KEY`), bound to the integration-token purpose.
 */
export function encryptIntegrationToken(token: string): Promise<string> {
  // Deferred so a missing key or bad ciphertext rejects instead of throwing
  // synchronously, preserving the async contract of the former KMS calls.
  return Promise.resolve().then(() =>
    encryptSecret(token, SecretPurpose.IntegrationToken)
  );
}

/**
 * Decrypts a sealed integration token. Fails if the value was sealed for a
 * different purpose or tampered with.
 */
export function decryptIntegrationToken(encrypted: string): Promise<string> {
  return Promise.resolve().then(() =>
    decryptSecret(encrypted, SecretPurpose.IntegrationToken)
  );
}

/**
 * Resolves an integration token by decrypting the encrypted form if present,
 * or returning the plaintext fallback. Returns null if neither is available.
 */
export function resolveIntegrationToken(
  encrypted: string | null | undefined,
  plaintext: string | null
): Promise<string | null> {
  if (encrypted) {
    return decryptIntegrationToken(encrypted);
  }
  return Promise.resolve(plaintext);
}

/**
 * Encrypts an access token and optional refresh token in parallel.
 * Returns the encrypted values in a named object for clarity at the call site.
 */
export async function encryptTokenPair(
  accessToken: string,
  refreshToken: string | null | undefined
): Promise<{
  encryptedAccessToken: string;
  encryptedRefreshToken: string | null;
}> {
  const [encryptedAccessToken, encryptedRefreshToken] = await Promise.all([
    encryptIntegrationToken(accessToken),
    refreshToken
      ? encryptIntegrationToken(refreshToken)
      : Promise.resolve(null),
  ]);
  return { encryptedAccessToken, encryptedRefreshToken };
}
