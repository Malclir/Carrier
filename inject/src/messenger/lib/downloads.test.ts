import { describe, expect, test } from "bun:test";
import { downloadChatNameSlug } from "./download-chat-name";
import {
  datedDownloadName,
  downloadRevealLabel,
  filenameFromUrl,
  friendlyDownloadName,
  isDownloadCancellation,
  splitDownloadName,
} from "./downloads";

const BASE = "https://www.facebook.com/messages/";

describe("filenameFromUrl", () => {
  test("takes the URL path basename when it looks like a filename", () => {
    expect(filenameFromUrl("https://scontent.fbcdn.net/v/photo_1.jpg?x=1", BASE)).toBe(
      "photo_1.jpg",
    );
    expect(filenameFromUrl("/files/report%20final.pdf", BASE)).toBe("report final.pdf");
  });

  test("returns '' when there is no extension or the URL is junk", () => {
    expect(filenameFromUrl("https://example.com/download", BASE)).toBe("");
    expect(filenameFromUrl("https://example.com/", BASE)).toBe("");
    expect(filenameFromUrl("::not a url::", "also not a base")).toBe("");
  });
});

describe("splitDownloadName", () => {
  test("splits stem and extension", () => {
    expect(splitDownloadName("video.mp4")).toEqual({ stem: "video", ext: ".mp4" });
    expect(splitDownloadName("archive.tar.gz")).toEqual({ stem: "archive.tar", ext: ".gz" });
  });

  test("handles missing extensions and path prefixes", () => {
    expect(splitDownloadName("README")).toEqual({ stem: "README", ext: "" });
    expect(splitDownloadName(".hidden")).toEqual({ stem: ".hidden", ext: "" });
    expect(splitDownloadName("dir/photo.jpg")).toEqual({ stem: "photo", ext: ".jpg" });
    expect(splitDownloadName("C:\\dir\\photo.jpg")).toEqual({ stem: "photo", ext: ".jpg" });
    expect(splitDownloadName(null)).toEqual({ stem: "", ext: "" });
  });
});

describe("friendlyDownloadName", () => {
  test("replaces Facebook's generic stems, keeping the extension", () => {
    expect(friendlyDownloadName("download.jpg")).toBe("Messenger.jpg");
    expect(friendlyDownloadName("image.png")).toBe("Messenger.png");
    expect(friendlyDownloadName("Video.mp4")).toBe("Messenger.mp4");
    expect(friendlyDownloadName("")).toBe("Messenger");
  });

  test("keeps real filenames untouched", () => {
    expect(friendlyDownloadName("holiday_2025.jpg")).toBe("holiday_2025.jpg");
    expect(friendlyDownloadName("report final.pdf")).toBe("report final.pdf");
  });
});

describe("datedDownloadName", () => {
  test("uses the gallery calendar date and keeps image or video extensions", () => {
    expect(datedDownloadName("Messenger.jpg", "2020-06-26")).toBe("2020-06-26.jpg");
    expect(datedDownloadName("clip.mp4", "2020-06-02")).toBe("2020-06-02.mp4");
    expect(datedDownloadName("photo.tar.jpg", "2020-06-26")).toBe("2020-06-26.jpg");
  });

  test("prefixes valid dated names with a safe chat slug", () => {
    expect(datedDownloadName("photo.jpg", "2020-06-26", undefined, "First Last")).toBe(
      "first_last_2020-06-26.jpg",
    );
    expect(datedDownloadName("photo.jpg", "2020-06-26", undefined, "👩‍👩‍👧‍👦")).toBe(
      "2020-06-26.jpg",
    );
    expect(datedDownloadName("photo.jpg", undefined, undefined, "First Last")).toBe("photo.jpg");
  });

  test("falls back to a valid sharedAt date prefix and leaves ordinary names unchanged", () => {
    expect(datedDownloadName("image.png", undefined, "2020-02-29T23:59:00-08:00")).toBe(
      "2020-02-29.png",
    );
    expect(datedDownloadName("family.jpg")).toBe("family.jpg");
    expect(datedDownloadName("family.jpg", "invalid-date")).toBe("family.jpg");
  });

  test("rejects invalid dates and uses a valid timestamp fallback", () => {
    expect(datedDownloadName("image.jpg", "2021-02-29")).toBe("image.jpg");
    expect(datedDownloadName("image.jpg", "2021-02-29", "2020-12-31T23:59:00+02:00")).toBe(
      "2020-12-31.jpg",
    );
    expect(datedDownloadName("image.jpg", "2020-1-02")).toBe("image.jpg");
    expect(datedDownloadName("image.jpg", undefined, "garbage-at-the-end")).toBe("image.jpg");
    expect(datedDownloadName("image.jpg", undefined, "2020-12-31garbage")).toBe("image.jpg");
  });
});

describe("downloadChatNameSlug", () => {
  test("normalizes accents and separates Unicode words", () => {
    expect(downloadChatNameSlug("Élodie Núñez")).toBe("elodie_nunez");
    expect(downloadChatNameSlug("李 雷")).toBe("李_雷");
  });

  test("removes unsafe punctuation, path separators, and emoji", () => {
    expect(downloadChatNameSlug("A/B:C*D? 😀 E")).toBe("a_b_c_d_e");
    expect(downloadChatNameSlug("👩‍🚀")).toBe("");
  });

  test("caps the slug at 40 Unicode characters and trims underscores", () => {
    expect(downloadChatNameSlug(`__${"漢".repeat(45)}__`)).toBe("漢".repeat(40));
    expect(Array.from(downloadChatNameSlug(`${"𐐀".repeat(45)}x`))).toHaveLength(40);
  });
});

describe("downloadRevealLabel", () => {
  test("uses Finder only for the macOS user agent", () => {
    expect(downloadRevealLabel("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)")).toBe(
      "Show in Finder",
    );
    expect(downloadRevealLabel("Mozilla/5.0 (Windows NT 10.0; Win64; x64)")).toBe("Show in folder");
    expect(downloadRevealLabel("Mozilla/5.0 (X11; Linux x86_64)")).toBe("Show in folder");
  });
});

describe("isDownloadCancellation", () => {
  test("recognizes only an explicit native-picker cancellation", () => {
    expect(isDownloadCancellation(new Error("download cancelled"))).toBe(true);
    expect(isDownloadCancellation(new Error("download rejected"))).toBe(false);
    expect(isDownloadCancellation(new Error("native download failed"))).toBe(false);
    expect(isDownloadCancellation("download cancelled")).toBe(false);
  });
});
