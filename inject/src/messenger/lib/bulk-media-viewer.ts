const DIALOG = '[role="dialog"]';
const HIDDEN = '[hidden], [aria-hidden="true"], [inert]';

function visible(element: Element): boolean {
  if (element.closest(HIDDEN)) return false;
  const rect = element.getBoundingClientRect();
  const style = getComputedStyle(element);
  return rect.width > 0 && rect.height > 0 && style.visibility === "visible";
}

function owns(root: HTMLElement, element: Element): boolean {
  if (!root.contains(element)) return false;
  const nearestDialog = element.closest(DIALOG);
  // A dialog nested inside the media viewer belongs to its own UI. An enclosing
  // Messenger dialog may contain a roleless fullscreen viewer and is harmless.
  return !nearestDialog || nearestDialog === root || !root.contains(nearestDialog);
}

function normalizedLabel(element: Element): string {
  return [
    element.getAttribute("aria-label") || "",
    element.getAttribute("title") || "",
    element.textContent || "",
  ]
    .join(" ")
    .toLocaleLowerCase()
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .trim();
}

function hasControl(root: HTMLElement, pattern: RegExp): boolean {
  return [...root.querySelectorAll<HTMLElement>('button, [role="button"], a[href]')].some(
    (control) => owns(root, control) && visible(control) && pattern.test(normalizedLabel(control)),
  );
}

function hasThumbnailStrip(root: HTMLElement): boolean {
  return [
    ...root.querySelectorAll<HTMLElement>(
      '[role="tablist"], [aria-label*="thumbnail" i], [aria-label*="filmstrip" i]',
    ),
  ].some((strip) => {
    if (!owns(root, strip) || !visible(strip)) return false;
    const items = strip.querySelectorAll('button, [role="tab"], [role="button"]');
    return items.length >= 2;
  });
}

function hasMainMedia(root: HTMLElement): boolean {
  const bounds = root.getBoundingClientRect();
  const widthDenominator = Math.min(bounds.width, innerWidth);
  const heightDenominator = Math.min(bounds.height, innerHeight);
  if (widthDenominator <= 0 || heightDenominator <= 0) return false;
  return [...root.querySelectorAll<HTMLImageElement | HTMLVideoElement>("img, video")].some(
    (media) => {
      if (!owns(root, media) || !visible(media)) return false;
      const rect = media.getBoundingClientRect();
      const visibleWidth = Math.max(
        0,
        Math.min(rect.right, bounds.right, innerWidth) - Math.max(rect.left, bounds.left, 0),
      );
      const visibleHeight = Math.max(
        0,
        Math.min(rect.bottom, bounds.bottom, innerHeight) - Math.max(rect.top, bounds.top, 0),
      );
      const widthRatio = visibleWidth / widthDenominator;
      const heightRatio = visibleHeight / heightDenominator;
      return (widthRatio >= 0.15 && heightRatio >= 0.15) || widthRatio >= 0.5 || heightRatio >= 0.5;
    },
  );
}

function hasOwnOriginalDownload(root: HTMLElement): boolean {
  return [...root.querySelectorAll<HTMLAnchorElement>("a[download][href]")].some((anchor) => {
    if (
      !owns(root, anchor) ||
      !visible(anchor) ||
      anchor.hasAttribute("data-carrier-native-download")
    )
      return false;
    try {
      return new URL(anchor.href, location.href).protocol === "https:";
    } catch {
      return false;
    }
  });
}

function fillsViewport(root: HTMLElement): boolean {
  const rect = root.getBoundingClientRect();
  const visibleWidth = Math.max(0, Math.min(rect.right, innerWidth) - Math.max(rect.left, 0));
  const visibleHeight = Math.max(0, Math.min(rect.bottom, innerHeight) - Math.max(rect.top, 0));
  return (
    innerWidth > 0 &&
    innerHeight > 0 &&
    visibleWidth >= innerWidth * 0.75 &&
    visibleHeight >= innerHeight * 0.7
  );
}

function isSafeViewerRoot(root: HTMLElement): boolean {
  if (!visible(root) || !fillsViewport(root)) return false;
  if (root.closest("[data-carrier-shortcuts-overlay]") || !hasMainMedia(root)) return false;
  if (!hasOwnOriginalDownload(root)) return false;
  if (
    [...root.querySelectorAll('[role="navigation"], [contenteditable="true"]')].some((el) =>
      owns(root, el),
    )
  )
    return false;
  if (!hasControl(root, /(?:^|\W)close(?:$|\W)/u)) return false;
  const hasNavigation =
    hasControl(root, /(?:^|\W)(?:previous|prev|precedent|precedente)(?:$|\W)/u) ||
    hasControl(root, /(?:^|\W)(?:next|suivant|suivante)(?:$|\W)/u);
  return hasNavigation || hasThumbnailStrip(root);
}

/** Find a roleless fullscreen media viewer from its visible native download action. */
export function findRolelessMediaViewer(): HTMLElement | null {
  const anchors = [...document.querySelectorAll<HTMLAnchorElement>("a[download][href]")];
  for (const anchor of anchors) {
    if (!visible(anchor) || anchor.hasAttribute("data-carrier-native-download")) continue;
    for (let candidate = anchor.parentElement; candidate; candidate = candidate.parentElement) {
      if (!(candidate instanceof HTMLElement)) continue;
      if (candidate.matches(DIALOG)) break;
      if (!fillsViewport(candidate)) continue;
      if (isSafeViewerRoot(candidate)) return candidate;
    }
  }
  return null;
}

export function isBulkMediaViewer(root: HTMLElement): boolean {
  return isSafeViewerRoot(root);
}

/** True only if an element belongs to this viewer rather than a nested dialog. */
export function isBulkMediaViewerOwner(root: HTMLElement, element: Element): boolean {
  return owns(root, element);
}
