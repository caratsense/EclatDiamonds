/**
 * One value per key, reloaded when its stamp changes, where only the very first
 * load is waited for. After that a changed stamp returns the value already held
 * and reloads behind it: a search must never wait ~30 s for the whole catalogue
 * index because one photo was added or the server restarted. One load per key at
 * a time, however many callers ask.
 */
export class StampedCache<T> {
  private readonly held = new Map<string, { stamp: string; value: T }>();
  private readonly loading = new Map<string, Promise<T>>();

  constructor(private readonly onReloadError: (key: string, err: unknown) => void = () => undefined) {}

  async get(key: string, stamp: string, load: () => Promise<T>): Promise<T> {
    const have = this.held.get(key);
    if (have?.stamp === stamp) return have.value;
    const next = this.reload(key, stamp, load);
    if (!have) return next;
    next.catch((err) => this.onReloadError(key, err));
    return have.value;
  }

  private reload(key: string, stamp: string, load: () => Promise<T>): Promise<T> {
    const running = this.loading.get(key);
    if (running) return running;
    const p = load()
      .then((value) => {
        this.held.set(key, { stamp, value });
        return value;
      })
      .finally(() => this.loading.delete(key));
    this.loading.set(key, p);
    return p;
  }
}
