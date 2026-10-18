import { ArrayMaxSize, ArrayMinSize, ArrayUnique, IsArray, IsIn, IsInt, IsISO8601, IsOptional, IsString, IsUUID, Matches, MaxLength, Min, MinLength } from "class-validator";
import { SHAREABLE_ATTRIBUTES } from "./consent";
import type { ShareableAttribute } from "./consent";

const utcInstant = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
export class InvitationDto {
  @IsUUID("4") partnerId!: string;
  @IsUUID("4") credentialId!: string;
}
export class RequestDto {
  @IsString() @Matches(/^[A-Za-z0-9_-]{43}$/) invitation!: string;
  @IsString() @MinLength(1) @MaxLength(200) @Matches(/^[^\s\x00-\x1f\x7f](?:[^\x00-\x1f\x7f]*[^\s\x00-\x1f\x7f])?$/u) purpose!: string;
  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(2) @ArrayUnique() @IsIn(SHAREABLE_ATTRIBUTES, { each: true }) attributes!: ShareableAttribute[];
  @IsISO8601({ strict: true }) @Matches(utcInstant) expiresAt!: string;
}
export class DecisionDto {
  @IsIn(["approve", "decline"]) decision!: "approve" | "decline";
  @IsInt() @Min(0) revision!: number;
  @IsOptional() @IsArray() @ArrayMinSize(1) @ArrayMaxSize(2) @ArrayUnique() @IsIn(SHAREABLE_ATTRIBUTES, { each: true }) attributes?: ShareableAttribute[];
  @IsOptional() @IsISO8601({ strict: true }) @Matches(utcInstant) expiresAt?: string;
}
export class DisclosureDto {
  @IsString() @MinLength(1) @MaxLength(200) purpose!: string;
  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(2) @ArrayUnique() @IsIn(SHAREABLE_ATTRIBUTES, { each: true }) attributes!: ShareableAttribute[];
  @IsISO8601({ strict: true }) @Matches(utcInstant) expiresAt!: string;
  @IsInt() @Min(1) revision!: number;
}
