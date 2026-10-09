import { type BulkMediaItem, type BulkMediaSnapshot, findBulkMediaSource } from "./bulk-media";
import { findRolelessMediaViewer } from "./bulk-media-viewer";
import { isMediaViewerDialog } from "./media-viewer";

export interface MediaGallery {
  root: HTMLElement;
  scroller: HTMLElement;
}

export interface GalleryMedia {
  key: string;
  year: number;
  month: number;
  day: number;
  control: HTMLElement;
}

const MONTHS = new Map<string, number>([
  ...[
    "january",
    "february",
    "march",
    "april",
    "may",
    "june",
    "july",
    "august",
    "september",
    "october",
    "november",
    "december",
  ].map((name, index) => [name, index + 1] as const),
  ...[
    "janvier",
    "fevrier",
    "mars",
    "avril",
    "mai",
    "juin",
    "juillet",
    "aout",
    "septembre",
    "octobre",
    "novembre",
    "decembre",
  ].map((name, index) => [name, index + 1] as const),
]);
const DATE_LABEL =
  /^(?:view (?:photo|video) sent on ([a-z]+) (\d{1,2}), (\d{4}), \d{1,2}:\d{2} ?(?:am|pm)|voir la (?:photo|video) envoyee? le (\d{1,2}) ([a-z]+) (\d{4})(?:(?:[, ]+| a )\d{1,2}:\d{2})?)$/u;
const MONTH_HEADING = /^([\p{L}]+)\s+(\d{4})$/u;
const HIDDEN = '[hidden], [aria-hidden="true"], [inert]';
const VIEWER_DIALOG = '[role="dialog"]';
const MAX_SCAN_STEPS = 400;
const WAIT_MS = 120;
const VIEWER_TIMEOUT_MS = 10_000;
const completedByScope = new Map<string, Set<string>>();

function normalized(value: string): string {
  return value
    .toLocaleLowerCase()
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .replace(/\s+/gu, " ")
    .trim();
}

export function parseGalleryMonthHeading(value: string): { year: number; month: number } | null {
  const match = normalized(value).match(MONTH_HEADING);
  if (!match) return null;
  const month = MONTHS.get(match[1]!);
  const year = Number(match[2]);
  return month && year >= 1900 && year <= 2200 ? { year, month } : null;
}

export function parseGalleryTileDate(
  value: string,
): { year: number; month: number; day: number } | null {
  const match = normalized(value).match(DATE_LABEL);
  if (!match) return null;
  const monthName = match[1] || match[5];
  const day = Number(match[2] || match[4]);
  const year = Number(match[3] || match[6]);
  const month = MONTHS.get(monthName!);
  if (!month || year < 1900 || year > 2200 || day < 1 || day > 31) return null;
  const actual = new Date(Date.UTC(year, month - 1, day));
  if (
    actual.getUTCFullYear() !== year ||
    actual.getUTCMonth() !== month - 1 ||
    actual.getUTCDate() !== day
  )
    return null;
  return { year, month, day };
}

function isGalleryControl(element: HTMLElement): boolean {
  if (element.closest(HIDDEN) || element.closest("[data-carrier-bulk-media]")) return false;
  if (element.getAttribute("role") !== "button" || element.getAttribute("tabindex") !== "0")
    return false;
  const label = element.getAttribute("aria-label") || "";
  return /^(?:view (?:photo|video) sent on|voir la (?:photo|video) envoy)/u.test(normalized(label));
}

interface Group {
  element: HTMLElement;
  heading: { year: number; month: number };
}

function hasSingleHeading(group: HTMLElement, span: HTMLElement): boolean {
  const headings = [...group.querySelectorAll<HTMLElement>("h3 span")].filter((element) =>
    parseGalleryMonthHeading(element.textContent || ""),
  );
  return headings.length === 1 && headings[0] === span;
}

function groupForHeading(span: HTMLElement): HTMLElement | null {
  let group = span.parentElement?.parentElement || null;
  for (let depth = 0; group && depth < 4; depth += 1, group = group.parentElement) {
    if (!hasSingleHeading(group, span)) continue;
    if (
      [...group.querySelectorAll<HTMLElement>('[role="button"][tabindex="0"][aria-label]')].some(
        isGalleryControl,
      )
    )
      return group;
  }
  return null;
}

