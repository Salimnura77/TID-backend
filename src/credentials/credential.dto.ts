import { IsString, IsUUID, MaxLength, MinLength } from "class-validator";

export class IssueCredentialDto {
  @IsUUID("4")
  verificationId!: string;
}
export class CheckCredentialDto {
  @IsString()
  @MinLength(1)
  @MaxLength(4096)
  credential!: string;
}
