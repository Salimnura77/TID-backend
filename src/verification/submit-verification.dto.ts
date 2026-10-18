import { IsString, Matches, MaxLength, MinLength } from "class-validator";
import type { VerificationInput } from "./verification.provider";

export class SubmitVerificationDto implements VerificationInput {
  @IsString()
  @Matches(/^\d{11}$/)
  nin!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(100)
  @Matches(/^[^\x00-\x1f\x7f]+$/)
  firstname!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(100)
  @Matches(/^[^\x00-\x1f\x7f]+$/)
  lastname!: string;
}