function groupsWithin(root: HTMLElement): Group[] {
  const result: Group[] = [];
  for (const span of root.querySelectorAll<HTMLElement>("h3 span")) {
    const heading = parseGalleryMonthHeading(span.textContent || "");
    if (!heading) continue;
    const group = groupForHeading(span);
    if (group && root.contains(group)) result.push({ element: group, heading });
  }
  return result.filter(
    (group, index) => result.findIndex((other) => other.element === group.element) === index,
  );
}

function scrollableAncestor(group: HTMLElement): HTMLElement | null {
  for (let element: HTMLElement | null = group; element; element = element.parentElement) {
    const style = getComputedStyle(element);
    const bounds = element.getBoundingClientRect();
    if (
      /^(?:auto|scroll)$/u.test(style.overflowY) &&
      !element.closest(HIDDEN) &&
      style.visibility === "visible" &&
      bounds.width > 0 &&
      bounds.height > 0
    )
      return element;
  }
  return null;
}

export function findMediaGallery(): MediaGallery | null {
  const headings = [...document.querySelectorAll<HTMLElement>("h3 span")];
  const candidateScrollers = new Set<HTMLElement>();
  for (const span of headings) {
    if (!parseGalleryMonthHeading(span.textContent || "")) continue;
    const group = groupForHeading(span);
    if (!group) continue;
    const scroller = scrollableAncestor(group);
    if (scroller) candidateScrollers.add(scroller);
  }
  const ranked = [...candidateScrollers].filter((scroller) => groupsWithin(scroller).length > 0);
  ranked.sort((a, b) => groupsWithin(b).length - groupsWithin(a).length);
  const scroller = ranked[0];
  return scroller ? { root: scroller, scroller } : null;
}

interface ScanResult {
  items: GalleryMedia[];
  groups: Group[];
  problem: string;
}

function scan(gallery: MediaGallery): ScanResult {
  const groups = groupsWithin(gallery.root);
  const items: GalleryMedia[] = [];
  let problem = "";
  let previousOrder = Number.POSITIVE_INFINITY;
  for (const group of groups) {
    const order = group.heading.year * 12 + group.heading.month;
    if (order > previousOrder) {
      problem =
        "Stopped because the shared media gallery is not in a clear newest-to-oldest order.";
      break;
    }
    previousOrder = order;
    const controls = [
      ...group.element.querySelectorAll<HTMLElement>('[role="button"][tabindex="0"][aria-label]'),
    ].filter(isGalleryControl);
    for (const control of controls) {
      const date = parseGalleryTileDate(control.getAttribute("aria-label") || "");
      const alt = control.querySelector("img")?.getAttribute("alt") || "";
      if (!date || date.year !== group.heading.year || date.month !== group.heading.month) {
        problem = "Stopped because a gallery tile has a missing or ambiguous date.";
        continue;
      }
      if (!/^(?:image-\d+|video-\d+\.mp4)$/u.test(alt)) {
        problem = `Stopped because a dated gallery tile has no recognized photo or video thumbnail (${alt || "missing alt"}).`;
        continue;
      }
      items.push({
        key: `${date.year}-${date.month}-${date.day}:${normalized(control.getAttribute("aria-label") || "")}:${alt}`,
        year: date.year,
        month: date.month,
        day: date.day,
        control,
      });
    }
  }
  return { items, groups, problem };
}

export function collectGalleryMedia(gallery: MediaGallery): GalleryMedia[] {
  return scan(gallery).items;
}

export function availableGalleryYears(gallery: MediaGallery): number[] {
  return [...new Set(scan(gallery).items.map((item) => item.year))].sort((a, b) => b - a);
}

export interface GalleryYearQueueOptions {
  gallery: MediaGallery;
  chatKey: string;
  destinationKey: string;
  stillInChat: () => boolean;
  save: (item: BulkMediaItem) => Promise<void>;
}

export class GalleryYearQueue {
  private snapshot: BulkMediaSnapshot = {
    status: "idle",
    direction: "older",
    counts: { saved: 0, skipped: 0, failed: 0 },
    reason: "",
  };
  private listeners = new Set<(snapshot: BulkMediaSnapshot) => void>();
  private generation = 0;
  private running = false;
  private pauseWaiter: (() => void) | null = null;
  private pauseStartedAt = 0;
  private pausedDuration = 0;
  private gallery: MediaGallery;
  private ownedViewer: HTMLElement | null = null;
  private ownedSourceKey = "";

  constructor(private readonly options: GalleryYearQueueOptions) {
    this.gallery = options.gallery;
  }

