import { describe, expect, test } from "bun:test";
import {
  type BulkMediaAdapter,
  type BulkMediaItem,
  BulkMediaQueue,
  type BulkMediaSnapshot,
  type MediaDirection,
} from "./bulk-media";

const item = (key: string): BulkMediaItem => ({
  key,
  src: `https://media.test/${key}.jpg`,
  fallbackName: "image",
});
const until = (queue: BulkMediaQueue, predicate: (state: BulkMediaSnapshot) => boolean) =>
  new Promise<BulkMediaSnapshot>((resolve) => {
    let initial = true;
    let unsubscribe = () => {};
    unsubscribe = queue.subscribe((state) => {
      if (initial) return;
      if (!predicate(state)) return;
      unsubscribe();
      resolve(state);
    });
    initial = false;
  });
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

function adapter(
  keys: string[],
  options: { fail?: Set<string>; holdSave?: { promise: Promise<void> }; chat?: () => boolean } = {},
) {
  let index = 0;
  const saved: string[] = [];
  const advanced: MediaDirection[] = [];
  const value: BulkMediaAdapter = {
    current: () => (keys[index] ? item(keys[index]!) : null),
    save: async (media) => {
      if (options.holdSave) await options.holdSave.promise;
      if (options.fail?.delete(media.key)) throw new Error("native download failed");
      saved.push(media.key);
    },
    advance: async (direction) => {
      advanced.push(direction);
      index += 1;
      return index < keys.length;
    },
    stillInChat: () => options.chat?.() ?? true,
  };
  return { value, saved, advanced };
}

describe("BulkMediaQueue", () => {
  test("saves sequentially from the selected starting item and direction", async () => {
    const harness = adapter(["one", "two"]);
    const queue = new BulkMediaQueue(harness.value, "chat-a");
    const finished = until(queue, (state) => state.status === "complete");
    queue.start("newer");
    const state = await finished;
    expect(harness.saved).toEqual(["one", "two"]);
    expect(harness.advanced).toEqual(["newer", "newer"]);
    expect(state.counts).toEqual({ saved: 2, skipped: 0, failed: 0 });
    expect(state.reason).toContain("end of available media");
  });

  test("pause waits after the active save, resume continues, and reset stops navigation", async () => {
    let resolveSave!: () => void;
    const hold = {
      promise: new Promise<void>((resolve) => {
        resolveSave = resolve;
      }),
    };
    const harness = adapter(["one", "two"], { holdSave: hold });
    const queue = new BulkMediaQueue(harness.value, "chat-pause");
    queue.start("older");
    await tick();
    queue.pause();
    resolveSave();
    await until(queue, (state) => state.status === "paused" && state.counts.saved === 1);
    expect(harness.advanced).toEqual([]);
    queue.resume();
    await until(queue, (state) => state.status === "complete");
    expect(harness.saved).toEqual(["one", "two"]);

    let resolveSecond!: () => void;
    const secondHold = {
      promise: new Promise<void>((resolve) => {
        resolveSecond = resolve;
      }),
    };
    const resetHarness = adapter(["one"], { holdSave: secondHold });
    const resetQueue = new BulkMediaQueue(resetHarness.value, "chat-reset");
    resetQueue.start("older");
    await tick();
    resetQueue.reset();
    resolveSecond();
    await tick();
    expect(resetHarness.advanced).toEqual([]);
    expect(resetQueue.state.status).toBe("idle");
  });

  test("failed items remain retryable; successful items are skipped per chat session", async () => {
    const fail = new Set(["one"]);
    const harness = adapter(["one"], { fail });
    harness.value.advance = async () => false;
    const queue = new BulkMediaQueue(harness.value, "chat-retry");
    const first = until(queue, (state) => state.status === "complete");
    queue.start("older");
    expect((await first).counts).toEqual({ saved: 0, skipped: 0, failed: 1 });
    await tick();

    const retry = until(queue, (state) => state.status === "complete");
    queue.start("older");
    expect((await retry).counts).toEqual({ saved: 1, skipped: 0, failed: 0 });
    await tick();

    const reopenedQueue = new BulkMediaQueue(harness.value, "chat-retry");
    const duplicate = until(reopenedQueue, (state) => state.status === "complete");
    reopenedQueue.start("older");
    expect((await duplicate).counts).toEqual({ saved: 0, skipped: 1, failed: 0 });
    expect(harness.saved).toEqual(["one"]);
  });

  test("navigation exceptions stop with a reason instead of reporting completion", async () => {
    const harness = adapter(["one"]);
    harness.value.advance = async () => {
      throw new Error("No recognized Previous/Next control");
    };
    const queue = new BulkMediaQueue(harness.value, "chat-no-navigation");
    const stopped = until(queue, (state) => state.status === "stopped");
    queue.start("older");
    const state = await stopped;
    expect(state.reason).toContain("No recognized Previous/Next control");
    expect(state.status).toBe("stopped");
  });

  test("canceling a queue during a save prevents navigation into a replacement viewer", async () => {
    let resolveSave!: () => void;
    const hold = {
      promise: new Promise<void>((resolve) => {
        resolveSave = resolve;
      }),
    };
    const harness = adapter(["one", "two"], { holdSave: hold });
    const queue = new BulkMediaQueue(harness.value, "chat-replaced");
    queue.start("older");
    await tick();
    queue.cancel("Stopped because the chat or media viewer changed.");
    expect(queue.state.status).toBe("stopping");
    resolveSave();
    await tick();
    expect(harness.advanced).toEqual([]);
    expect(queue.state.status).toBe("idle");

    const reopened = adapter(["one"]);
    reopened.value.advance = async () => false;
    const reopenedQueue = new BulkMediaQueue(reopened.value, "chat-replaced");
    const skipped = until(reopenedQueue, (state) => state.status === "complete");
    reopenedQueue.start("older");
    expect((await skipped).counts).toEqual({ saved: 0, skipped: 1, failed: 0 });
  });

  test("stops on a repeated item or a changed chat", async () => {
    const repeated = adapter(["same", "same"]);
    // Force navigation to the same key instead of ending after the first item.
    repeated.value.advance = async () => true;
    const queue = new BulkMediaQueue(repeated.value, "chat-loop");
    const repeatedDone = until(queue, (state) => state.status === "stopped");
    queue.start("older");
    expect((await repeatedDone).reason).toContain("repeated media");

    let inChat = true;
    const changed = adapter(["one"], { chat: () => inChat });
    changed.value.advance = async () => {
      inChat = false;
      return false;
    };
    const changedQueue = new BulkMediaQueue(changed.value, "chat-change");
    const changedDone = until(changedQueue, (state) => state.status === "stopped");
    changedQueue.start("newer");
    expect((await changedDone).reason).toContain("chat or media viewer changed");
  });
});
