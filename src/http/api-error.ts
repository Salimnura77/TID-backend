import { HttpException } from "@nestjs/common";

export const ERROR_MESSAGES = {
  invalid_request: "The request is invalid.",
  unauthenticated: "Authentication is required.",
  authentication_unavailable: "Authentication is not configured or available.",
  forbidden: "Access is denied.",
  not_found: "The requested resource was not found.",
  method_not_allowed: "This method is not allowed.",
  payload_too_large: "The request body exceeds the size limit.",
  rate_limited: "Too many requests. Try again later.",
  origin_not_allowed: "This browser origin is not allowed.",
  service_unavailable: "The service is not ready. Try again later.",
  verification_unavailable: "Verification is not configured or available.",
  verification_in_progress: "A verification is already in progress. Review that attempt before submitting another.",
  sandbox_input_required: "Use the configured provider's published Test inputs in this local pilot.",
  verification_not_verified: "A verified outcome is required to issue a credential.",
  verification_not_current: "Issue from the account's latest verified attempt.",
  signing_unavailable: "Dedicated Test signing is not configured or available.",
  credential_invalid: "The credential is invalid.",
  credential_inactive: "This credential is inactive. Reverification is required for a new credential.",
  invitation_inactive: "This invitation is expired or already used. Request a new invitation.",
  consent_conflict: "The consent decision is stale or cannot be changed. Review the current request.",
  disclosure_denied: "This request has no current matching approval.",
  internal_error: "The service could not complete this action.",
} as const;
export type ErrorCode = keyof typeof ERROR_MESSAGES;

export class ApiError extends HttpException {
  constructor(status: number, readonly code: ErrorCode) {
    super(ERROR_MESSAGES[code], status);
  }
}
