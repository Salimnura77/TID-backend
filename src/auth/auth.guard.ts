import { Inject, Injectable } from "@nestjs/common";
import type { CanActivate, ExecutionContext } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import type { Request, Response } from "express";
import { ApiError } from "../http/api-error";
import { ACCESS_TOKEN_VERIFIER } from "./identity";
import type { AccessTokenVerifier, AuthenticatedIdentity } from "./identity";
import { PUBLIC_ROUTE } from "./public.decorator";
import { PARTNER_ROUTE } from "../partners/partner-route.decorator";
import { PartnersService } from "../partners/partners.service";
import type { PartnerIdentity } from "../partners/partner-key";
import { PARTNER_PERMISSIONS } from "../partners/partner-permission";
import type { PartnerPermission } from "../partners/partner-permission";

export type AuthenticatedRequest = Request & { identity: AuthenticatedIdentity };
export type PartnerRequest = Request & { partner: PartnerIdentity };

@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    @Inject(Reflector) private readonly reflector: Reflector,
    @Inject(ACCESS_TOKEN_VERIFIER) private readonly verifier: AccessTokenVerifier,
    @Inject(PartnersService) private readonly partners: PartnersService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (this.reflector.getAllAndOverride<boolean>(PUBLIC_ROUTE, [context.getHandler(), context.getClass()]) === true) return true;
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const response = context.switchToHttp().getResponse<Response>();
    response.setHeader("Cache-Control", "no-store");
    const authorizationHeaders = request.rawHeaders.filter((_, index) => index % 2 === 0)
      .filter((name) => name.toLowerCase() === "authorization");
    const header = request.headers.authorization;
    if (authorizationHeaders.length !== 1 || typeof header !== "string" || header.length > 8192 || !/^Bearer \S+$/i.test(header)) {
      throw new ApiError(401, "unauthenticated");
    }
    const permission = this.reflector.getAllAndOverride<PartnerPermission | "deny">(PARTNER_ROUTE, [context.getHandler(), context.getClass()]);
    if (permission !== undefined) {
      if (permission === "deny" || !PARTNER_PERMISSIONS.includes(permission)) throw new ApiError(403, "forbidden");
      (request as unknown as PartnerRequest).partner = await this.partners.authenticate(header.slice(7), permission);
      return true;
    }
    if (!/^Bearer [A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/i.test(header)) throw new ApiError(401, "unauthenticated");
    request.identity = await this.verifier.verify(header.slice(7));
    return true;
  }
}
