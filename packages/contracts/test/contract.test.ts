import { describe, expect, it } from "vitest";
import SwaggerParser from "@apidevtools/swagger-parser";
import type { z } from "zod";
import spec from "../openapi.json";
import * as schemas from "../src/schemas";
import { ERROR_CATALOG } from "../src/errors";
import { formatDateJa, isOverdue, parseDateOnly, zonedDateString, zonedDayRange, zonedMonthRange } from "../src/time";

const components = (spec as { components: { schemas: Record<string, { properties?: Record<string, unknown>; required?: string[] }> } }).components.schemas;

describe("effective OpenAPI contract", () => {
  it("is a valid OpenAPI 3.1 document with resolvable references", async () => {
    const api = await SwaggerParser.validate(structuredClone(spec) as never);
    const operations = Object.values(api.paths ?? {}).reduce((n, ops) => n + Object.keys(ops ?? {}).filter((k) => k !== "parameters").length, 0);
    expect(operations).toBeGreaterThanOrEqual(88);
  });

  const zodSchemas = Object.entries(schemas).filter(([name, v]) => components[name] && typeof (v as { safeParse?: unknown }).safeParse === "function");

  it("has Zod request schemas for the contract input schemas", () => {
    expect(zodSchemas.length).toBeGreaterThan(25);
  });

  for (const [name, schema] of zodSchemas) {
    it(`${name}: Zod properties and required fields match the contract`, () => {
      const shape = (schema as unknown as z.ZodObject).shape as Record<string, z.ZodType>;
      const contract = components[name] as { properties?: Record<string, unknown>; required?: string[] };
      expect(Object.keys(shape).sort()).toEqual(Object.keys(contract.properties ?? {}).sort());
      const requiredInZod = Object.entries(shape)
        .filter(([, s]) => !s.safeParse(undefined).success)
        .map(([k]) => k)
        .sort();
      expect(requiredInZod).toEqual([...(contract.required ?? [])].sort());
    });
  }
});

describe("error catalogue", () => {
  it("has a Japanese message and an HTTP status for every code", () => {
    for (const [code, e] of Object.entries(ERROR_CATALOG)) {
      expect(e.message_ja, code).toMatch(/[ぁ-んァ-ン一-龥]/);
      expect(e.status).toBeGreaterThanOrEqual(400);
    }
  });
});

describe("organisation-timezone dates", () => {
  it("computes the JST calendar date, not the UTC one", () => {
    expect(zonedDateString("2026-10-01T15:30:00Z")).toBe("2026-10-02");
    expect(zonedDateString("2026-10-01T14:59:59Z")).toBe("2026-10-01");
  });
  it("builds [start,end) instants for a JST day and month", () => {
    const d = zonedDayRange("2026-10-05");
    expect(d.start.toISOString()).toBe("2026-10-04T15:00:00.000Z");
    expect(d.end.toISOString()).toBe("2026-10-05T15:00:00.000Z");
    const m = zonedMonthRange("2026-12");
    expect(m.start.toISOString()).toBe("2026-11-30T15:00:00.000Z");
    expect(m.end.toISOString()).toBe("2026-12-31T15:00:00.000Z");
    expect(m.lastDay).toBe("2026-12-31");
  });
  it("rejects impossible dates and formats Japanese dates", () => {
    expect(parseDateOnly("2026-02-30")).toBeNull();
    expect(parseDateOnly("2019-08-31")).not.toBeNull();
    expect(formatDateJa("2026-10-05")).toBe("10月5日（月）");
    expect(formatDateJa("2019-08-31", { withYear: true })).toBe("2019年8月31日（土）");
  });
  it("derives overdue from the date-only due date and local today", () => {
    expect(isOverdue("2026-10-01", "2026-10-02", false)).toBe(true);
    expect(isOverdue("2026-10-02", "2026-10-02", false)).toBe(false);
    expect(isOverdue("2026-10-01", "2026-10-02", true)).toBe(false);
  });
});
