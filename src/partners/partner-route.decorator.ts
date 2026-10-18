import { SetMetadata } from "@nestjs/common";
import type { PartnerPermission } from "./partner-permission";

export const PARTNER_ROUTE = Symbol("TRUEID_PARTNER_ROUTE");
// A separate principal type, never a public route or an end-user JWT.
// Class-level marker closes future routes unless a method explicitly names its permission.
export const PartnerRoute = (permission?: PartnerPermission) => SetMetadata(PARTNER_ROUTE, permission ?? "deny");
