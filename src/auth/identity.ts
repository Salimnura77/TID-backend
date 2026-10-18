export interface AuthenticatedIdentity {
  readonly issuer: string;
  readonly subject: string;
}

export const ACCESS_TOKEN_VERIFIER = Symbol("ACCESS_TOKEN_VERIFIER");
export interface AccessTokenVerifier {
  verify(token: string): Promise<AuthenticatedIdentity>;
}
