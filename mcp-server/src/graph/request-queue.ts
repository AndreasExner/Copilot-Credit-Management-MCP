import { ServiceError } from "../errors.js";

export class RequestQueue {
  private tail: Promise<void> = Promise.resolve();
  private queued = 0;
  private lastFinished = 0;
  private notBefore = 0;

  constructor(
    private readonly intervalMs: number,
    private readonly maxQueued: number,
  ) {}

  defer(seconds: number): void {
    this.notBefore = Math.max(this.notBefore, Date.now() + seconds * 1000);
  }

  async run<T>(operation: () => Promise<T>, deadline: number): Promise<T> {
    if (this.queued >= this.maxQueued) {
      throw new ServiceError("busy", "The Graph request queue is full. Retry later.", 429, 5);
    }
    this.queued++;
    let started = false;
    const scheduled = this.tail.then(async () => {
      try {
        const delay = Math.max(0, this.lastFinished + this.intervalMs - Date.now(), this.notBefore - Date.now());
        if (Date.now() + delay >= deadline) {
          throw new ServiceError("queue_timeout", "The Graph request could not start within its time budget.", 429, 5);
        }
        if (delay > 0) await new Promise<void>((resolve) => setTimeout(resolve, delay));
        if (Date.now() >= deadline) {
          throw new ServiceError("queue_timeout", "The Graph request expired before dispatch.", 429, 5);
        }
        started = true;
        try {
          return await operation();
        } finally {
          this.lastFinished = Date.now();
        }
      } finally {
        this.queued--;
      }
    });
    this.tail = scheduled.then(() => {}, () => {});
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(
        started
          ? new ServiceError("graph_timeout", "The Graph request exceeded its time budget.", 504)
          : new ServiceError("queue_timeout", "The Graph request exceeded its queue time budget.", 429, 5),
      ), Math.max(0, deadline - Date.now()));
    });
    try {
      return await Promise.race([scheduled, timeout]);
    } finally {
      clearTimeout(timer);
    }
  }
}
