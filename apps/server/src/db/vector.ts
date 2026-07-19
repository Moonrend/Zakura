import { customType } from "drizzle-orm/pg-core";

/** Unbounded pgvector column (works on Postgres + PGlite with vector extension). */
export const vectorColumn = customType<{ data: number[]; driverData: string }>({
  dataType() {
    return "vector";
  },
  toDriver(value: number[]): string {
    return `[${value.map((n) => Number(n)).join(",")}]`;
  },
  fromDriver(value: unknown): number[] {
    if (Array.isArray(value)) return value.map(Number);
    if (typeof value === "string") {
      const inner = value.trim().replace(/^\[/, "").replace(/\]$/, "");
      if (!inner) return [];
      return inner.split(",").map((s) => Number(s.trim()));
    }
    return [];
  },
});

export function toVectorLiteral(values: number[]): string {
  return `[${values.map((n) => Number(n)).join(",")}]`;
}
