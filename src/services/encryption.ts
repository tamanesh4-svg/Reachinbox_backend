
import crypto from "crypto";
import { env } from "../config/env";

function getEncryptionKey(): Buffer {
  if (
    !env.encryptionKey ||
    !/^[0-9a-fA-F]{64}$/.test(env.encryptionKey)
  ) {
    throw new Error(
      "ENCRYPTION_KEY must contain exactly 64 hexadecimal characters."
    );
  }

  return Buffer.from(env.encryptionKey, "hex");
}

export function encrypt(plaintext: string): string {
  if (!plaintext) {
    throw new Error("Cannot encrypt an empty value.");
  }

  const key = getEncryptionKey();

  // AES-GCM requires a unique, unpredictable 12-byte IV.
  const iv = crypto.randomBytes(12);

  const cipher = crypto.createCipheriv(
    "aes-256-gcm",
    key,
    iv
  );

  const encrypted = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final()
  ]);

  const authTag = cipher.getAuthTag();

  // Format: IV:AUTH_TAG:ENCRYPTED_DATA
  return [
    iv.toString("hex"),
    authTag.toString("hex"),
    encrypted.toString("hex")
  ].join(":");
}

export function decrypt(ciphertext: string): string {
  if (!ciphertext) {
    throw new Error("Cannot decrypt an empty value.");
  }

  const parts = ciphertext.split(":");

  if (parts.length !== 3) {
    throw new Error("Invalid encrypted data format.");
  }

  const [ivHex, tagHex, dataHex] = parts;

  if (
    !/^[0-9a-fA-F]{24}$/.test(ivHex) ||
    !/^[0-9a-fA-F]{32}$/.test(tagHex) ||
    !/^[0-9a-fA-F]+$/.test(dataHex) ||
    dataHex.length % 2 !== 0
  ) {
    throw new Error("Invalid encrypted data.");
  }

  const iv = Buffer.from(ivHex, "hex");
  const authTag = Buffer.from(tagHex, "hex");
  const encryptedData = Buffer.from(dataHex, "hex");

  const decipher = crypto.createDecipheriv(
    "aes-256-gcm",
    getEncryptionKey(),
    iv
  );

  decipher.setAuthTag(authTag);

  return Buffer.concat([
    decipher.update(encryptedData),
    decipher.final()
  ]).toString("utf8");
}
