import { Body, Controller, Get, Headers, HttpCode, Inject, Param, ParseUUIDPipe, Post, Query, Req } from "@nestjs/common";
import type { AuthenticatedRequest } from "../auth/auth.guard";
import { EmptyInputPipe } from "../users/empty-input.pipe";
import { ApiError } from "../http/api-error";
// eslint-disable-next-line @typescript-eslint/consistent-type-imports -- Nest needs the DTO value in emitted validation metadata.
import { SubmitVerificationDto } from "./submit-verification.dto";
import { VerificationService } from "./verification.service";

const uuid = new ParseUUIDPipe({ version: "4", exceptionFactory: () => new ApiError(400, "invalid_request") });

@Controller({ path: "verifications", version: "1" })
export class VerificationController {
  constructor(@Inject(VerificationService) private readonly service: VerificationService) {}

  @Post()
  @HttpCode(200)
  async submit(@Req() request: AuthenticatedRequest, @Body() input: SubmitVerificationDto,
    @Headers("idempotency-key") key: string, @Query(EmptyInputPipe) _query: unknown) {
    void _query;
    // Header is a UUID only, scoped to the authenticated account. Inputs never
    // enter the idempotency ledger and replays cannot replace an existing result.
    const submissionKey = await uuid.transform(key, { type: "custom" });
    return this.service.submit(request.identity, submissionKey.toLowerCase(), input);
  }

  @Get(":id")
  read(@Req() request: AuthenticatedRequest, @Param("id", uuid) id: string, @Query(EmptyInputPipe) _query: unknown) {
    void _query;
    return this.service.read(request.identity, id);
  }
}
