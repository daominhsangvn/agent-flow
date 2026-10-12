/**
 * @file headless-safe-storage.ts
 * @description `SafeStorageLike` for the headless runner, which has no OS
 * keychain. Values are sealed with AES-256-GCM under a random key kept in the
 * runner data directory (mode 0600, created on first use).
 *
 * This keeps loop runner tokens unreadable if a store file is copied on its
 * own; it does not protect against someone who can read the whole data
 * directory. Mount that directory as a private volume.
 */

import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { SafeStorageLike } from "../main/util/electron-safe-storage.js";

const KEY_FILE_NAME = "storage.key";
const KEY_BYTES = 32;
const IV_BYTES = 12;
const TAG_BYTES = 16;
const ALGORITHM = "aes-256-gcm";

export function createHeadlessSafeStorage(dataDir: string): SafeStorageLike {
  const key = loadOrCreateKey(dataDir);
  return {
    isEncryptionAvailable: () => true,
    encryptString(plainText: string): Buffer {
      const iv = randomBytes(IV_BYTES);
      const cipher = createCipheriv(ALGORITHM, key, iv);
      const sealed = Buffer.concat([
        cipher.update(plainText, "utf8"),
        cipher.final(),
      ]);
      return Buffer.concat([iv, cipher.getAuthTag(), sealed]);
    },
    decryptString(encrypted: Buffer): string {
      const iv = encrypted.subarray(0, IV_BYTES);
      const tag = encrypted.subarray(IV_BYTES, IV_BYTES + TAG_BYTES);
      const decipher = createDecipheriv(ALGORITHM, key, iv);
      decipher.setAuthTag(tag);
      return Buffer.concat([
        decipher.update(encrypted.subarray(IV_BYTES + TAG_BYTES)),
        decipher.final(),
      ]).toString("utf8");
    },
  };
}

function loadOrCreateKey(dataDir: string): Buffer {
  const keyPath = path.join(dataDir, KEY_FILE_NAME);
  try {
    const existing = fs.readFileSync(keyPath);
    if (existing.length === KEY_BYTES) {
      return existing;
    }
  } catch {
    // First run: fall through and create the key.
  }
  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const key = randomBytes(KEY_BYTES);
  fs.writeFileSync(keyPath, key, { mode: 0o600 });
  return key;
}
