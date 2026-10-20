/* Download-name helpers for the media download path (context menu + the
 * viewer's Download button). */
import { downloadChatNameSlug } from "./download-chat-name";

/** The basename of a URL's path, when it looks like a real filename. */
export const filenameFromUrl = (u: string, base: string): string => {
  try {
    const p = new URL(u, base).pathname.split("/").pop();
    return p?.includes(".") ? decodeURIComponent(p) : "";
  } catch {
    return "";
  }
};

const GENERIC_DOWNLOAD_STEMS = new Set(["download", "image", "video"]);

export const splitDownloadName = (name: unknown): { stem: string; ext: string } => {
  const file =
    String(name || "")
      .trim()
      .split(/[\\/]/)
      .pop() || "";
  const dot = file.lastIndexOf(".");
  if (dot > 0 && dot < file.length - 1) {
    return { stem: file.slice(0, dot), ext: file.slice(dot) };
  }
  return { stem: file, ext: "" };
};

/** Swap Facebook's generic stems ("download.jpg") for a friendlier one. */
export const friendlyDownloadName = (name: string): string => {
  const { stem, ext } = splitDownloadName(name);
  if (!stem || GENERIC_DOWNLOAD_STEMS.has(stem.toLowerCase())) {
    // Keep the basename stable; Rust `unique_path` owns "(n)" de-duping.
    return `Messenger${ext}`;
  }
  return name;
};

const validCalendarDate = (value: string): boolean => {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (year < 1 || month < 1 || month > 12 || day < 1 || day > 31) return false;
  const date = new Date(0);
  date.setUTCHours(0, 0, 0, 0);
  date.setUTCFullYear(year, month - 1, day);
  return (
    date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
  );
};

/** Give a year-gallery download its displayed calendar date while keeping its resolved extension. */
export const datedDownloadName = (
  name: string,
  sharedDate?: string,
  sharedAt?: string,
  chatName?: string,
): string => {
  const timestampDate =
    sharedAt && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:Z|[+-]\d{2}:\d{2})$/u.test(sharedAt)
      ? sharedAt.slice(0, 10)
      : undefined;
  const date =
    sharedDate && validCalendarDate(sharedDate)
      ? sharedDate
      : timestampDate && validCalendarDate(timestampDate)
        ? timestampDate
        : undefined;
  if (!date) return name;
  const { ext } = splitDownloadName(name);
  const chatSlug = downloadChatNameSlug(chatName);
  return `${chatSlug ? `${chatSlug}_` : ""}${date}${ext}`;
};

export const downloadRevealLabel = (userAgent: string): string =>
  /Mac/i.test(userAgent) ? "Show in Finder" : "Show in folder";

export const isDownloadCancellation = (error: unknown): boolean =>
  error instanceof Error && error.message === "download cancelled";
