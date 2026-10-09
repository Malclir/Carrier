import { isBulkMediaViewerOwner } from "./bulk-media-viewer";

export type MediaDirection = "older" | "newer";

export interface BulkMediaItem {
  key: string;
  src: string;
  fallbackName: string;
}

export interface BulkMediaCounts {
  saved: number;
  skipped: number;
  failed: number;
}

export interface BulkMediaSnapshot {
  status: "idle" | "running" | "paused" | "stopping" | "stopped" | "complete";
  direction: MediaDirection;
  counts: BulkMediaCounts;
  reason: string;
}

export interface BulkMediaAdapter {
  current(): BulkMediaItem | null;
  save(item: BulkMediaItem): Promise<void>;
  advance(direction: MediaDirection, previousKey: string): Promise<boolean>;
  stillInChat(): boolean;
}

export function findBulkMediaSource(dialog: HTMLElement): BulkMediaItem | null {
  const own = (element: Element) => isBulkMediaViewerOwner(dialog, element);
  const visible = (element: Element) => {
    if (!own(element) || element.closest('[hidden], [aria-hidden="true"], [inert]')) return false;
    const rect = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    return rect.width > 0 && rect.height > 0 && style.visibility === "visible";
  };
  const usable = (value: string, allowBlob = false) => {
    if (!value || value.startsWith("data:") || (!allowBlob && value.startsWith("blob:")))
      return false;
    try {
      const url = new URL(value, location.href);
      return (
        url.protocol === "https:" ||
        url.protocol === "http:" ||
        (allowBlob && url.protocol === "blob:")
      );
    } catch {
      return false;
    }
  };

  // The native full-size download action is the most reliable original source.
  const downloads = [...dialog.querySelectorAll<HTMLAnchorElement>("a[download][href]")]
    .filter((anchor) => visible(anchor) && usable(anchor.href, true))
    .sort((a, b) => Number(isThumbnailUrl(a.href)) - Number(isThumbnailUrl(b.href)));
  const download = downloads[0];
  if (download) {
    const src = download.href;
    return { key: mediaKey(src), src, fallbackName: download.download || "media" };
  }

  const video = [...dialog.querySelectorAll<HTMLVideoElement>("video")].find(visible);
  if (video) {
    const src =
      video.currentSrc ||
      video.src ||
      video.querySelector<HTMLSourceElement>("source[src]")?.src ||
      "";
    if (usable(src)) return { key: mediaKey(src), src, fallbackName: "video" };
    // Messenger can expose a video poster as a convenient image, but that is
    // not the video file and should never be saved as if it were one.
    return null;
  }

  const image = [...dialog.querySelectorAll<HTMLImageElement>("img")]
    .filter((element) => visible(element) && fillsViewer(dialog, element))
    .sort(
      (a, b) =>
        b.getBoundingClientRect().width * b.getBoundingClientRect().height -
        a.getBoundingClientRect().width * a.getBoundingClientRect().height,
    )[0];
  if (image) {
    const src = preferredImageSource(image);
    if (usable(src)) return { key: mediaKey(src), src, fallbackName: "image" };
  }
  return null;
}

function isThumbnailUrl(value: string): boolean {
  return /(?:thumb(?:nail)?|p\d+x\d+|s\d+x\d+|stp=|_s\.)/iu.test(value);
}

function preferredImageSource(image: HTMLImageElement): string {
  const candidates = image.srcset
    .split(",")
    .map((candidate) => {
      const [src = "", descriptor = ""] = candidate.trim().split(/\s+/u);
      const amount = Number.parseFloat(descriptor);
      const score = descriptor.endsWith("w")
        ? amount
        : descriptor.endsWith("x")
          ? amount * image.naturalWidth
          : 0;
      return { src, score, thumbnail: isThumbnailUrl(src) };
    })
    .filter((candidate) => candidate.src);
  candidates.sort((a, b) => Number(a.thumbnail) - Number(b.thumbnail) || b.score - a.score);
  return candidates[0]?.src || image.currentSrc || image.src || "";
}

