/** Turn a Messenger chat title into a safe, compact filename prefix. */
export const downloadChatNameSlug = (name: unknown): string => {
  const normalized = String(name ?? "")
    .normalize("NFKD")
    .replace(/\p{M}+/gu, "")
    .toLowerCase();
  const slug = normalized.replace(/[^\p{L}\p{N}]+/gu, "_").replace(/^_+|_+$/gu, "");
  return Array.from(slug).slice(0, 40).join("").replace(/_+$/gu, "");
};

const conversationTitle = (value: string): string | undefined => {
  const match = /^Conversation (?:with|avec)\s+(.+?)\s*$/iu.exec(value.trim());
  const title = match?.[1]?.trim();
  return title || undefined;
};

const isVisible = (element: Element): boolean => {
  for (let current: Element | null = element; current; current = current.parentElement) {
    if (
      current.hasAttribute("hidden") ||
      current.hasAttribute("inert") ||
      current.getAttribute("aria-hidden") === "true"
    ) {
      return false;
    }
    const style = getComputedStyle(current);
    if (
      style.display === "none" ||
      style.visibility === "hidden" ||
      style.visibility === "collapse"
    ) {
      return false;
    }
  }
  return true;
};

/**
 * Find the visible Messenger conversation title without reading message text
 * or headings in the conversation list. Multiple copies are safe when they
 * identify the same conversation; conflicting visible titles are ambiguous.
 */
export const findDownloadChatName = (root: ParentNode): string | undefined => {
  const names = new Set<string>();
  for (const heading of root.querySelectorAll("h3")) {
    const title = conversationTitle(heading.textContent || "");
    const container = heading.parentElement;
    if (!title || !container || container.tagName !== "DIV" || !isVisible(heading)) continue;
    if (!container.querySelector('[contenteditable="true"]')) continue;
    names.add(title);
  }
  for (const log of root.querySelectorAll('[role="log"][aria-label]')) {
    const title = conversationTitle(log.getAttribute("aria-label") || "");
    if (title && isVisible(log)) names.add(title);
  }
  return names.size === 1 ? names.values().next().value : undefined;
};
