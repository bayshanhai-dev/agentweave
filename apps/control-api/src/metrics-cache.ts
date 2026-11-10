export class AsyncResultCache<T> {
  private value: T | undefined;
  private expiresAt = 0;
  private pending: Promise<T> | undefined;

  constructor(private readonly ttlMs: number, private readonly now: () => number = Date.now) {}

  async get(loader: () => Promise<T>): Promise<T> {
    if (this.value !== undefined && this.now() < this.expiresAt) return this.value;
    if (this.pending) return this.pending;
    this.pending = loader().then((value) => {
      this.value = value;
      this.expiresAt = this.now() + this.ttlMs;
      return value;
    }).finally(() => { this.pending = undefined; });
    return this.pending;
  }
}
