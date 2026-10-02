import { QueryClient, useMutation, type UseMutationOptions } from "@tanstack/react-query";
import { useRef } from "react";
import { ApiError, NetworkError } from "./api";

export function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: 15_000,
        refetchOnWindowFocus: true,
        // Client errors are final; transient server/network failures retry with backoff.
        retry: (count, error) => {
          if (error instanceof ApiError && error.status < 500 && error.status !== 429) return false;
          return count < 2;
        },
      },
      mutations: { retry: false },
    },
  });
}

/**
 * Mutation whose function receives a stable Idempotency-Key per user action: retrying the same variables after a
 * failure (e.g. network loss) reuses the key, so the server returns the original result instead of acting twice.
 * A new key is generated after success or when the variables change.
 */
export function useIdempotentMutation<TData, TVariables>(
  fn: (variables: TVariables, idempotencyKey: string) => Promise<TData>,
  options: Omit<UseMutationOptions<TData, Error, TVariables>, "mutationFn"> = {},
) {
  const attempt = useRef<{ signature: string; key: string; done: boolean } | null>(null);
  return useMutation<TData, Error, TVariables>({
    ...options,
    mutationFn: async (variables) => {
      const signature = JSON.stringify(variables ?? null);
      if (!attempt.current || attempt.current.done || attempt.current.signature !== signature) {
        attempt.current = { signature, key: crypto.randomUUID(), done: false };
      }
      const current = attempt.current;
      try {
        const result = await fn(variables, current.key);
        current.done = true;
        return result;
      } catch (e) {
        // A definitive server rejection (4xx except 409 in-progress) ends this attempt; network errors keep the key.
        if (e instanceof ApiError && e.status < 500 && e.code !== "IDEMPOTENCY_IN_PROGRESS") current.done = true;
        if (!(e instanceof NetworkError) && !(e instanceof ApiError)) current.done = true;
        throw e;
      }
    },
  });
}
