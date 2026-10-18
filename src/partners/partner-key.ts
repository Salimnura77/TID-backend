import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";

const uuid = "[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}";
const pattern = new RegExp(`^tidp_(${uuid})\\.([A-Za-z0-9_-]{43})$`);
export interface ParsedPartnerKey { readonly id: string; readonly keyDigest: string }
export interface PartnerIdentity extends ParsedPartnerKey { readonly credentialId: string }

export function secretDigest(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}
export function newPartnerKey(id: string = randomUUID()) {
  if (!new RegExp(`^${uuid}$`).test(id)) throw new Error("Invalid partner reference.");
  const key = `tidp_${id}.${randomBytes(32).toString("base64url")}`;
  return { id, key, keyDigest: secretDigest(key) };
}
export function parsePartnerKey(key: string): ParsedPartnerKey | undefined {
  const match = pattern.exec(key);
  if (!match || Buffer.from(match[2]!, "base64url").toString("base64url") !== match[2]) return undefined;
  return { id: match[1]!, keyDigest: secretDigest(key) };
}
export function matchingDigest(actual: string, expected: string): boolean {
  return /^[a-f0-9]{64}$/.test(actual) && /^[a-f0-9]{64}$/.test(expected) &&
    timingSafeEqual(Buffer.from(actual, "hex"), Buffer.from(expected, "hex"));
}
