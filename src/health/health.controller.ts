import { Controller, Get, Inject } from "@nestjs/common";
import { DatabaseService } from "../database/database.service";
import { ApiError } from "../http/api-error";
import { Public } from "../auth/public.decorator";

@Public()
@Controller({ path: "health", version: "1" })
export class HealthController {
  constructor(@Inject(DatabaseService) private readonly database: DatabaseService) {}

  @Get()
  async readiness(): Promise<{ demo: true; status: "ready" }> {
    try { await this.database.assertReady(); }
    catch { throw new ApiError(503, "service_unavailable"); }
    return { demo: true, status: "ready" };
  }

  @Get("live")
  liveness(): { demo: true; status: "alive" } {
    return { demo: true, status: "alive" };
  }
}
