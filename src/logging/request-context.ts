import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { Injectable } from "@nestjs/common";

@Injectable()
export class RequestContext {
  private readonly storage = new AsyncLocalStorage<{ requestId: string }>();

  get requestId(): string | undefined { return this.storage.getStore()?.requestId; }

  withRequest<T>(work: () => T): T {
    // Always server-generated. Never reuse a caller's header, token, or identity value.
    return this.storage.run({ requestId: randomUUID() }, work);
  }
}
