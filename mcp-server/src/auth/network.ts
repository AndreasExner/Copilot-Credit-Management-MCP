import type { INetworkModule, NetworkRequestOptions, NetworkResponse } from "@azure/msal-node";
import { ServiceError } from "../errors.js";

export function createAuthenticationNetwork(
  signal: AbortSignal,
  fetcher: typeof fetch = fetch,
): INetworkModule {
  async function request<T>(
    method: "GET" | "POST",
    address: string,
    options?: NetworkRequestOptions,
    timeout?: number,
  ): Promise<NetworkResponse<T>> {
    const url = new URL(address);
    if (url.protocol !== "https:" || url.hostname !== "login.microsoftonline.com" ||
      url.username || url.password || url.port) {
      throw new ServiceError("invalid_authority", "An untrusted authentication endpoint was rejected.", 502);
    }
    signal.throwIfAborted();
    const response = await fetcher(address, {
      method,
      headers: options?.headers,
      ...(method === "POST" && options?.body !== undefined ? { body: options.body } : {}),
      redirect: "error",
      signal: timeout && timeout > 0
        ? AbortSignal.any([signal, AbortSignal.timeout(timeout)]) : signal,
    });
    const body: T = await response.json();
    return { status: response.status, headers: Object.fromEntries(response.headers), body };
  }
  return {
    sendGetRequestAsync: <T>(url: string, options?: NetworkRequestOptions, timeout?: number) =>
      request<T>("GET", url, options, timeout),
    sendPostRequestAsync: <T>(url: string, options?: NetworkRequestOptions) =>
      request<T>("POST", url, options),
  };
}
