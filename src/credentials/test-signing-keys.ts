import { createPrivateKey, createPublicKey, sign } from "node:crypto";
import type { KeyObject } from "node:crypto";
import { readFile, realpath } from "node:fs/promises";
import { resolve, sep } from "node:path";
import type { JWK } from "jose";
import type { RuntimeConfig } from "../config/runtime-config";
import { ApiError } from "../http/api-error";
import type { SigningKey, SigningKeys } from "./signing-key";

export const TEST_KEY_ID = /^test-[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;

// Dedicated local Test key only. Never constructed by production configuration.
export class TestSigningKey implements SigningKey {
  readonly algorithm = "RS256" as const;
  readonly mode = "test" as const;
  constructor(readonly id: string, private readonly key: KeyObject) {
    if (!TEST_KEY_ID.test(id) || key.type !== "private" || key.asymmetricKeyType !== "rsa" ||
        (key.asymmetricKeyDetails?.modulusLength ?? 0) < 2048) throw new ApiError(503, "signing_unavailable");
  }
  async publicKey(): Promise<JWK> { return { ...createPublicKey(this.key).export({ format: "jwk" }), kid: this.id, alg: "RS256", use: "sig" }; }
  async sign(input: Uint8Array, signal: AbortSignal): Promise<Uint8Array> {
    signal.throwIfAborted();
    return sign("sha256", input, this.key);
  }
}

export class TestSigningKeys implements SigningKeys {
  readonly mode: "test" | "disabled";
  constructor(private readonly config: RuntimeConfig) { this.mode = config.environment === "test" && config.testSigning ? "test" : "disabled"; }
  async active(): Promise<SigningKey> {
    if (!this.config.testSigning) throw new ApiError(503, "signing_unavailable");
    return this.version(this.config.testSigning.keyId);
  }
  async version(id: string): Promise<SigningKey> {
    if (this.mode !== "test" || !TEST_KEY_ID.test(id)) throw new ApiError(503, "signing_unavailable");
    try {
      const directory = await realpath(resolve("test-keys"));
      const root = await realpath(resolve("."));
      if (!directory.toLowerCase().startsWith((root + sep).toLowerCase())) throw new Error("Invalid Test key directory.");
      const file = await realpath(resolve(directory, `${id}.pem`));
      if (!file.toLowerCase().startsWith((directory + sep).toLowerCase())) throw new Error("Invalid Test key path.");
      return new TestSigningKey(id, createPrivateKey(await readFile(file, "utf8")));
    } catch { throw new ApiError(503, "signing_unavailable"); }
  }
}
