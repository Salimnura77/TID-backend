import type { VerificationInput } from "./verification.provider";

// QoreID-owned Test facilities, not TrueID users or application seed data.
// Source: https://docs.qoreid.com/reference/sample-test-data (2026-10-13).
const testNumbers = new Set(["63184876213", "18482561982"]);
const testFirstnames = new Set(["Bunch", "Guion"]);
const testLastnames = new Set(["Dillon", "Audi"]);

export function isSandboxInput(input: VerificationInput): boolean {
  // Crossed Test names allow QoreID's documented negative-match simulation.
  return testNumbers.has(input.nin) && testFirstnames.has(input.firstname) && testLastnames.has(input.lastname);
}
