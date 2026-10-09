import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";
import type {
  availableGalleryYears,
  collectGalleryMedia,
  findMediaGallery,
  GalleryYearQueue as GalleryYearQueueType,
} from "./bulk-media-gallery";

const chromium =
  (Bun.env.CHROME_BIN && Bun.which(Bun.env.CHROME_BIN)) ||
  Bun.which("google-chrome") ||
  Bun.which("chromium");

test.skipIf(!chromium)(
  "finds a small shared-media gallery and excludes unrelated dated chat content",
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "carrier-gallery-"));
    try {
      const bundle = await build({
        stdin: {
          contents: `
          import { findMediaGallery, collectGalleryMedia, availableGalleryYears, GalleryYearQueue } from "./bulk-media-gallery";
          (${runFixture.toString()})(findMediaGallery, collectGalleryMedia, availableGalleryYears, GalleryYearQueue);
        `,
          resolveDir: import.meta.dir,
        },
        bundle: true,
        write: false,
      });
      const file = join(directory, "index.html");
      await writeFile(
        file,
        `<!doctype html><html><body><main id="page">
      <aside id="gallery" style="overflow-y:auto;width:300px;height:500px">
        <div><div><h3><span>June 2020</span></h3></div><div>
          <div role="button" tabindex="0" aria-label="View photo sent on June 26, 2020, 3:39 PM"><img alt="image-123"></div>
          <div role="button" tabindex="0" aria-label="View video sent on June 2, 2020, 11:05 AM"><img alt="video-456.mp4"></div>
        </div></div>
        <div><div><h3><span>December 2019</span></h3></div><div>
          <div role="button" tabindex="0" aria-label="Voir la photo envoyée le 31 décembre 2019, 23:59"><img alt="image-789"></div>
        </div></div>
      </aside>
      <aside id="chat" style="overflow-y:auto;width:300px;height:500px">
        <div><div><h3><span>June 2020</span></h3></div><div>
          <div role="button" tabindex="0" aria-label="View photo sent on June 26, 2020, 3:39 PM"><img alt="image-999"></div>
        </div></div>
      </aside>
      <pre id="result">RUNNING</pre></main><script>${bundle.outputFiles?.[0]?.text || ""}</script></body></html>`,
      );
      const process = Bun.spawn(
        [
          chromium!,
          "--headless",
          "--disable-gpu",
          "--no-sandbox",
          "--no-first-run",
          `--user-data-dir=${join(directory, "profile")}`,
          "--disable-background-networking",
          "--disable-component-update",
          "--disable-sync",
          "--no-default-browser-check",
          "--window-size=800,700",
          "--virtual-time-budget=15000",
          "--dump-dom",
          pathToFileURL(file).href,
        ],
        { stdout: "pipe", stderr: "pipe", timeout: 30_000, killSignal: "SIGKILL" },
      );
      const reader = process.stdout.getReader();
      const decoder = new TextDecoder();
      let output = "";
      while (!output.includes("</html>")) {
        const chunk = await reader.read();
        if (chunk.done) break;
        output += decoder.decode(chunk.value, { stream: true });
      }
      if (output.includes("</html>")) process.kill("SIGKILL");
      await process.exited;
      expect(output.match(/<pre id="result">([^<]+)/)?.[1]).toBe("PASS");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
  60_000,
);

