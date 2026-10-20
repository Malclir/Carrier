import { describe, expect, test } from "bun:test";
import {
  parseGalleryMonthHeading,
  parseGalleryTileDate,
  parseGalleryTileTimestamp,
} from "./bulk-media-gallery";

describe("shared media gallery dates", () => {
  test("reads English month groups and exact photo/video date labels", () => {
    expect(parseGalleryMonthHeading("June 2020")).toEqual({ year: 2020, month: 6 });
    expect(parseGalleryTileDate("View photo sent on June 26, 2020, 3:39 PM")).toEqual({
      year: 2020,
      month: 6,
      day: 26,
    });
    expect(parseGalleryTileDate("View photo sent on June 26, 2020, 3:39 PM")).toEqual({
      year: 2020,
      month: 6,
      day: 26,
    });
    expect(parseGalleryTileDate("View video sent on June 2, 2020, 11:05 AM")).toEqual({
      year: 2020,
      month: 6,
      day: 2,
    });
  });

  test("reads French month groups and French dated controls", () => {
    expect(parseGalleryMonthHeading("juin 2020")).toEqual({ year: 2020, month: 6 });
    expect(parseGalleryMonthHeading("février 2021")).toEqual({ year: 2021, month: 2 });
    expect(parseGalleryTileDate("Voir la photo envoyée le 26 juin 2020, 15:39")).toEqual({
      year: 2020,
      month: 6,
      day: 26,
    });
    expect(
      parseGalleryTileTimestamp("Voir la photo envoyée le 26 juin 2020, 15:39")?.sharedAt,
    ).toMatch(/^2020-06-26T15:39:00[+-]\d{2}:\d{2}$/u);
  });

  test("captures exact local clock time with the displayed date's numeric offset", () => {
    const timestamp = parseGalleryTileTimestamp("View photo sent on June 26, 2020, 3:39 PM");
    const local = new Date(2020, 5, 26, 15, 39);
    const offset = -local.getTimezoneOffset();
    const sign = offset < 0 ? "-" : "+";
    const hh = String(Math.floor(Math.abs(offset) / 60)).padStart(2, "0");
    const mm = String(Math.abs(offset) % 60).padStart(2, "0");
    expect(timestamp?.sharedAt).toBe(`2020-06-26T15:39:00${sign}${hh}:${mm}`);
  });

  test("converts noon and midnight correctly and rejects invalid clock values", () => {
    expect(
      parseGalleryTileTimestamp("View photo sent on June 26, 2020, 12:00 AM")?.sharedAt,
    ).toMatch(/T00:00:00[+-]\d{2}:\d{2}$/u);
    expect(
      parseGalleryTileTimestamp("View photo sent on June 26, 2020, 12:00 PM")?.sharedAt,
    ).toMatch(/T12:00:00[+-]\d{2}:\d{2}$/u);
    expect(parseGalleryTileTimestamp("View photo sent on June 26, 2020, 13:00 PM")).toBeNull();
    expect(parseGalleryTileTimestamp("Voir la photo envoyée le 26 juin 2020, 24:00")).toBeNull();
    expect(parseGalleryTileTimestamp("View photo sent on June 26, 2020, 3:60 PM")).toBeNull();
  });

  test("keeps date-only labels but does not invent a timestamp", () => {
    expect(parseGalleryTileDate("View photo sent on June 26, 2020")).toEqual({
      year: 2020,
      month: 6,
      day: 26,
    });
    expect(parseGalleryTileTimestamp("View photo sent on June 26, 2020")).not.toHaveProperty(
      "sharedAt",
    );
  });

  test("rejects missing, ambiguous, and malformed dates", () => {
    expect(parseGalleryMonthHeading("June")).toBeNull();
    expect(parseGalleryTileDate("Photo from June 26, 2020")).toBeNull();
    expect(parseGalleryTileDate("View photo sent on Smarch 26, 2020, 3:39 PM")).toBeNull();
  });

  test("keeps adjacent years distinct", () => {
    expect(parseGalleryTileDate("View photo sent on December 31, 2019, 11:59 PM")?.year).toBe(2019);
    expect(parseGalleryTileDate("View photo sent on January 1, 2020, 12:01 AM")?.year).toBe(2020);
  });
});
