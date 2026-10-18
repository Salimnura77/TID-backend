import { Module } from "@nestjs/common";
import { DatabaseModule } from "../database/database.module";
import { AccountRepository } from "./account.repository";
import { UsersController } from "./users.controller";
import { EmptyInputPipe } from "./empty-input.pipe";
import { AccountAccessService } from "./account-access.service";

// Owns private internal accounts and authentication bindings, never partner-facing identifiers.
@Module({ imports: [DatabaseModule], controllers: [UsersController], providers: [AccountRepository, EmptyInputPipe, AccountAccessService], exports: [AccountAccessService] })
export class UsersModule {}
