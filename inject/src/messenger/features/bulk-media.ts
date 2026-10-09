import {
  BulkMediaQueue,
  type BulkMediaSnapshot,
  findBulkMediaSource,
  findMediaNavigation,
  type MediaDirection,
} from "../lib/bulk-media";
import { findRolelessMediaViewer, isBulkMediaViewer } from "../lib/bulk-media-viewer";
import { isMediaViewerDialog } from "../lib/media-viewer";
import { downloadSrc } from "./context-menu";

const HOST_ATTR = "data-carrier-bulk-media";
const VIEWER = '[role="dialog"]';
const NAVIGATION_TIMEOUT_MS = 10_000;

export function initBulkMedia() {
  let activeDialog: HTMLElement | null = null;
  let host: HTMLDivElement | null = null;
  let root: ShadowRoot | null = null;
  let queue: BulkMediaQueue | null = null;
  let stopListening: (() => void) | null = null;
  let activeChatKey = "";

  const chatKey = () =>
    location.pathname.match(/\/messages(?:\/e2ee)?\/t\/[^/]+/u)?.[0] || location.pathname;
  const isViewer = (element: HTMLElement) =>
    (element.matches(VIEWER) && isMediaViewerDialog(element)) || isBulkMediaViewer(element);
  const findViewer = () => {
    const dialog = [...document.querySelectorAll<HTMLElement>(VIEWER)].find(isMediaViewerDialog);
    return dialog || findRolelessMediaViewer();
  };
  const refresh = () => {
    const next = activeDialog?.isConnected && isViewer(activeDialog) ? activeDialog : findViewer();
    const nextChatKey = chatKey();
    if (next === activeDialog && activeChatKey === nextChatKey && host) return;
    queue?.cancel("Stopped because the chat or media viewer changed.");
    activeDialog = next;
    stopListening?.();
    stopListening = null;
    queue = null;
    if (!next) {
      host?.remove();
      host = null;
      root = null;
      activeChatKey = nextChatKey;
      return;
    }
    if (!host) {
      host = document.createElement("div");
      host.setAttribute(HOST_ATTR, "");
      root = host.attachShadow({ mode: "open" });
    }
    host.setAttribute("data-open", "");
    if (!host.isConnected) document.body.appendChild(host);
    activeChatKey = nextChatKey;
    const queuedDialog = next;
    const queuedChatKey = nextChatKey;
    const stillInQueue = () =>
      !!queuedDialog.isConnected &&
      activeDialog === queuedDialog &&
      isViewer(queuedDialog) &&
      chatKey() === queuedChatKey;
    queue = new BulkMediaQueue(
      {
        current: () => (isViewer(queuedDialog) ? findBulkMediaSource(queuedDialog) : null),
        save: async (item) => {
          await downloadSrc(item.src, item.fallbackName);
        },
        advance: async (direction, previousKey) => {
          if (!stillInQueue()) return false;
          const button = findMediaNavigation(queuedDialog, direction);
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
    );
    stopListening = queue.subscribe(render);
    render(queue.state);
  };

  function render(state: BulkMediaSnapshot) {
    if (!root) return;
    root.innerHTML = `<style>
      :host{all:initial;position:fixed;z-index:2147483646;left:18px;top:18px;color-scheme:light dark;font:14px/1.4 system-ui,-apple-system,sans-serif}
      *{box-sizing:border-box}button{font:inherit;color:inherit;cursor:pointer}
      .wrap{position:relative}.open{border:0;border-radius:999px;padding:10px 16px;background:#1877f2;color:white;box-shadow:0 2px 12px #0005;font-weight:650}
      .panel{display:none;position:absolute;left:0;top:48px;width:300px;padding:14px;border-radius:12px;background:#fff;color:#1c1e21;box-shadow:0 6px 28px #0005}
      :host([data-open]) .panel{display:block}h2{font-size:16px;margin:0 0 8px}.directions,.actions{display:flex;gap:8px;margin:10px 0}
      .directions button,.actions button{border:1px solid #ccd0d5;border-radius:8px;padding:7px 10px;background:#f5f6f7}
      button[aria-pressed=true]{border-color:#1877f2;background:#e7f3ff;color:#0866ff}.actions .primary{background:#1877f2;color:white;border-color:#1877f2}
      .counts{margin:8px 0;color:#444}.reason{margin:8px 0 0;color:#555;overflow-wrap:anywhere}.hint{color:#555;font-size:13px;margin:8px 0 0}
      @media(prefers-color-scheme:dark){.panel{background:#242526;color:#e4e6eb}.directions button,.actions button{background:#3a3b3c;border-color:#555;color:#e4e6eb}.counts,.reason,.hint{color:#c9cdd2}}
    </style><div class="wrap"><button type="button" class="open" aria-expanded="true">Batch download</button><section class="panel" aria-label="Batch download"><h2>Download chat media</h2>
      <div class="directions"><button type="button" data-direction="older" aria-pressed="${state.direction === "older"}">← Previous</button><button type="button" data-direction="newer" aria-pressed="${state.direction === "newer"}">Next →</button></div>
      <div class="actions"><button type="button" class="primary" data-action="start">Start</button><button type="button" data-action="pause">Pause</button><button type="button" data-action="resume">Resume</button><button type="button" data-action="reset">Reset</button></div>
      <p class="counts">Saved ${state.counts.saved} · Skipped ${state.counts.skipped} · Failed ${state.counts.failed}</p>
      <p class="reason">${escapeHtml(state.reason)}</p>
      ${window.__CARRIER_SETTINGS__?.download_behavior === "ask" ? '<p class="hint">Bulk downloads need automatic saving. In Carrier Settings, choose “Downloads folder” and reopen this viewer.</p>' : '<p class="hint">Starts from the item open now and follows the selected direction. Photos and videos only.</p>'}
    </section></div>`;
    const open = root.querySelector<HTMLButtonElement>(".open")!;
    open.setAttribute("aria-expanded", String(host?.hasAttribute("data-open") || false));
    if (host) {
      host.dataset.status = state.status;
      host.dataset.saved = String(state.counts.saved);
      host.dataset.skipped = String(state.counts.skipped);
      host.dataset.failed = String(state.counts.failed);
    }
    open.addEventListener("click", () => {
      if (!host) return;
      host.toggleAttribute("data-open");
      open.setAttribute("aria-expanded", String(host.hasAttribute("data-open")));
    });
    root.querySelectorAll<HTMLButtonElement>("[data-direction]").forEach((button) => {
      button.addEventListener("click", () => {
        if (!queue) return;
        queue.selectDirection(button.dataset.direction as MediaDirection);
      });
    });
    root
      .querySelector<HTMLButtonElement>('[data-action="start"]')!
      .addEventListener("click", () => {
        if (window.__CARRIER_SETTINGS__?.download_behavior === "ask") return;
        queue?.start(state.direction);
      });
    root
      .querySelector<HTMLButtonElement>('[data-action="pause"]')!
      .addEventListener("click", () => queue?.pause());
    root
      .querySelector<HTMLButtonElement>('[data-action="resume"]')!
      .addEventListener("click", () => queue?.resume());
    root
      .querySelector<HTMLButtonElement>('[data-action="reset"]')!
      .addEventListener("click", () => queue?.reset());
    root.querySelectorAll<HTMLButtonElement>('[data-action="start"]').forEach((button) => {
      if (window.__CARRIER_SETTINGS__?.download_behavior === "ask" || state.status === "stopping")
        button.disabled = true;
    });
    root.querySelectorAll<HTMLButtonElement>("[data-direction]").forEach((button) => {
      button.disabled =
        state.status === "running" || state.status === "paused" || state.status === "stopping";
    });
    root.querySelector<HTMLButtonElement>('[data-action="pause"]')!.disabled =
      state.status !== "running";
    root.querySelector<HTMLButtonElement>('[data-action="resume"]')!.disabled =
      state.status !== "paused";
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
        (activeDialog?.contains(record.target) || record.target.matches("a[download]"))
      )
        return true;
      return (
        record.type === "childList" &&
        [...record.addedNodes, ...record.removedNodes].some(
          (node) =>
            node instanceof Element &&
            (node.matches(VIEWER) ||
              node.matches("a[download]") ||
              !!node.querySelector(`${VIEWER}, a[download]`) ||
              (!!activeDialog && node.contains(activeDialog))),
        )
      );
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
    if (activeDialog?.contains(event.target)) {
      schedule();
      return;
    }
    if (
      !activeDialog &&
      event.target.matches("img, video") &&
      document.querySelector("a[download]")
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
