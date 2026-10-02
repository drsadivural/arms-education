import { describe, expect, it } from "vitest";
import { QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { NetworkError, ApiError } from "../src/lib/api";
import { createQueryClient, useIdempotentMutation } from "../src/lib/query";

function wrapper({ children }: { children: ReactNode }) {
  return <QueryClientProvider client={createQueryClient()}>{children}</QueryClientProvider>;
}

describe("useIdempotentMutation", () => {
  it("reuses the key when the same action is retried after a network failure", async () => {
    const keys: string[] = [];
    let fail = true;
    const { result } = renderHook(
      () =>
        useIdempotentMutation(async (_v: { slot: string }, key: string) => {
          keys.push(key);
          if (fail) throw new NetworkError();
          return "ok";
        }),
      { wrapper },
    );
    await act(async () => {
      await result.current.mutateAsync({ slot: "A" }).catch(() => undefined);
    });
    fail = false;
    await act(async () => {
      await result.current.mutateAsync({ slot: "A" });
    });
    expect(keys[0]).toBe(keys[1]);
    await act(async () => {
      await result.current.mutateAsync({ slot: "A" });
    });
    expect(keys[2]).not.toBe(keys[1]);
  });

  it("uses a new key for different variables or after a definitive rejection", async () => {
    const keys: string[] = [];
    const { result } = renderHook(
      () =>
        useIdempotentMutation(async (v: { slot: string }, key: string) => {
          keys.push(key);
          if (v.slot === "full") throw new ApiError(409, { code: "SLOT_FULL", message_ja: "この授業は満席です。" });
          return "ok";
        }),
      { wrapper },
    );
    await act(async () => {
      await result.current.mutateAsync({ slot: "full" }).catch(() => undefined);
      await result.current.mutateAsync({ slot: "full" }).catch(() => undefined);
      await result.current.mutateAsync({ slot: "B" });
    });
    expect(new Set(keys).size).toBe(3);
  });
});
