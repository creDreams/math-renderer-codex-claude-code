/** Entry and byte limits apply together. Reads promote an entry to most recent. */
export class LruCache<T> {
  private readonly entries = new Map<string, { value: T; bytes: number }>();
  private used = 0;
  constructor(readonly maxEntries: number, readonly maxBytes: number) {}
  get size() { return this.entries.size; }
  get bytes() { return this.used; }
  get(key: string): T | undefined {
    const entry = this.entries.get(key);
    if (!entry) return;
    this.entries.delete(key); this.entries.set(key, entry);
    return entry.value;
  }
  set(key: string, value: T, bytes: number): void {
    const previous = this.entries.get(key);
    if (previous) { this.used -= previous.bytes; this.entries.delete(key); }
    if (!Number.isFinite(bytes) || bytes < 0 || bytes > this.maxBytes || this.maxEntries < 1) return;
    this.entries.set(key, { value, bytes }); this.used += bytes;
    while (this.size > this.maxEntries || this.used > this.maxBytes) {
      const first = this.entries.keys().next().value!;
      this.used -= this.entries.get(first)!.bytes; this.entries.delete(first);
    }
  }
  clear(): void { this.entries.clear(); this.used = 0; }
}
