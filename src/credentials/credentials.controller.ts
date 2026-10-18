import { Body, Controller, Get, HttpCode, Inject, Param, ParseUUIDPipe, Post, Query, Req } from "@nestjs/common";
import type { AuthenticatedRequest } from "../auth/auth.guard";
import { ApiError } from "../http/api-error";
import { EmptyInputPipe } from "../users/empty-input.pipe";
// eslint-disable-next-line @typescript-eslint/consistent-type-imports -- Nest requires DTO values in emitted validation metadata.
import { CheckCredentialDto, IssueCredentialDto } from "./credential.dto";
import { CredentialsService } from "./credentials.service";

const uuid = new ParseUUIDPipe({ version: "4", exceptionFactory: () => new ApiError(400, "invalid_request") });
@Controller({ path: "credentials", version: "1" })
export class CredentialsController {
  constructor(@Inject(CredentialsService) private readonly service: CredentialsService) {}
  @Post()
  @HttpCode(200)
  issue(@Req() request: AuthenticatedRequest, @Body() input: IssueCredentialDto, @Query(EmptyInputPipe) _query: unknown) {
    void _query; return this.service.issue(request.identity, input.verificationId);
  }
  @Post("check")
  @HttpCode(200)
  check(@Req() request: AuthenticatedRequest, @Body() input: CheckCredentialDto, @Query(EmptyInputPipe) _query: unknown) {
    void _query; return this.service.check(request.identity, input.credential);
  }
  @Get(":id/status")
  status(@Req() request: AuthenticatedRequest, @Param("id", uuid) id: string, @Query(EmptyInputPipe) _query: unknown) {
    void _query; return this.service.status(request.identity, id);
  }
  @Post(":id/revoke")
  @HttpCode(200)
  revoke(@Req() request: AuthenticatedRequest, @Param("id", uuid) id: string,
    @Body(EmptyInputPipe) _body: unknown, @Query(EmptyInputPipe) _query: unknown) {
    void _body; void _query; return this.service.revoke(request.identity, id);
  }
}
