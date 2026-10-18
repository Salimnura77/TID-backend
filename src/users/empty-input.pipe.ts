import { Injectable } from "@nestjs/common";
import type { PipeTransform } from "@nestjs/common";
import { ApiError } from "../http/api-error";

@Injectable()
export class EmptyInputPipe implements PipeTransform {
  transform(value: unknown): undefined {
    if (value !== undefined && (value === null || typeof value !== "object" || Array.isArray(value) || Object.keys(value).length > 0)) {
      throw new ApiError(400, "invalid_request");
    }
    return undefined;
  }
}
