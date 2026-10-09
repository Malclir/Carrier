import { describe, expect, test } from "bun:test";
import { parseGalleryMonthHeading, parseGalleryTileDate } from "./bulk-media-gallery";

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
  });

  test("rejects missing, ambiguous, and malformed dates", () => {
    expect(parseGalleryMonthHeading("June")).toBeNull();
    expect(parseGalleryTileDate("View photo sent on June 26, 2020")).toBeNull();
    expect(parseGalleryTileDate("Photo from June 26, 2020")).toBeNull();
    expect(parseGalleryTileDate("View photo sent on Smarch 26, 2020, 3:39 PM")).toBeNull();
  });

  test("keeps adjacent years distinct", () => {
    expect(parseGalleryTileDate("View photo sent on December 31, 2019, 11:59 PM")?.year).toBe(2019);
    expect(parseGalleryTileDate("View photo sent on January 1, 2020, 12:01 AM")?.year).toBe(2020);
  });
});
