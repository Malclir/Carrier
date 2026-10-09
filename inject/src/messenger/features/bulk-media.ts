import {
  BulkMediaQueue,
  type BulkMediaSnapshot,
  findBulkMediaSource,
  findMediaNavigation,
  type MediaDirection,
} from "../lib/bulk-media";
import {
  availableGalleryYears,
  collectGalleryMedia,
  findMediaGallery,
  GalleryYearQueue,
  type MediaGallery,
} from "../lib/bulk-media-gallery";
import { findRolelessMediaViewer, isBulkMediaViewer } from "../lib/bulk-media-viewer";
import { isMediaViewerDialog } from "../lib/media-viewer";
import { downloadSrc } from "./context-menu";

const HOST_ATTR = "data-carrier-bulk-media";
const VIEWER = '[role="dialog"]';
const NAVIGATION_TIMEOUT_MS = 10_000;
const MIN_YEAR = 2004;
const IDLE_SNAPSHOT: BulkMediaSnapshot = {
  status: "idle",
  direction: "older",
  counts: { saved: 0, skipped: 0, failed: 0 },
  reason: "",
};

type BatchMode = "year" | "direction";

export function initBulkMedia() {
  let activeDialog: HTMLElement | null = null;
  let activeGallery: MediaGallery | null = null;
  let host: HTMLDivElement | null = null;
  let root: ShadowRoot | null = null;
  let queue: BulkMediaQueue | null = null;
  let galleryQueue: GalleryYearQueue | null = null;
  let galleryQueueRoot: HTMLElement | null = null;
  let stopDirectionListening: (() => void) | null = null;
  let stopGalleryListening: (() => void) | null = null;
  let activeChatKey = "";
  let queueDialog: HTMLElement | null = null;
  let queueDestinationKey = "";
  let mode: BatchMode = "direction";
  let modeInitialized = false;
  let direction: MediaDirection = "older";
  let year = new Date().getFullYear();
  let yearEdited = false;
  let renderedGalleryYears = "";
  let folder: string | null = null;
  let folderLabel = "Downloads";
  let pickerPending = false;
  let actionError = "";

  const chatKey = () =>
    location.pathname.match(/\/messages(?:\/e2ee)?\/t\/[^/]+/u)?.[0] || location.pathname;
  const isViewer = (element: HTMLElement) =>
    (element.matches(VIEWER) && isMediaViewerDialog(element)) || isBulkMediaViewer(element);
  const findViewer = () => {
    const dialog = [...document.querySelectorAll<HTMLElement>(VIEWER)].find(isMediaViewerDialog);
    return dialog || findRolelessMediaViewer();
  };
  const folderKey = () => folder || "downloads";
  const snapshot = (): BulkMediaSnapshot => {
    if (mode === "year") return galleryQueue?.state || IDLE_SNAPSHOT;
    return queue?.state || { ...IDLE_SNAPSHOT, direction };
  };
  const isLive = (state: BulkMediaSnapshot) =>
    state.status === "running" || state.status === "paused" || state.status === "stopping";
  const protectedYearRun = () => !!galleryQueue && isLive(galleryQueue.state);
  const hasYearResult = () =>
    !!galleryQueue &&
    (galleryQueue.state.status === "stopped" || galleryQueue.state.status === "complete");

  const ensureHost = () => {
    if (!host) {
      host = document.createElement("div");
      host.setAttribute(HOST_ATTR, "");
      root = host.attachShadow({ mode: "open" });
      host.setAttribute("data-open", "");
    }
    if (!host.isConnected) document.body.appendChild(host);
  };

  const clearQueueBinding = (reason?: string) => {
    if (reason) {
      queue?.cancel(reason);
      galleryQueue?.cancel(reason);
    }
    stopDirectionListening?.();
    stopGalleryListening?.();
    stopDirectionListening = null;
    stopGalleryListening = null;
    queue = null;
    galleryQueue = null;
    galleryQueueRoot = null;
    queueDialog = null;
    queueDestinationKey = "";
  };

  const makeDirectionQueue = (dialog: HTMLElement, queuedChatKey: string) => {
    const destinationKey = folderKey();
    if (
      queue &&
      queueDialog === dialog &&
      activeChatKey === queuedChatKey &&
      queueDestinationKey === destinationKey
    )
      return;
    queue?.cancel("Stopped because the chat or media viewer changed.");
    stopDirectionListening?.();
    stopDirectionListening = null;
    const queuedDialog = dialog;
    const stillInQueue = () =>
      !!queuedDialog.isConnected &&
      activeDialog === queuedDialog &&
      isViewer(queuedDialog) &&
      chatKey() === queuedChatKey;
    queue = new BulkMediaQueue(
      {
        current: () => (isViewer(queuedDialog) ? findBulkMediaSource(queuedDialog) : null),
        save: async (item) => {
          await downloadSrc(item.src, item.fallbackName, undefined, folder ?? undefined);
        },
        advance: async (selectedDirection, previousKey) => {
          if (!stillInQueue()) return false;
          const button = findMediaNavigation(queuedDialog, selectedDirection);
          if (!button)
            throw new Error(
              "Stopped because Messenger exposes no recognized Previous/Next control in this viewer.",
            );
          if (button.matches(":disabled") || button.getAttribute("aria-disabled") === "true")
            return false;
          button.click();
          const deadline = Date.now() + NAVIGATION_TIMEOUT_MS;
          let stableKey = "";
          let stableCount = 0;
          while (Date.now() < deadline) {
            await new Promise((resolve) => window.setTimeout(resolve, 120));
            if (!stillInQueue()) return false;
            const nextItem = findBulkMediaSource(queuedDialog);
            if (nextItem?.key && nextItem.key !== previousKey) {
              if (stableKey === nextItem.key) stableCount += 1;
              else {
                stableKey = nextItem.key;
                stableCount = 1;
              }
              if (stableCount >= 2) return true;
            } else {
              stableKey = "";
              stableCount = 0;
            }
          }
          throw new Error("Stopped because the next media did not load within 10 seconds.");
        },
        stillInChat: stillInQueue,
      },
      queuedChatKey,
      destinationKey,
    );
    queueDialog = dialog;
    queueDestinationKey = destinationKey;
    stopDirectionListening = queue.subscribe(() => render());
  };

  const refresh = () => {
    const nextDialog =
      activeDialog?.isConnected && isViewer(activeDialog) ? activeDialog : findViewer();
    const nextGallery = findMediaGallery();
    const nextChatKey = chatKey();
    const previouslyAvailable = !!activeDialog || !!activeGallery;
    const previousDialog = activeDialog;
    const previousGalleryRoot = activeGallery?.root || null;

    const chatChanged = !!activeChatKey && activeChatKey !== nextChatKey;
    if (chatChanged) {
      clearQueueBinding("Stopped because the chat or media viewer changed.");
      yearEdited = false;
    }
    if (
      nextGallery &&
      (!activeGallery || activeGallery.root !== nextGallery.root || chatChanged) &&
      !yearEdited &&
      !protectedYearRun()
    )
      year = chooseDefaultYear(nextGallery, availableGalleryYears(nextGallery));
    activeChatKey = nextChatKey;
    activeDialog = nextDialog;
    activeGallery = nextGallery;
    if (!modeInitialized || chatChanged || (!previouslyAvailable && (nextDialog || nextGallery))) {
      mode = nextDialog ? "direction" : nextGallery ? "year" : "direction";
      modeInitialized = true;
    }

    if (!nextDialog && !nextGallery && !protectedYearRun() && !hasYearResult()) {
      host?.remove();
      host = null;
      root = null;
      return;
    }

    ensureHost();
    if (protectedYearRun()) {
      // GalleryYearQueue opens and closes Messenger's viewer while it scans.
      // Keep its queue and subscription attached through those DOM transitions.
      render();
      return;
    }

    if (galleryQueue) {
      if (nextGallery && nextGallery.root !== galleryQueueRoot) {
        stopGalleryListening?.();
        stopGalleryListening = null;
        galleryQueue = null;
        galleryQueueRoot = null;
      }
    }

    if (!nextGallery && nextDialog && mode === "year" && !hasYearResult()) mode = "direction";
    if (!nextDialog && nextGallery && mode === "direction") mode = "year";
    if (!nextDialog && !nextGallery && !galleryQueue) {
      host?.remove();
      host = null;
      root = null;
      return;
    }

    const yearsSignature = nextGallery ? availableGalleryYears(nextGallery).join(",") : "";
    const contextChanged =
      chatChanged ||
      previousDialog !== nextDialog ||
      previousGalleryRoot !== (nextGallery?.root || null);
    if (!contextChanged && yearsSignature === renderedGalleryYears) return;
    renderedGalleryYears = yearsSignature;

    if (nextDialog && mode === "direction") makeDirectionQueue(nextDialog, nextChatKey);
    else if (queue) {
      queue.cancel("Stopped because the chat or media viewer changed.");
      stopDirectionListening?.();
      stopDirectionListening = null;
      queue = null;
      queueDialog = null;
      queueDestinationKey = "";
    }
    render();
  };

  function render() {
    if (!root) return;
    const state = snapshot();
    const active = isLive(state) || pickerPending;
    const years = activeGallery ? availableGalleryYears(activeGallery) : [];
    const maxYear = new Date().getFullYear() + 1;
    const askWithoutFolder = window.__CARRIER_SETTINGS__?.download_behavior === "ask" && !folder;
    const nativeMissing = !!folder && typeof carrierPrepareBatchDownload !== "function";
    const yearBlockedByViewer = mode === "year" && !!activeDialog;
    const hint =
      actionError ||
      (mode === "year"
        ? !activeGallery
          ? "Open the shared media gallery to choose a year."
          : yearBlockedByViewer
            ? "Close the full-size photo or video before starting a whole-year batch."
            : askWithoutFolder
              ? "Choose a batch folder or set Carrier Settings to “Downloads folder” and reopen the viewer."
              : nativeMissing
                ? "Batch folders require a newer Carrier version. Update and reopen the app."
                : "Saves dated photo and video originals from the selected year. Messenger may not expose the full history."
        : askWithoutFolder
          ? "Choose a batch folder or set Carrier Settings to “Downloads folder” and reopen the viewer."
          : "Starts from the open photo and follows Previous or Next.");

    const focusedElement = root.activeElement instanceof HTMLElement ? root.activeElement : null;
    const focusControl = focusedElement?.dataset.control
      ? `[data-control="${focusedElement.dataset.control}"]`
      : focusedElement?.dataset.action
        ? `[data-action="${focusedElement.dataset.action}"]`
        : focusedElement?.dataset.direction
          ? `[data-direction="${focusedElement.dataset.direction}"]`
          : focusedElement?.classList.contains("open")
            ? ".open"
            : "";
    const focusedValue =
      focusedElement instanceof HTMLInputElement || focusedElement instanceof HTMLSelectElement
        ? focusedElement.value
        : null;

    root.innerHTML = `<style>
      :host{all:initial;position:fixed;z-index:2147483646;left:18px;top:18px;color-scheme:light dark;font:14px/1.4 system-ui,-apple-system,sans-serif}
      *{box-sizing:border-box}[hidden]{display:none!important}button,select,input{font:inherit;color:inherit}
      button{cursor:pointer}.wrap{position:relative}.open{border:0;border-radius:999px;padding:10px 16px;background:#1877f2;color:white;box-shadow:0 2px 12px #0005;font-weight:650}
      .panel{display:none;position:absolute;left:0;top:48px;width:320px;padding:14px;border-radius:12px;background:#fff;color:#1c1e21;box-shadow:0 6px 28px #0005}
      :host([data-open]) .panel{display:block}h2{font-size:16px;margin:0 0 10px}.field{display:grid;gap:5px;margin:9px 0}.field label{font-weight:600}.field select,.field input{width:100%;border:1px solid #ccd0d5;border-radius:7px;padding:7px 9px;background:#fff;color:#1c1e21}
      .folder{display:flex;align-items:center;justify-content:space-between;gap:8px;margin:11px 0}.folder-name{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.folder button,.directions button,.actions button{border:1px solid #ccd0d5;border-radius:8px;padding:7px 10px;background:#f5f6f7;color:inherit;white-space:nowrap}
      .directions,.actions{display:flex;gap:7px;margin:10px 0}.actions button{flex:1}.primary{background:#1877f2!important;color:white!important;border-color:#1877f2!important}
      button[aria-pressed=true]{border-color:#1877f2;background:#e7f3ff;color:#0866ff}.counts{margin:8px 0;color:#444}.reason{margin:8px 0 0;color:#555;overflow-wrap:anywhere}.hint{color:#555;font-size:13px;margin:8px 0 0;overflow-wrap:anywhere}
      button:disabled,select:disabled,input:disabled{opacity:.5;cursor:default}
      @media(prefers-color-scheme:dark){.panel{background:#242526;color:#e4e6eb}.field select,.field input{background:#3a3b3c;border-color:#555;color:#e4e6eb}.folder button,.directions button,.actions button{background:#3a3b3c;border-color:#555;color:#e4e6eb}.counts,.reason,.hint{color:#c9cdd2}}
    </style><div class="wrap"><button type="button" class="open" aria-expanded="true">Batch download</button><section class="panel" aria-label="Batch download"><h2>Download chat media</h2>
      <div class="field"><label for="batch-mode">Download scope</label><select id="batch-mode" data-control="mode"><option value="year" ${mode === "year" ? "selected" : ""}>Whole year</option><option value="direction" ${mode === "direction" ? "selected" : ""}>From open photo</option></select></div>
      <div class="field year-field" ${mode === "year" ? "" : "hidden"}><label for="batch-year">Year</label><input id="batch-year" data-control="year" type="number" min="${MIN_YEAR}" max="${maxYear}" step="1" value="${year}" list="batch-years"><datalist id="batch-years">${years.map((item) => `<option value="${item}"></option>`).join("")}</datalist></div>
      <div class="folder"><span>Save to <strong class="folder-name">${escapeHtml(folderLabel)}</strong></span><button type="button" data-action="choose-folder">${folder ? "Change folder" : "Choose folder"}</button></div>
      <div class="directions" ${mode === "direction" ? "" : "hidden"}><button type="button" data-direction="older" aria-pressed="${direction === "older"}">← Previous</button><button type="button" data-direction="newer" aria-pressed="${direction === "newer"}">Next →</button></div>
      <div class="actions"><button type="button" class="primary" data-action="start">Start</button><button type="button" data-action="pause">Pause</button><button type="button" data-action="resume">Resume</button><button type="button" data-action="reset">Reset</button></div>
      <p class="counts">Saved ${state.counts.saved} · Skipped ${state.counts.skipped} · Failed ${state.counts.failed}</p>
      <p class="reason">${escapeHtml(state.reason)}</p><p class="hint">${escapeHtml(hint)}</p>
    </section></div>`;

    if (host) {
      host.dataset.status = state.status;
      host.dataset.saved = String(state.counts.saved);
      host.dataset.skipped = String(state.counts.skipped);
      host.dataset.failed = String(state.counts.failed);
    }
    if (focusControl) {
      const replacement = root.querySelector<HTMLElement>(focusControl);
      if (replacement && !("disabled" in replacement && replacement.disabled)) {
        if (
          focusedValue !== null &&
          (replacement instanceof HTMLInputElement || replacement instanceof HTMLSelectElement)
        )
          replacement.value = focusedValue;
        replacement.focus();
      }
    }
    const open = root.querySelector<HTMLButtonElement>(".open")!;
    open.setAttribute("aria-expanded", String(host?.hasAttribute("data-open") || false));
    open.addEventListener("click", () => {
      if (!host) return;
      host.toggleAttribute("data-open");
      open.setAttribute("aria-expanded", String(host.hasAttribute("data-open")));
    });

    const setBusyDisabled = (element: HTMLButtonElement | HTMLSelectElement | HTMLInputElement) => {
      element.disabled = active;
    };
    const modeSelect = root.querySelector<HTMLSelectElement>('[data-control="mode"]')!;
    setBusyDisabled(modeSelect);
    modeSelect.querySelector<HTMLOptionElement>('option[value="year"]')!.disabled = !activeGallery;
    modeSelect.querySelector<HTMLOptionElement>('option[value="direction"]')!.disabled =
      !activeDialog;
    root.querySelector<HTMLInputElement>('[data-control="year"]')!.disabled =
      active || !activeGallery;
    root.querySelectorAll<HTMLButtonElement>("[data-direction]").forEach((button) => {
      button.setAttribute("aria-pressed", String(button.dataset.direction === direction));
      button.disabled = active || !activeDialog;
      button.addEventListener("click", () => {
        direction = button.dataset.direction as MediaDirection;
        if (queue) queue.selectDirection(direction);
        render();
      });
    });
    root.querySelector<HTMLButtonElement>('[data-action="choose-folder"]')!.disabled = active;
    root
      .querySelector<HTMLButtonElement>('[data-action="choose-folder"]')!
      .addEventListener("click", () => {
        void chooseFolder();
      });
    root
      .querySelector<HTMLSelectElement>('[data-control="mode"]')!
      .addEventListener("change", (event) => {
        const nextMode = (event.currentTarget as HTMLSelectElement).value as BatchMode;
        if (mode === "year" && nextMode !== "year") {
          stopGalleryListening?.();
          stopGalleryListening = null;
          galleryQueue = null;
          galleryQueueRoot = null;
        }
        mode = nextMode;
        actionError = "";
        if (mode === "direction" && activeDialog) makeDirectionQueue(activeDialog, activeChatKey);
        render();
      });
    root
      .querySelector<HTMLInputElement>('[data-control="year"]')!
      .addEventListener("change", (event) => {
        const value = Number((event.currentTarget as HTMLInputElement).value);
        if (Number.isInteger(value) && value >= MIN_YEAR && value <= maxYear) {
          year = value;
          yearEdited = true;
        }
        render();
      });

    const startButton = root.querySelector<HTMLButtonElement>('[data-action="start"]')!;
    startButton.disabled = active || askWithoutFolder || (mode === "direction" && !activeDialog);
    startButton.addEventListener("click", () => void startBatch());
    const pauseButton = root.querySelector<HTMLButtonElement>('[data-action="pause"]')!;
    pauseButton.disabled = state.status !== "running";
    pauseButton.addEventListener("click", () => (mode === "year" ? galleryQueue : queue)?.pause());
    const resumeButton = root.querySelector<HTMLButtonElement>('[data-action="resume"]')!;
    resumeButton.disabled = state.status !== "paused";
    resumeButton.addEventListener("click", () =>
      (mode === "year" ? galleryQueue : queue)?.resume(),
    );
    const resetButton = root.querySelector<HTMLButtonElement>('[data-action="reset"]')!;
    resetButton.disabled = active && state.status === "stopping";
    resetButton.addEventListener("click", () => (mode === "year" ? galleryQueue : queue)?.reset());
  }

  async function chooseFolder() {
    if (pickerPending) return;
    actionError = "";
    if (typeof carrierChooseBatchFolder !== "function") {
      actionError = "Folder selection requires a newer Carrier version. Update and reopen the app.";
      render();
      return;
    }
    pickerPending = true;
    const pickerChatKey = activeChatKey;
    render();
    try {
      const selected = await carrierChooseBatchFolder();
      if (pickerChatKey !== chatKey()) return;
      folder = selected.folder;
      folderLabel = selected.label?.replace(/^.*[\\/]/u, "") || "Selected folder";
      actionError = "";
      clearQueueBinding();
    } catch {
      actionError = "Folder selection was canceled or unavailable.";
    } finally {
      pickerPending = false;
      render();
    }
  }

  async function startBatch() {
    actionError = "";
    const destinationKey = folderKey();
    if (mode === "year") {
      if (!activeGallery) {
        actionError = "Open the shared media gallery before starting a year batch.";
      } else if (findViewer()) {
        actionError = "Close the full-size photo or video before starting a whole-year batch.";
      } else if (folder && typeof carrierPrepareBatchDownload !== "function") {
        actionError = "Year batches require a newer Carrier version. Update and reopen the app.";
      } else if (window.__CARRIER_SETTINGS__?.download_behavior === "ask" && !folder) {
        actionError =
          "Choose a batch folder to save without changing the per-download ask setting.";
      } else {
        const gallery = activeGallery;
        const queuedChatKey = activeChatKey;
        const selectedFolder = folder;
        galleryQueue?.cancel("A new year batch was started.");
        stopGalleryListening?.();
        stopGalleryListening = null;
        galleryQueue = new GalleryYearQueue({
          gallery,
          chatKey: queuedChatKey,
          destinationKey,
          stillInChat: () => chatKey() === queuedChatKey,
          save: async (item) => {
            await downloadSrc(item.src, item.fallbackName, undefined, selectedFolder || undefined);
          },
        });
        galleryQueueRoot = gallery.root;
        stopGalleryListening = galleryQueue.subscribe(() => render());
        galleryQueue.start(year);
      }
    } else if (!activeDialog) {
      actionError = "Open a full-size photo or video to use Previous or Next.";
    } else if (window.__CARRIER_SETTINGS__?.download_behavior === "ask" && !folder) {
      actionError = "Choose a batch folder to save without changing the per-download ask setting.";
    } else {
      makeDirectionQueue(activeDialog, activeChatKey);
      queue?.start(direction);
    }
    render();
  }

  function chooseDefaultYear(gallery: MediaGallery, years: number[]): number {
    const visibleCounts = new Map<number, number>();
    const scroller = gallery.scroller.getBoundingClientRect();
    const visibleBounds = {
      left: Math.max(0, scroller.left),
      top: Math.max(0, scroller.top),
      right: Math.min(innerWidth, scroller.right),
      bottom: Math.min(innerHeight, scroller.bottom),
    };
    for (const item of collectGalleryMedia(gallery)) {
      const rect = item.control.getBoundingClientRect();
      if (
        item.year >= MIN_YEAR &&
        rect.width > 0 &&
        rect.height > 0 &&
        rect.bottom > visibleBounds.top &&
        rect.top < visibleBounds.bottom &&
        rect.right > visibleBounds.left &&
        rect.left < visibleBounds.right
      )
        visibleCounts.set(item.year, (visibleCounts.get(item.year) || 0) + 1);
    }
    const visible = [...visibleCounts.entries()].sort(
      (a, b) => b[1] - a[1] || years.indexOf(a[0]) - years.indexOf(b[0]),
    )[0]?.[0];
    return visible ?? years.find((item) => item >= MIN_YEAR) ?? new Date().getFullYear();
  }

  function escapeHtml(value: string) {
    return value.replace(
      /[&<>"']/g,
      (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]!,
    );
  }

  let frame = 0;
  const schedule = () => {
    if (!frame)
      frame = requestAnimationFrame(() => {
        frame = 0;
        refresh();
      });
  };
  const observer = new MutationObserver((records) => {
    const relevant = records.some((record) => {
      if (
        record.target instanceof Element &&
        (activeDialog?.contains(record.target) ||
          activeGallery?.root.contains(record.target) ||
          record.target.matches("a[download]"))
      )
        return true;
      if (record.type !== "childList") return false;
      const changed = [...record.addedNodes, ...record.removedNodes].some(
        (node) =>
          node instanceof Element &&
          (node.matches(VIEWER) ||
            node.matches("a[download]") ||
            !!node.querySelector(`${VIEWER}, a[download]`) ||
            (!!activeDialog && node.contains(activeDialog)) ||
            (!!activeGallery && node.contains(activeGallery.root))),
      );
      return changed || (!activeGallery && !!findMediaGallery());
    });
    if (relevant) schedule();
  });
  observer.observe(document.documentElement, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: [
      "hidden",
      "aria-hidden",
      "inert",
      "role",
      "aria-modal",
      "class",
      "style",
      "download",
      "controls",
    ],
  });
  const mediaLoaded = (event: Event) => {
    if (!(event.target instanceof Element)) return;
    if (activeDialog?.contains(event.target) || activeGallery?.root.contains(event.target)) {
      schedule();
      return;
    }
    if (
      !activeDialog &&
      event.target.matches("img, video") &&
      (document.querySelector("a[download]") || findMediaGallery())
    )
      schedule();
  };
  document.addEventListener("load", mediaLoaded, true);
  document.addEventListener("loadedmetadata", mediaLoaded, true);
  document.addEventListener("error", mediaLoaded, true);
  window.addEventListener("resize", schedule, { passive: true });
  window.addEventListener("popstate", schedule);
  schedule();
}
