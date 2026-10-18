import { Body, Controller, Get, HttpCode, Inject, Param, ParseUUIDPipe, Post, Query, Req } from "@nestjs/common";
import type { AuthenticatedRequest, PartnerRequest } from "../auth/auth.guard";
import { ApiError } from "../http/api-error";
import { PartnerRoute } from "../partners/partner-route.decorator";
import { EmptyInputPipe } from "../users/empty-input.pipe";
// eslint-disable-next-line @typescript-eslint/consistent-type-imports -- Nest requires DTO values in emitted validation metadata.
import { DecisionDto, DisclosureDto, InvitationDto, RequestDto } from "./consent.dto";
import { ConsentService } from "./consent.service";
// eslint-disable-next-line @typescript-eslint/consistent-type-imports -- Nest requires DTO values in emitted validation metadata.
import { ConsentHistoryQueryDto } from "../audit/consent-history.dto";

const uuid = new ParseUUIDPipe({ version: "4", exceptionFactory: () => new ApiError(400, "invalid_request") });
@Controller({ path: "consent", version: "1" })
export class ConsentController {
  constructor(@Inject(ConsentService) private readonly service: ConsentService) {}
  @Get("partners/:id")
  partner(@Req() request: AuthenticatedRequest, @Param("id", uuid) id: string, @Query(EmptyInputPipe) _query: unknown) {
    void _query; return this.service.partner(request.identity, id);
  }
  @Post("invitations") @HttpCode(200)
  invite(@Req() request: AuthenticatedRequest, @Body() input: InvitationDto, @Query(EmptyInputPipe) _query: unknown) {
    void _query; return this.service.invite(request.identity, input);
  }
  @Get("requests")
  list(@Req() request: AuthenticatedRequest, @Query(EmptyInputPipe) _query: unknown) {
    void _query; return this.service.list(request.identity);
  }
  @Get("requests/:id")
  read(@Req() request: AuthenticatedRequest, @Param("id", uuid) id: string, @Query(EmptyInputPipe) _query: unknown) {
    void _query; return this.service.read(request.identity, id);
  }
  @Get("requests/:id/history")
  history(@Req() request: AuthenticatedRequest, @Param("id", uuid) id: string, @Query() query: ConsentHistoryQueryDto) {
    return this.service.history(request.identity, id, query.cursor);
  }
  @Post("requests/:id/decision") @HttpCode(200)
  decide(@Req() request: AuthenticatedRequest, @Param("id", uuid) id: string, @Body() input: DecisionDto, @Query(EmptyInputPipe) _query: unknown) {
    void _query; return this.service.decide(request.identity, id, input);
  }
  @Post("requests/:id/revoke") @HttpCode(200)
  revoke(@Req() request: AuthenticatedRequest, @Param("id", uuid) id: string, @Body(EmptyInputPipe) _body: unknown, @Query(EmptyInputPipe) _query: unknown) {
    void _body; void _query; return this.service.revoke(request.identity, id);
  }
}

@PartnerRoute()
@Controller({ path: "partner/requests", version: "1" })
export class PartnerRequestsController {
  constructor(@Inject(ConsentService) private readonly service: ConsentService) {}
  @Post() @HttpCode(200) @PartnerRoute("requests:create")
  create(@Req() request: PartnerRequest, @Body() input: RequestDto, @Query(EmptyInputPipe) _query: unknown) {
    void _query; return this.service.request(request.partner, input);
  }
  @Get(":id") @PartnerRoute("requests:read")
  read(@Req() request: PartnerRequest, @Param("id", uuid) id: string, @Query(EmptyInputPipe) _query: unknown) {
    void _query; return this.service.partnerRead(request.partner, id);
  }
  @Post(":id/disclosure") @HttpCode(200) @PartnerRoute("disclosures:create")
  disclose(@Req() request: PartnerRequest, @Param("id", uuid) id: string, @Body() input: DisclosureDto, @Query(EmptyInputPipe) _query: unknown) {
    void _query; return this.service.disclose(request.partner, id, input);
  }
}
