import { createRemoteJWKSet, customFetch, errors, jwtVerify } from "jose";
import type { JWTVerifyGetKey } from "jose";
import type { Auth0Config } from "../config/runtime-config";
import { ApiError } from "../http/api-error";
import type { AccessTokenVerifier, AuthenticatedIdentity } from "./identity";

export class Auth0TokenVerifier implements AccessTokenVerifier {
  private readonly key: JWTVerifyGetKey | undefined;

  constructor(private readonly config: Auth0Config | undefined, key?: JWTVerifyGetKey) {
    this.key = key ?? (config ? createRemoteJWKSet(new URL(".well-known/jwks.json", config.issuer), {
      timeoutDuration: 3000, cooldownDuration: 30_000, cacheMaxAge: 600_000,
      // Configuration supplies the sole trusted URL. Never follow token jku/x5u or redirects.
      [customFetch]: (url, options) => fetch(url, { ...options, redirect: "error" }),
    }) : undefined);
  }

  async verify(token: string): Promise<AuthenticatedIdentity> {
    if (!this.config || !this.key) throw new ApiError(503, "authentication_unavailable");
    try {
      const { payload, protectedHeader } = await jwtVerify(token, this.key, {
        algorithms: ["RS256"], issuer: this.config.issuer, audience: this.config.audience,
        typ: "at+jwt", requiredClaims: ["iss", "sub", "aud", "exp", "iat", "jti", "client_id"],
        clockTolerance: 0,
      });
      const now = Math.floor(Date.now() / 1000);
      if (
        typeof protectedHeader.kid !== "string" || !protectedHeader.kid || protectedHeader.kid.length > 256 ||
        typeof payload.sub !== "string" || !payload.sub || payload.sub.length > 255 || /[\u0000-\u001f\u007f]/.test(payload.sub) ||
        payload.sub.endsWith("@clients") || payload.gty === "client-credentials" ||
        (payload.sub_profile !== undefined && payload.sub_profile !== "user") || payload.act !== undefined ||
        payload.client_id !== this.config.mobileClientId ||
        !Number.isInteger(payload.iat) || !Number.isInteger(payload.exp) ||
        payload.iat! > now || payload.exp! <= payload.iat! ||
        typeof payload.jti !== "string" || !payload.jti || payload.jti.length > 1024
      ) throw new Error();
      if (typeof payload.scope !== "string" || !payload.scope.split(" ").includes("account:self")) {
        throw new ApiError(403, "forbidden");
      }
      return Object.freeze({ issuer: this.config.issuer, subject: payload.sub });
    } catch (error) {
      if (error instanceof ApiError) throw error;
      if (error instanceof errors.JWKSTimeout || error instanceof TypeError || error instanceof SyntaxError ||
          (error instanceof errors.JOSEError && error.code === "ERR_JOSE_GENERIC")) {
        throw new ApiError(503, "authentication_unavailable");
      }
      // No exception, header, claim, key URL or token is logged or returned.
      throw new ApiError(401, "unauthenticated");
    }
  }
}
