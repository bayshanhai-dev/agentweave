import { describe, expect, it } from "vitest";
import { AsyncResultCache } from "../src/metrics-cache.js";

describe("metrics collection cache", () => {
  it("coalesces concurrent scrapes into one database collection", async () => {
    let now = 0;
    let calls = 0;
    const cache = new AsyncResultCache(15_000, () => now);
    let release!: () => void;
    const pending = new Promise<string>((resolve) => { release = () => resolve("samples"); });
    const loader = async () => { calls += 1; return pending; };
    const first = cache.get(loader);
    const second = cache.get(loader);
    expect(calls).toBe(1);
    release();
    await expect(Promise.all([first, second])).resolves.toEqual(["samples", "samples"]);
    expect(await cache.get(loader)).toBe("samples");
    expect(calls).toBe(1);
    now = 15_001;
    await cache.get(async () => { calls += 1; return "fresh"; });
    expect(calls).toBe(2);
  });
});
