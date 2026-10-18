import { Module } from "@nestjs/common";
import { APP_GUARD } from "@nestjs/core";
import { APP_CONFIG } from "../config/runtime-config";
import type { RuntimeConfig } from "../config/runtime-config";
import { AuthGuard } from "./auth.guard";
import { Auth0TokenVerifier } from "./auth0-token-verifier";
import { ACCESS_TOKEN_VERIFIER } from "./identity";
import { PartnersModule } from "../partners/partners.module";

// Owns OIDC token validation and authentication guards; no identity verification or disclosure.
@Module({ imports: [PartnersModule], providers: [
  { provide: ACCESS_TOKEN_VERIFIER, inject: [APP_CONFIG], useFactory: (config: RuntimeConfig) => new Auth0TokenVerifier(config.auth0) },
  { provide: APP_GUARD, useClass: AuthGuard },
] })
export class AuthModule {}
