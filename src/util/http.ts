import { fetch as undiciFetch } from "undici";

type FetchInput = Parameters<typeof undiciFetch>[0];
type FetchInit = Parameters<typeof undiciFetch>[1];
type FetchResponse = Awaited<ReturnType<typeof undiciFetch>>;

export async function fetchHttp(input: FetchInput, init?: FetchInit): Promise<FetchResponse> {
  if (typeof globalThis.fetch === "function") {
    return globalThis.fetch(input as never, init as never) as unknown as FetchResponse;
  }

  return undiciFetch(input, init);
}
