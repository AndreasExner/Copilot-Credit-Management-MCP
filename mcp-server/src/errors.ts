export class ServiceError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status = 500,
    readonly retryAfterSeconds?: number,
    readonly upstreamRequestId?: string,
  ) {
    super(message);
    this.name = "ServiceError";
  }

  toJSON() {
    return {
      code: this.code,
      message: this.message,
      status: this.status,
      ...(this.retryAfterSeconds !== undefined
        ? { retryAfterSeconds: this.retryAfterSeconds }
        : {}),
      ...(this.upstreamRequestId ? { requestId: this.upstreamRequestId } : {}),
    };
  }
}

export function safeError(error: unknown): ServiceError {
  if (error instanceof ServiceError) return error;
  return new ServiceError("internal_error", "The request failed. Use its correlation ID for support.");
}
