import { IsOptional, IsUUID } from "class-validator";

export class ConsentHistoryQueryDto {
  @IsOptional() @IsUUID("4") cursor?: string;
}
