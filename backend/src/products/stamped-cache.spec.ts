import { StampedCache } from './stamped-cache';

/** A load the test finishes by hand, counting how often it was started. */
function controlled<T>() {
  let calls = 0;
  let finish: (v: T) => void = () => undefined;
  let fail: (e: unknown) => void = () => undefined;
  const load = () => {
    calls++;
    return new Promise<T>((resolve, reject) => {
      finish = resolve;
      fail = reject;
    });
  };
  return { load, calls: () => calls, finish: (v: T) => finish(v), fail: (e: unknown) => fail(e) };
}

describe('StampedCache', () => {
  it('waits for the first load only, and loads once however many ask', async () => {
    const cache = new StampedCache<string>();
    const l = controlled<string>();
    const a = cache.get('org', 's1', l.load);
    const b = cache.get('org', 's1', l.load);
    l.finish('v1');
    expect(await a).toBe('v1');
    expect(await b).toBe('v1');
    expect(l.calls()).toBe(1);
    expect(await cache.get('org', 's1', l.load)).toBe('v1');
    expect(l.calls()).toBe(1);
  });

  it('answers a changed stamp at once with what it holds, and swaps in the reload when it lands', async () => {
    const cache = new StampedCache<string>();
    const first = controlled<string>();
    const p = cache.get('org', 's1', first.load);
    first.finish('v1');
    await p;

    const second = controlled<string>();
    expect(await cache.get('org', 's2', second.load)).toBe('v1'); // nobody waits for the reload
    expect(await cache.get('org', 's2', second.load)).toBe('v1'); // and it is not started twice
    expect(second.calls()).toBe(1);
    second.finish('v2');
    await new Promise((r) => setImmediate(r));
    expect(await cache.get('org', 's2', second.load)).toBe('v2');
  });

  it('keeps what it holds when a reload fails, reports it, and tries again next time', async () => {
    const errors: unknown[] = [];
    const cache = new StampedCache<string>((_key, err) => errors.push(err));
    const first = controlled<string>();
    const p = cache.get('org', 's1', first.load);
    first.finish('v1');
    await p;

    const broken = controlled<string>();
    expect(await cache.get('org', 's2', broken.load)).toBe('v1');
    broken.fail(new Error('db down'));
    await new Promise((r) => setImmediate(r));
    expect(errors).toHaveLength(1);

    const retry = controlled<string>();
    expect(await cache.get('org', 's2', retry.load)).toBe('v1');
    expect(retry.calls()).toBe(1);
  });

  it('lets a failed first load fail the caller', async () => {
    const cache = new StampedCache<string>();
    const l = controlled<string>();
    const p = cache.get('org', 's1', l.load);
    l.fail(new Error('db down'));
    await expect(p).rejects.toThrow('db down');
  });
});
