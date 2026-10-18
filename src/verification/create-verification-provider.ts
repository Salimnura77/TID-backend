import { ConfigurationError } from "../config/runtime-config";
import type { RuntimeConfig } from "../config/runtime-config";
import { MonnifyProvider } from "./monnify-provider";
import { QoreidProvider } from "./qoreid-provider";
import type { VerificationProvider } from "./verification.provider";

export function createVerificationProvider(config: RuntimeConfig): VerificationProvider {
  switch (config.verificationProvider) {
    case "monnify": return new MonnifyProvider();
    case "qoreid": return new QoreidProvider(config.qoreid);
    default: throw new ConfigurationError("TRUEID_VERIFICATION_PROVIDER");
  }
}
