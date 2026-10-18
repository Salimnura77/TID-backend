import { SetMetadata } from "@nestjs/common";

export const PUBLIC_ROUTE = Symbol("TRUEID_PUBLIC_ROUTE");
export const Public = () => SetMetadata(PUBLIC_ROUTE, true);
