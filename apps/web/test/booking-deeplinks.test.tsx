import { describe, expect, it } from "vitest";
import { webRouteForDeepLink } from "../src/pages/notifications/deepLinks";

const ID = "3F2504E0-4F89-41D3-9A0C-0305E82C3301";

describe("webRouteForDeepLink", () => {
  it("maps reservation and lesson-slot links to the Web detail routes (lower-cased ids)", () => {
    expect(webRouteForDeepLink(`arms://reservations/${ID}`)).toEqual({ to: `/bookings/reservations/${ID.toLowerCase()}`, label: "予約の詳細を開く" });
    expect(webRouteForDeepLink(`arms://lesson-slots/${ID}`)).toEqual({ to: `/bookings/slots/${ID.toLowerCase()}`, label: "授業枠を開く" });
  });

  it("maps today's lessons to the dashboard and user management to settings", () => {
    expect(webRouteForDeepLink("arms://lessons/today")?.to).toBe("/dashboard");
    expect(webRouteForDeepLink("arms://settings/users")?.to).toBe("/settings/users");
  });

  it("rejects unknown or malformed links so they can never navigate elsewhere", () => {
    for (const link of [
      "",
      null,
      undefined,
      "https://evil.example/reservations/1",
      "arms://reservations/not-a-uuid",
      `arms://reservations/${ID}/../../admin`,
      `arms://reservations/${ID}?x=1`,
      "javascript:alert(1)",
      "arms://unknown/route",
    ]) {
      expect(webRouteForDeepLink(link)).toBeNull();
    }
  });
});
