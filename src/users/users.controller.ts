import { Body, Controller, Get, HttpCode, Inject, Post, Query, Req } from "@nestjs/common";
import type { AuthenticatedRequest } from "../auth/auth.guard";
import { AccountRepository } from "./account.repository";
import { EmptyInputPipe } from "./empty-input.pipe";

@Controller({ path: "users", version: "1" })
export class UsersController {
  constructor(@Inject(AccountRepository) private readonly accounts: AccountRepository) {}

  @Post("me")
  @HttpCode(200)
  createOrResume(
    @Req() request: AuthenticatedRequest,
    @Body(EmptyInputPipe) _body: unknown,
    @Query(EmptyInputPipe) _query: unknown,
  ) {
    // Decorated inputs are validated by their pipes; only the trusted principal is persisted.
    void _body;
    void _query;
    return this.accounts.createOrResume(request.identity);
  }

  @Get("me")
  async readOwn(@Req() request: AuthenticatedRequest, @Query(EmptyInputPipe) _query: unknown) {
    void _query;
    return { account: await this.accounts.readOwn(request.identity) };
  }
}