function fillsViewer(dialog: HTMLElement, element: Element): boolean {
  const bounds = element.getBoundingClientRect();
  const viewer = dialog.getBoundingClientRect();
  const width = Math.max(
    0,
    Math.min(bounds.right, viewer.right, innerWidth) - Math.max(bounds.left, viewer.left, 0),
  );
  const height = Math.max(
    0,
    Math.min(bounds.bottom, viewer.bottom, innerHeight) - Math.max(bounds.top, viewer.top, 0),
  );
  const denominatorWidth = Math.min(viewer.width, innerWidth);
  const denominatorHeight = Math.min(viewer.height, innerHeight);
  const widthRatio = width / denominatorWidth;
  const heightRatio = height / denominatorHeight;
  return (
    denominatorWidth > 0 &&
    denominatorHeight > 0 &&
    ((widthRatio >= 0.15 && heightRatio >= 0.15) || widthRatio >= 0.5 || heightRatio >= 0.5)
  );
}

function mediaKey(src: string): string {
  try {
    const url = new URL(src, location.href);
    const facebookCdn =
      url.hostname === "fbcdn.net" ||
      url.hostname.endsWith(".fbcdn.net") ||
      url.hostname === "fbsbx.com" ||
      url.hostname.endsWith(".fbsbx.com");
    if (facebookCdn) {
      for (const parameter of [
        "oh",
        "oe",
        "ccb",
        "efg",
        "stp",
        "dl",
        "bytestart",
        "byteend",
        "__nc_sid",
        "__nc_ohc",
        "__nc_gid",
        "__nc_cat",
        "rm",
      ]) {
        url.searchParams.delete(parameter);
      }
    }
    url.hash = "";
    return url.href;
  } catch {
    return src;
  }
}

const normalizeLabel = (value: string) =>
  value
    .toLocaleLowerCase()
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .trim();

export function findMediaNavigation(
  dialog: HTMLElement,
  direction: MediaDirection,
): HTMLElement | null {
  const phrases =
    direction === "older"
      ? ["previous", "prev", "precedent", "precedente"]
      : ["next", "suivant", "suivante"];
  for (const control of dialog.querySelectorAll<HTMLElement>('button, [role="button"], a[href]')) {
    if (!isBulkMediaViewerOwner(dialog, control)) continue;
    if (control.closest("[data-carrier-bulk-media]")) continue;
    if (control.closest('[hidden], [aria-hidden="true"], [inert]')) continue;
    const rect = control.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0 || getComputedStyle(control).visibility !== "visible")
      continue;
    const label = normalizeLabel(
      [
        control.getAttribute("aria-label") || "",
        control.getAttribute("title") || "",
        control.textContent || "",
      ].join(" "),
    );
    if (phrases.some((phrase) => new RegExp(`(?:^|\\W)${phrase}(?:$|\\W)`, "u").test(label)))
      return control;
  }
  return null;
}

export class BulkMediaQueue {
  private snapshot: BulkMediaSnapshot = {
    status: "idle",
    direction: "older",
    counts: { saved: 0, skipped: 0, failed: 0 },
    reason: "",
  };
  private listeners = new Set<(snapshot: BulkMediaSnapshot) => void>();
  private pauseWaiter: (() => void) | null = null;
  private generation = 0;
  private running = false;

  constructor(
    private readonly adapter: BulkMediaAdapter,
    private readonly chatKey: string,
  ) {}

  get state(): BulkMediaSnapshot {
    return { ...this.snapshot, counts: { ...this.snapshot.counts } };
  }

  subscribe(listener: (snapshot: BulkMediaSnapshot) => void): () => void {
    this.listeners.add(listener);
    listener(this.state);
    return () => this.listeners.delete(listener);
  }

  start(direction: MediaDirection): void {
    if (this.snapshot.status === "paused") {
      this.resume();
      return;
    }
    if (this.running) return;
    const generation = ++this.generation;
    this.running = true;
    this.snapshot = {
      status: "running",
      direction,
      counts: { saved: 0, skipped: 0, failed: 0 },
      reason: "",
    };
    this.emit();
    void this.run(generation);
  }

  selectDirection(direction: MediaDirection): void {
    if (this.snapshot.status === "running" || this.snapshot.status === "paused") return;
    this.snapshot = { ...this.snapshot, direction };
    this.emit();
  }