async function runFixture(
  find: typeof findMediaGallery,
  collect: typeof collectGalleryMedia,
  years: typeof availableGalleryYears,
  Queue: typeof GalleryYearQueueType,
) {
  const result = document.getElementById("result")!;
  try {
    const gallery = find();
    if (gallery?.scroller.id !== "gallery") throw new Error("gallery scroller scope");
    const items = collect(gallery);
    if (items.length !== 3) throw new Error(`expected 3 dated media, received ${items.length}`);
    if (!items.some((item) => item.key.includes("video-456.mp4")))
      throw new Error("video tile omitted");
    if (items.some((item) => item.key.includes("image-999")))
      throw new Error("unrelated chat image included");
    if (years(gallery).join(",") !== "2020,2019") throw new Error("available year order");

    document.getElementById("gallery")!.remove();
    document.getElementById("chat")!.remove();
    const queueGallery = document.createElement("aside");
    queueGallery.id = "queue-gallery";
    queueGallery.style.cssText = "overflow-y:auto;width:320px;height:300px";
    document.body.append(queueGallery);
    let refuseClose = false;
    const addGroup = (
      heading: string,
      entries: Array<{ label: string; id: string; alt?: string }>,
    ) => {
      const group = document.createElement("div");
      group.style.minHeight = "180px";
      group.innerHTML = `<div><h3><span>${heading}</span></h3></div><div></div>`;
      const media = group.lastElementChild!;
      for (const entry of entries) {
        const tile = document.createElement("div");
        tile.setAttribute("role", "button");
        tile.setAttribute("tabindex", "0");
        tile.setAttribute("aria-label", entry.label);
        tile.innerHTML = `<img alt="${entry.alt || `image-${entry.id}`}">`;
        tile.addEventListener("click", () => {
          const viewer = document.createElement("div");
          viewer.setAttribute("role", "dialog");
          viewer.style.cssText = "position:fixed;inset:0;background:#111";
          viewer.innerHTML = `<img style="width:80vw;height:80vh" src="https://media.test/${entry.id}.jpg"><a download="${entry.id}.jpg" href="https://media.test/${entry.id}.jpg" style="position:absolute;top:5px;left:5px;width:20px;height:20px">download</a><button aria-label="Close" style="position:absolute;top:5px;right:5px;width:36px;height:36px">x</button>`;
          viewer.querySelector("button")!.addEventListener("click", () => {
            if (!refuseClose) setTimeout(() => viewer.remove(), 220);
          });
          document.body.append(viewer);
        });
        media.append(tile);
      }
      queueGallery.append(group);
    };
    addGroup("January 2021", [
      { label: "View photo sent on January 3, 2021, 9:00 AM", id: "2021" },
    ]);
    addGroup("June 2020", [
      { label: "View photo sent on June 26, 2020, 3:39 PM", id: "111" },
      { label: "View video sent on June 2, 2020, 11:05 AM", id: "222", alt: "video-456.mp4" },
    ]);
    let loadedOlderBoundary = false;
    setTimeout(() => {
      addGroup("December 2019", [
        { label: "Voir la photo envoyée le 31 décembre 2019, 23:59", id: "2019" },
      ]);
      loadedOlderBoundary = true;
    }, 1500);
    const queueMedia = find();
    if (!queueMedia || queueMedia.scroller !== queueGallery)
      throw new Error("queue gallery detection");
    const saved: string[] = [];
    const options = (destinationKey: string) => ({
      gallery: queueMedia,
      chatKey: "fixture-chat",
      destinationKey,
      stillInChat: () => true,
      save: async (item: { src: string }) => {
        saved.push(item.src);
      },
    });
    const finish = (queue: InstanceType<typeof Queue>) =>
      new Promise<import("./bulk-media").BulkMediaSnapshot>((resolve) => {
        let unsubscribe = () => {};
        unsubscribe = queue.subscribe((state) => {
          if (state.status !== "complete" && state.status !== "stopped") return;
          unsubscribe();
          resolve(state);
        });
      });
    const first = new Queue(options("downloads-a"));
    const firstDone = finish(first);
    first.start(2020);
    const firstState = await firstDone;
    if (firstState.status !== "complete" || firstState.counts.saved !== 2)
      throw new Error(
        `year queue target saves/completion: ${firstState.status}, ${firstState.counts.saved} saved, ${firstState.counts.failed} failed, ${firstState.reason}`,
      );
    if (!loadedOlderBoundary) throw new Error("delayed older boundary did not load");
    if (saved.length !== 2 || saved.some((src) => src.includes("2021") || src.includes("2019")))
      throw new Error("queue saved outside the selected year");

    const duplicate = new Queue(options("downloads-a"));
    const duplicateDone = finish(duplicate);
    duplicate.start(2020);
    const duplicateState = await duplicateDone;
    if (
      duplicateState.status !== "complete" ||
      duplicateState.counts.skipped !== 2 ||
      saved.length !== 2
    )
      throw new Error("destination scoped dedup");

    const separate = new Queue(options("downloads-b"));
    const separateDone = finish(separate);
    separate.start(2020);
    const separateState = await separateDone;
    if (
      separateState.status !== "complete" ||
      separateState.counts.saved !== 2 ||
      Number(saved.length) !== 4
    )
      throw new Error("destination dedup leaked");

    const canceled = new Queue(options("cancel-destination"));
    canceled.start(2020);
    canceled.pause();
    canceled.cancel("fixture canceled");
    await new Promise((resolve) => setTimeout(resolve, 400));
    if (canceled.state.status !== "idle" || Number(saved.length) !== 4)
      throw new Error("cancel while paused saved media");

    refuseClose = true;
    const cannotClose = new Queue(options("close-failure-destination"));
    const cannotCloseDone = finish(cannotClose);
    cannotClose.start(2020);
    const closeFailureState = await cannotCloseDone;
    if (
      closeFailureState.status !== "stopped" ||
      !closeFailureState.reason.includes("did not close cleanly")
    )
      throw new Error(
        `failed close did not stop cleanly: ${closeFailureState.status}, ${closeFailureState.reason}`,
      );
    if (cannotClose.state.status === "running")
      throw new Error("queue remained running after failed viewer close");
    result.textContent = "PASS";
  } catch (error) {
    result.textContent = `FAIL ${error instanceof Error ? error.message : String(error)}`;
  }
}
