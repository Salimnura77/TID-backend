import { LOG_LEVELS } from "../logging/log-level";
import type { LogLevel } from "../logging/log-level";

export const APP_CONFIG = Symbol("TRUEID_APP_CONFIG");

export interface Auth0Config {
  readonly issuer: string;
  readonly audience: string;
  readonly mobileClientId: string;
}

export interface QoreidConfig {
  readonly mode: "sandbox";
  readonly route: "nin";
  readonly testClientId: string;
  readonly testClientSecret: string;
}

export interface RuntimeConfig {
  readonly environment: "development" | "test";
  readonly host: "127.0.0.1";
  readonly port: number;
  readonly databaseUrl: string;
  readonly corsOrigins: readonly string[];
  readonly logLevel: LogLevel;
  readonly verificationProvider: "qoreid" | "monnify";
  readonly auth0?: Auth0Config;
  readonly qoreid?: QoreidConfig;
  readonly testSigning?: { readonly keyId: string };
}

const loopbackHosts = new Set(["localhost", "127.0.0.1", "[::1]"]);

export class ConfigurationError extends Error {
  constructor(field: string) {
    // Only callers' fixed field names are supplied, never environment values.
    super(`Invalid local configuration: ${field}. Check .env.example.`);
  }
}

export function readConfig(env: NodeJS.ProcessEnv = process.env): RuntimeConfig {
  const environment = env.NODE_ENV ?? "development";
  if (environment !== "development" && environment !== "test") {
    throw new ConfigurationError("NODE_ENV (Stage 1 supports development/test only)");
  }
  const logLevel = env.TRUEID_LOG_LEVEL ?? "info";
  if (!LOG_LEVELS.some((level) => level === logLevel)) throw new ConfigurationError("TRUEID_LOG_LEVEL");
  const rawPort = env.TRUEID_PORT ?? "4200";
  const port = Number(rawPort);
  if (!/^\d+$/.test(rawPort) || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw new ConfigurationError("TRUEID_PORT");
  }
  const databaseUrl = env.DATABASE_URL;
  try {
    const url = new URL(databaseUrl ?? "");
    if (
      !["postgres:", "postgresql:"].includes(url.protocol) ||
      !loopbackHosts.has(url.hostname) ||
      !url.username || !url.password ||
      !/^\/[A-Za-z0-9_]+$/.test(url.pathname) ||
      url.search || url.hash
    ) throw new Error();
  } catch {
    throw new ConfigurationError("DATABASE_URL");
  }
  const corsOrigins = (env.TRUEID_CORS_ORIGINS ?? "")
    .split(",").map((origin) => origin.trim()).filter(Boolean);
  if (corsOrigins.length > 8 || new Set(corsOrigins).size !== corsOrigins.length) {
    throw new ConfigurationError("TRUEID_CORS_ORIGINS");
  }
  for (const origin of corsOrigins) {
    try {
      const url = new URL(origin);
      if (url.protocol !== "http:" || !loopbackHosts.has(url.hostname) || origin !== url.origin) {
        throw new Error();
      }
    } catch {
      throw new ConfigurationError("TRUEID_CORS_ORIGINS");
    }
  }
  const authFields = [env.TRUEID_AUTH0_ISSUER, env.TRUEID_AUTH0_AUDIENCE, env.TRUEID_AUTH0_MOBILE_CLIENT_ID, env.TRUEID_AUTH0_TENANT_MODE];
  let auth0: Auth0Config | undefined;
  if (authFields.some((value) => value !== undefined && value !== "")) {
    if (authFields.some((value) => !value) || env.TRUEID_AUTH0_TENANT_MODE !== "sandbox") throw new ConfigurationError("Auth0 sandbox settings");
    const issuer = env.TRUEID_AUTH0_ISSUER!;
    try {
      const url = new URL(issuer);
      if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash || url.port ||
          issuer !== `${url.origin}/` || !/^[a-z0-9][a-z0-9.-]*\.[a-z]{2,}$/.test(url.hostname)) throw new Error();
    } catch { throw new ConfigurationError("TRUEID_AUTH0_ISSUER"); }
    const audience = env.TRUEID_AUTH0_AUDIENCE!;
    const mobileClientId = env.TRUEID_AUTH0_MOBILE_CLIENT_ID!;
    if (!/^[\x21-\x7e]{1,512}$/.test(audience) || !/^[A-Za-z0-9_-]{1,128}$/.test(mobileClientId) || audience === mobileClientId) {
      throw new ConfigurationError("Auth0 audience/client ID");
    }
    auth0 = Object.freeze({ issuer, audience, mobileClientId });
  }
  // QoreID uses one host for Test and Live. Only separately provisioned Test
  // credentials are accepted here; this pilot has no production adapter path.
  if (Object.entries(env).some(([key, value]) => /^TRUEID_QOREID_(LIVE|PRODUCTION)_/.test(key) && value)) {
    throw new ConfigurationError("QoreID production credentials are unsupported");
  }
  const qoreidFields = [env.TRUEID_QOREID_MODE, env.TRUEID_QOREID_ROUTE, env.TRUEID_QOREID_TEST_CLIENT_ID, env.TRUEID_QOREID_TEST_CLIENT_SECRET];
  let qoreid: QoreidConfig | undefined;
  if (qoreidFields.some((value) => value !== undefined && value !== "")) {
    if (env.TRUEID_QOREID_MODE !== "sandbox" || env.TRUEID_QOREID_ROUTE !== "nin" ||
        !/^[A-Za-z0-9_-]{1,128}$/.test(env.TRUEID_QOREID_TEST_CLIENT_ID ?? "") ||
        !/^[\x21-\x7e]{16,512}$/.test(env.TRUEID_QOREID_TEST_CLIENT_SECRET ?? "")) {
      throw new ConfigurationError("QoreID Test settings");
    }
    qoreid = Object.freeze({ mode: "sandbox", route: "nin", testClientId: env.TRUEID_QOREID_TEST_CLIENT_ID!, testClientSecret: env.TRUEID_QOREID_TEST_CLIENT_SECRET! });
  }
  const signingFields = [env.TRUEID_CREDENTIAL_SIGNING_MODE, env.TRUEID_TEST_SIGNING_KEY_ID];
  const verificationProvider = env.TRUEID_VERIFICATION_PROVIDER || "qoreid";
  if (verificationProvider !== "qoreid" && verificationProvider !== "monnify") {
    throw new ConfigurationError("TRUEID_VERIFICATION_PROVIDER");
  }
  // Monnify documents identity verification as Live-only. The user authorized
  // preparation with provider calls disabled, not a Sandbox or Live integration.
  if ((env.TRUEID_MONNIFY_MODE && env.TRUEID_MONNIFY_MODE !== "disabled") ||
      Object.entries(env).some(([key, value]) => key.startsWith("TRUEID_MONNIFY_") && key !== "TRUEID_MONNIFY_MODE" && value)) {
    throw new ConfigurationError("Monnify provider calls remain disabled");
  }
  let testSigning: { readonly keyId: string } | undefined;
  if (signingFields.some((value) => value !== undefined && value !== "")) {
    if (environment !== "test" || env.TRUEID_CREDENTIAL_SIGNING_MODE !== "test" ||
        !/^test-[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(env.TRUEID_TEST_SIGNING_KEY_ID ?? "")) {
      throw new ConfigurationError("Dedicated Test signing settings");
    }
    testSigning = Object.freeze({ keyId: env.TRUEID_TEST_SIGNING_KEY_ID! });
  }
  return Object.freeze({
    environment, host: "127.0.0.1", port,
    databaseUrl: databaseUrl!, corsOrigins: Object.freeze(corsOrigins), logLevel: logLevel as LogLevel, verificationProvider,
    ...(auth0 ? { auth0 } : {}),
    ...(qoreid ? { qoreid } : {}),
    ...(testSigning ? { testSigning } : {}),
  });
}