  pause(): void {
    if (this.snapshot.status !== "running") return;
    this.snapshot = { ...this.snapshot, status: "paused" };
    this.emit();
  }

  cancel(reason: string): void {
    if (!this.running) {
      this.setStatus("stopped", reason, this.generation);
      return;
    }
    this.generation += 1;
    this.snapshot = { ...this.snapshot, status: "stopping", reason };
    this.pauseWaiter?.();
    this.pauseWaiter = null;
    this.emit();
  }

  resume(): void {
    if (this.snapshot.status !== "paused") return;
    this.snapshot = { ...this.snapshot, status: "running" };
    this.emit();
    this.pauseWaiter?.();
    this.pauseWaiter = null;
  }

  reset(): void {
    const wasRunning = this.running;
    this.generation += 1;
    this.snapshot = {
      status: wasRunning ? "stopping" : "idle",
      direction: this.snapshot.direction,
      counts: { saved: 0, skipped: 0, failed: 0 },
      reason: wasRunning
        ? "Reset requested. Waiting for the active native download to finish."
        : "",
    };
    this.pauseWaiter?.();
    this.pauseWaiter = null;
    this.emit();
  }

  private emit(): void {
    const state = this.state;
    for (const listener of this.listeners) listener(state);
  }

  private setStatus(status: BulkMediaSnapshot["status"], reason: string, generation: number): void {
    if (generation !== this.generation) return;
    this.snapshot = { ...this.snapshot, status, reason };
    this.emit();
  }

  private async waitWhilePaused(generation: number): Promise<boolean> {
    if (generation !== this.generation) return false;
    if (this.snapshot.status !== "paused") return true;
    await new Promise<void>((resolve) => {
      this.pauseWaiter = resolve;
    });
    return generation === this.generation;
  }

  private async run(generation: number): Promise<void> {
    const visited = new Set<string>();
    const completed = completedMediaByChat.get(this.chatKey) || new Set<string>();
    completedMediaByChat.set(this.chatKey, completed);
    try {
      while (generation === this.generation) {
        if (!(await this.waitWhilePaused(generation))) return;
        if (!this.adapter.stillInChat()) {
          this.setStatus(
            "stopped",
            "Stopped because the chat or media viewer changed.",
            generation,
          );
          return;
        }
        const item = this.adapter.current();
        if (!item) {
          this.setStatus(
            "stopped",
            "Stopped because this media has no supported full-size download source.",
            generation,
          );
          return;
        }
        if (visited.has(item.key)) {
          this.setStatus(
            "stopped",
            "Stopped at repeated media to avoid a navigation loop.",
            generation,
          );
          return;
        }
        visited.add(item.key);
        if (completed.has(item.key)) {
          this.snapshot.counts.skipped += 1;
          this.emit();
        } else {
          try {
            await this.adapter.save(item);
            completed.add(item.key);
            if (generation !== this.generation) return;
            this.snapshot.counts.saved += 1;
          } catch {
            if (generation !== this.generation) return;
            this.snapshot.counts.failed += 1;
          }
          this.emit();
        }
        if (!(await this.waitWhilePaused(generation))) return;
        if (!this.adapter.stillInChat()) {
          this.setStatus(
            "stopped",
            "Stopped because the chat or media viewer changed.",
            generation,
          );
          return;
        }
        const advanced = await this.adapter.advance(this.snapshot.direction, item.key);
        if (generation !== this.generation) return;
        if (!this.adapter.stillInChat()) {
          this.setStatus(
            "stopped",
            "Stopped because the chat or media viewer changed.",
            generation,
          );
          return;
        }
        if (!advanced) {
          this.setStatus(
            "complete",
            "Reached the end of available media in this direction.",
            generation,
          );
          return;
        }
      }
    } catch (error) {
      const reason = error instanceof Error ? error.message : "Media navigation failed.";
      this.setStatus("stopped", reason, generation);
    } finally {
      this.running = false;
      if (this.snapshot.status === "stopping") {
        this.snapshot = { ...this.snapshot, status: "idle" };
        this.emit();
      }
    }
  }
}

const completedMediaByChat = new Map<string, Set<string>>();
