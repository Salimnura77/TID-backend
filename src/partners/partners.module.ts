import { Module } from "@nestjs/common";
import { DatabaseModule } from "../database/database.module";
import { PartnersService } from "./partners.service";

// Owns registered partner clients and stable pairwise identifiers; cannot authorize disclosure.
@Module({ imports: [DatabaseModule], providers: [PartnersService], exports: [PartnersService] })
export class PartnersModule {}
