import type { VerificationInput, VerificationResult } from "./verification.provider";

// Documented request fields; these types are not new HTTP DTOs or stored profiles.
export interface MonnifyBvnInput {
  readonly bvn: string;
  readonly name: string;
  readonly dateOfBirth: string;
  readonly mobileNo: string;
}
export const monnifyUnavailable = (): VerificationResult => ({ outcome: "provider_unavailable", reason: "provider_unavailable" });
export const monnifyInvalid = (): VerificationResult => ({ outcome: "provider_unavailable", reason: "invalid_response" });
export const monnifyTimeout = (): VerificationResult => ({ outcome: "timeout", reason: "provider_timeout" });
export const monnifyRecord = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};

function normalizedName(value: unknown, maximum: number): string | undefined {
  return typeof value === "string" && value.length >= 1 && value.length <= maximum && !/[\x00-\x1f\x7f]/.test(value) && value.trim()
    ? value.normalize("NFC").trim().replace(/\s+/gu, " ").toUpperCase() : undefined;
}
const identityNumber = (value: unknown) => typeof value === "string" && /^\d{11}$/.test(value);
const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
function validBirthDate(value: unknown): boolean {
  if (typeof value !== "string" || !/^\d{2}-[A-Z][a-z]{2}-\d{4}$/.test(value)) return false;
  const day = Number(value.slice(0, 2));
  const month = months.indexOf(value.slice(3, 6));
  const year = Number(value.slice(7));
  const date = new Date(Date.UTC(year, month, day));
  return year >= 1000 && month >= 0 && date.getUTCFullYear() === year && date.getUTCMonth() === month && date.getUTCDate() === day && date.getTime() <= Date.now();
}
export function validMonnifyNinInput(input: VerificationInput): boolean {
  const body = monnifyRecord(input);
  return identityNumber(body.nin) && !!normalizedName(body.firstname, 100) && !!normalizedName(body.lastname, 100);
}
export function validMonnifyBvnInput(input: MonnifyBvnInput): boolean {
  const body = monnifyRecord(input);
  return identityNumber(body.bvn) && !!normalizedName(body.name, 200) && validBirthDate(body.dateOfBirth) &&
    typeof body.mobileNo === "string" && /^0\d{10}$/.test(body.mobileNo);
}
export function monnifySuccessfulBody(value: unknown): Record<string, unknown> | undefined {
  const envelope = monnifyRecord(value);
  if (envelope.requestSuccessful !== true || envelope.responseCode !== "0" || !envelope.responseBody ||
      typeof envelope.responseBody !== "object" || Array.isArray(envelope.responseBody)) return undefined;
  return monnifyRecord(envelope.responseBody);
}

// HTTP success, a valid number, and the provider flag alone cannot establish a
// match to the existing NIN submission. Compare the returned names locally; only
// the NIN is sent to Monnify. Never return any raw response fields or references.
export function mapMonnifyNinResponse(value: unknown, input: VerificationInput): VerificationResult {
  if (!validMonnifyNinInput(input)) return monnifyInvalid();
  const body = monnifySuccessfulBody(value);
  if (!body) return monnifyUnavailable();
  if (body.nin !== input.nin || typeof body.ninInformationMatch !== "boolean") return monnifyInvalid();
  if (!body.ninInformationMatch) return { outcome: "unable_to_verify", reason: "no_match" };
  const firstname = normalizedName(body.firstName, 100);
  const lastname = normalizedName(body.lastName, 100);
  if (!firstname || !lastname) return monnifyInvalid();
  const expectedFirst = normalizedName(input.firstname, 100);
  const expectedLast = normalizedName(input.lastname, 100);
  if (firstname === expectedFirst && lastname === expectedLast) return { outcome: "verified", reason: "exact_match" };
  if (firstname === expectedLast && lastname === expectedFirst) return { outcome: "needs_review", reason: "transposed_match" };
  if (firstname === expectedFirst || lastname === expectedLast) return { outcome: "needs_review", reason: "partial_match" };
  return { outcome: "unable_to_verify", reason: "identity_mismatch" };
}
export function mapMonnifyBvnResponse(value: unknown, input: MonnifyBvnInput): VerificationResult {
  if (!validMonnifyBvnInput(input)) return monnifyInvalid();
  const body = monnifySuccessfulBody(value);
  if (!body) return monnifyUnavailable();
  if (body.bvn !== input.bvn || typeof body.bvnInformationMatch !== "boolean") return monnifyInvalid();
  if (!body.bvnInformationMatch) return { outcome: "unable_to_verify", reason: "no_match" };
  const name = normalizedName(body.name, 200);
  if (!name || !validBirthDate(body.dateOfBirth) || typeof body.mobileNo !== "string" || !/^0\d{10}$/.test(body.mobileNo)) return monnifyInvalid();
  if (name !== normalizedName(input.name, 200) || body.dateOfBirth !== input.dateOfBirth || body.mobileNo !== input.mobileNo) {
    return { outcome: "unable_to_verify", reason: "identity_mismatch" };
  }
  return { outcome: "verified", reason: "exact_match" };
}