  get state(): BulkMediaSnapshot {
    return { ...this.snapshot, counts: { ...this.snapshot.counts } };
  }

  subscribe(listener: (snapshot: BulkMediaSnapshot) => void): () => void {
    this.listeners.add(listener);
    listener(this.state);
    return () => this.listeners.delete(listener);
  }

  start(year: number): void {
    if (this.snapshot.status === "paused") {
      this.resume();
      return;
    }
    if (this.running) return;
    if (!Number.isInteger(year) || year < 1900 || year > 2200) {
      this.setStatus("stopped", "Stopped because the selected year is invalid.", this.generation);
      return;
    }
    const generation = ++this.generation;
    this.running = true;
    this.snapshot = {
      status: "running",
      direction: "older",
      counts: { saved: 0, skipped: 0, failed: 0 },
      reason: `Scanning gallery for ${year} media.`,
    };
    this.emit();
    void this.run(year, generation);
  }

  pause(): void {
    if (this.snapshot.status !== "running") return;
    this.pauseStartedAt = Date.now();
    this.snapshot = {
      ...this.snapshot,
      status: "paused",
      reason: "Paused. The active media item will finish before scanning resumes.",
    };
    this.emit();
  }

  resume(): void {
    if (this.snapshot.status !== "paused") return;
    this.pausedDuration += Date.now() - this.pauseStartedAt;
    this.snapshot = { ...this.snapshot, status: "running", reason: "Resuming gallery scan." };
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

  cancel(reason: string): void {
    this.generation += 1;
    this.snapshot = { ...this.snapshot, status: this.running ? "stopping" : "stopped", reason };
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

  private async wait(generation: number): Promise<boolean> {
    if (generation !== this.generation) return false;
    if (this.snapshot.status !== "paused") return true;
    await new Promise<void>((resolve) => {
      this.pauseWaiter = resolve;
    });
    return generation === this.generation;
  }

  private activeTime(): number {
    return (
      Date.now() -
      this.pausedDuration -
      (this.snapshot.status === "paused" ? Date.now() - this.pauseStartedAt : 0)
    );
  }

  private currentGallery(): MediaGallery | null {
    const found = findMediaGallery();
    if (found) this.gallery = found;
    return this.gallery.root.isConnected && this.gallery.scroller.isConnected ? this.gallery : null;
  }

  private currentViewer(): HTMLElement | null {
    const dialog = [...document.querySelectorAll<HTMLElement>(VIEWER_DIALOG)].find(
      isMediaViewerDialog,
    );
    return dialog || findRolelessMediaViewer();
  }

  private async waitForViewer(generation: number): Promise<HTMLElement> {
    const deadline = this.activeTime() + VIEWER_TIMEOUT_MS;
    while (this.activeTime() < deadline) {
      if (!(await this.wait(generation))) throw new Error("Gallery scan was canceled.");
      if (!this.options.stillInChat())
        throw new Error("Stopped because the chat changed during gallery navigation.");
      const viewer = this.currentViewer();
      if (viewer) {
        this.ownedViewer = viewer;
        return viewer;
      }
      await new Promise((resolve) => window.setTimeout(resolve, WAIT_MS));
    }
    throw new Error(
      "Stopped because the selected gallery item did not open a media viewer within 10 seconds.",
    );
  }

  private async waitForSource(viewer: HTMLElement, generation: number): Promise<BulkMediaItem> {
    const deadline = this.activeTime() + VIEWER_TIMEOUT_MS;
    let stableKey = "";
    let stable = 0;
    while (this.activeTime() < deadline) {
      if (!(await this.wait(generation))) throw new Error("Gallery scan was canceled.");
      if (this.ownedViewer !== viewer || !viewer.isConnected || !this.options.stillInChat())
        throw new Error("Stopped because the chat or media viewer changed.");
      const item = findBulkMediaSource(viewer);
      if (item?.key && item.key === stableKey) stable += 1;
      else {
        stableKey = item?.key || "";
        stable = item ? 1 : 0;
      }
      if (item && stable >= 2) return item;
      await new Promise((resolve) => window.setTimeout(resolve, WAIT_MS));
    }
    throw new Error(
      "Stopped because Messenger did not expose a stable full-size media source within 10 seconds.",
    );
  }

  private async closeOwnedViewer(): Promise<boolean> {
    const candidate = this.currentViewer();
    const candidateSource = candidate ? findBulkMediaSource(candidate)?.key || "" : "";
    const expectedSourceKey = this.ownedSourceKey;
    let viewer = candidateSource === expectedSourceKey ? candidate : this.ownedViewer;
    this.ownedViewer = null;
    if (!viewer?.isConnected || (candidate && candidateSource !== expectedSourceKey)) {
      this.ownedSourceKey = "";
      return !candidate;
    }
    const clickClose = (root: HTMLElement) => {
      const close = [
        ...root.querySelectorAll<HTMLElement>('button, [role="button"], a[href]'),
      ].find((control) => {
        if (control.closest(HIDDEN)) return false;
        const label = normalized(
          `${control.getAttribute("aria-label") || ""} ${control.getAttribute("title") || ""}`,
        );
        return /(?:^|\W)(?:close|fermer)(?:$|\W)/u.test(label);
      });
      close?.click();
      return !!close;
    };
    clickClose(viewer);
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
      const current = this.currentViewer();
      if (!current) {
        this.ownedSourceKey = "";
        return true;
      }
      const currentSourceKey = findBulkMediaSource(current)?.key || "";
      if (currentSourceKey !== expectedSourceKey) {
        this.ownedSourceKey = "";
        return false;
      }
      if (current !== viewer) {
        viewer = current;
        clickClose(viewer);
      }
      await new Promise((resolve) => window.setTimeout(resolve, WAIT_MS));
    }
    const closed = this.currentViewer() === null;
    this.ownedSourceKey = "";
    return closed;
  }

  private async openAndSave(media: GalleryMedia, generation: number): Promise<void> {
    if (!this.options.stillInChat())
      throw new Error("Stopped because the chat changed before opening gallery media.");
    if (this.currentViewer())
      throw new Error("Stopped because another media viewer is already open.");
    const fresh = this.currentGallery();
    const control = fresh && scan(fresh).items.find((item) => item.key === media.key)?.control;
    if (!control?.isConnected)
      throw new Error("Stopped because a gallery item changed while the gallery was loading.");
    control.click();
    const viewer = await this.waitForViewer(generation);
    const item = await this.waitForSource(viewer, generation);
    this.ownedSourceKey = item.key;
    if (!(await this.wait(generation))) return;
    const current = this.currentViewer();
    if (!this.options.stillInChat() || !current)
      throw new Error("Stopped because the chat or media viewer changed before saving.");
    if (findBulkMediaSource(current)?.key !== item.key)
      throw new Error("Stopped because the media viewer changed before saving.");
    if (current !== viewer) this.ownedViewer = current;
    await this.options.save(item);
    const scope = `${this.options.chatKey}\u0000${this.options.destinationKey}`;
    let completed = completedByScope.get(scope);
    if (!completed) {
      completed = new Set();
      completedByScope.set(scope, completed);
    }
    completed.add(media.key);
    if (generation !== this.generation) return;
    this.snapshot.counts.saved += 1;
    this.emit();
  }

  private async run(year: number, generation: number): Promise<void> {
    const scope = `${this.options.chatKey}\u0000${this.options.destinationKey}`;
    let completed = completedByScope.get(scope);
    if (!completed) {
      completed = new Set();
      completedByScope.set(scope, completed);
    }
    const visited = new Set<string>();
    let foundYear = false;
    let steps = 0;
    try {
      if (!this.options.stillInChat())
        throw new Error("Stopped because the chat changed before gallery scanning started.");
      if (this.currentViewer())
        throw new Error(
          "Stopped because a media viewer is already open; return to shared media and retry.",
        );
      const initial = this.currentGallery();
      if (!initial)
        throw new Error(
          "Stopped because Messenger's dated shared media gallery could not be found.",
        );
      initial.scroller.scrollTop = 0;
      await new Promise((resolve) => window.setTimeout(resolve, WAIT_MS * 2));
      while (generation === this.generation && steps++ < MAX_SCAN_STEPS) {
        if (!(await this.wait(generation))) return;
        if (!this.options.stillInChat())
          throw new Error("Stopped because the chat changed during gallery scanning.");
        const gallery = this.currentGallery();
        if (!gallery)
          throw new Error("Stopped because the shared media gallery disappeared during scanning.");
        const result = scan(gallery);
        if (result.problem) throw new Error(result.problem);
        if (!result.groups.length)
          throw new Error("Stopped because the gallery no longer exposes dated media groups.");
        const ordered = result.groups.map((group) => group.heading.year * 12 + group.heading.month);
        const oldestVisible = Math.min(...ordered);
        for (const media of result.items) {
          if (media.year === year) foundYear = true;
          if (media.year < year) {
            if (foundYear) {
              this.setStatus(
                "complete",
                `Finished ${year}: the gallery reached the next older year.`,
                generation,
              );
              return;
            }
            this.setStatus(
              "complete",
              `No ${year} media was found in the available gallery.`,
              generation,
            );
            return;
          }
          if (media.year !== year || visited.has(media.key)) continue;
          visited.add(media.key);
          if (completed.has(media.key)) {
            this.snapshot.counts.skipped += 1;
            this.emit();
            continue;
          }
          if (!(await this.wait(generation))) return;
          try {
            await this.openAndSave(media, generation);
          } catch (error) {
            const closed = await this.closeOwnedViewer();
            if (generation !== this.generation) return;
            if (!closed)
              throw new Error("Stopped because the opened media viewer did not close cleanly.");
            if (!this.options.stillInChat()) throw error;
            const reason = error instanceof Error ? error.message : "Gallery media failed to save.";
            if (reason.startsWith("Stopped because")) throw error;
            this.snapshot.counts.failed += 1;
            this.snapshot.reason = `A gallery item failed and remains retryable. ${reason}`;
            this.emit();
          }
          if (!(await this.closeOwnedViewer()))
            throw new Error("Stopped because the opened media viewer did not close cleanly.");
          if (generation !== this.generation) return;
          await new Promise((resolve) => window.setTimeout(resolve, WAIT_MS));
        }
        if (oldestVisible < year * 12 + 1 && foundYear) {
          this.setStatus(
            "complete",
            `Finished ${year}: the gallery reached the next older year.`,
            generation,
          );
          return;
        }
        const scroller = gallery.scroller;
        const oldHeight = scroller.scrollHeight;
        const oldTop = scroller.scrollTop;
        scroller.scrollTop = Math.min(
          oldTop + Math.max(240, Math.floor(scroller.clientHeight * 0.8)),
          scroller.scrollHeight,
        );
        const moved = scroller.scrollTop !== oldTop;
        if (!moved && scroller.scrollHeight === oldHeight) {
          const before = result.items.map((item) => item.key).join("|");
          const activeDeadline = this.activeTime() + VIEWER_TIMEOUT_MS;
          let loaded = false;
          while (this.activeTime() < activeDeadline) {
            if (!(await this.wait(generation))) return;
            await new Promise((resolve) => window.setTimeout(resolve, WAIT_MS));
            if (generation !== this.generation) return;
            const delayed = this.currentGallery();
            if (!delayed)
              throw new Error(
                "Stopped because the shared media gallery disappeared during lazy loading.",
              );
            const after = scan(delayed);
            if (after.problem) throw new Error(after.problem);
            if (
              delayed.scroller.scrollHeight > oldHeight ||
              after.items.map((item) => item.key).join("|") !== before
            ) {
              loaded = true;
              break;
            }
          }
          if (!loaded) {
            this.setStatus(
              "stopped",
              foundYear
                ? `Finished the ${year} media currently available in the gallery, but no older-year boundary could be verified.`
                : `No ${year} media was found before the available gallery ended; whole-year coverage could not be verified.`,
              generation,
            );
            return;
          }
        } else {
          await new Promise((resolve) => window.setTimeout(resolve, WAIT_MS * 3));
        }
      }
      if (steps >= MAX_SCAN_STEPS)
        throw new Error(
          "Stopped because gallery scanning reached its safety limit before finding a clear year boundary.",
        );
    } catch (error) {
      let closeFailed = false;
      try {
        closeFailed = !(await this.closeOwnedViewer());
      } catch {
        closeFailed = true;
      }
      if (generation !== this.generation) return;
      const reason = error instanceof Error ? error.message : "Gallery scan failed.";
      this.setStatus(
        "stopped",
        closeFailed && !reason.includes("did not close cleanly")
          ? `${reason} Stopped because the opened media viewer did not close cleanly.`
          : reason,
        generation,
      );
    } finally {
      try {
        await this.closeOwnedViewer();
      } catch {
        // Cleanup cannot be allowed to leave the queue's running flag set.
      }
      this.running = false;
      if (this.snapshot.status === "stopping") {
        this.snapshot = { ...this.snapshot, status: "idle" };
        this.emit();
      }
    }
  }
}
