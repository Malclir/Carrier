//! Apply Messenger's shared timestamp to downloaded photos without touching
//! their encoded pixels. Unsupported media keeps its original bytes.

use std::{
    fs::{self, OpenOptions},
    io::{Read, Write},
    path::{Path, PathBuf},
    sync::atomic::{AtomicU64, Ordering},
    time::{Duration, UNIX_EPOCH},
};

use chrono::{DateTime, Datelike};
use little_exif::{exif_tag::ExifTag, filetype::FileExtension, metadata::Metadata};

const MAX_IMAGE_BYTES: u64 = 64 * 1024 * 1024;
static TEMP_COUNTER: AtomicU64 = AtomicU64::new(0);

struct SharedDate {
    exif_datetime: String,
    offset: String,
    system_time: std::time::SystemTime,
}

fn parse_shared_date(value: &str) -> Result<SharedDate, String> {
    let parsed = DateTime::parse_from_rfc3339(value)
        .map_err(|_| "shared timestamp must be a valid RFC3339 date with an offset".to_owned())?;
    if parsed.timestamp_subsec_nanos() >= 1_000_000_000 {
        return Err("leap-second timestamps are not supported".to_owned());
    }
    if !(2004..=2100).contains(&parsed.year()) {
        return Err("shared timestamp year is outside the supported range".to_owned());
    }
    let offset = parsed.offset().to_string();
    let exif_datetime = parsed.format("%Y:%m:%d %H:%M:%S").to_string();
    let system_time = UNIX_EPOCH
        .checked_add(Duration::from_secs(parsed.timestamp() as u64))
        .ok_or_else(|| "shared timestamp is outside the supported range".to_owned())?;
    Ok(SharedDate {
        exif_datetime,
        offset,
        system_time,
    })
}

pub(crate) fn is_valid_shared_date(value: &str) -> bool {
    parse_shared_date(value).is_ok()
}

/// Updates EXIF and filesystem dates for supported photos. For non-JPEG/PNG
/// files, only filesystem dates are set. Inputs are bounded and symlinks are
/// rejected because downloaded content is untrusted.
pub(crate) fn apply_shared_date(path: &Path, shared_at: &str) -> Result<(), String> {
    let date = parse_shared_date(shared_at)?;
    let file_type = sniff_image_type(path)?;
    let Some(file_type) = file_type else {
        set_file_times(path, date.system_time)?;
        return Ok(());
    };
    let original = read_bounded_image(path)?;
    if image_type(&original) != Some(file_type) {
        return Err("downloaded photo changed while its metadata was being read".to_owned());
    }
    if !validate_container(&original, file_type) {
        return Err("downloaded photo is malformed; its contents were left unchanged".to_owned());
    }
    let has_existing_exif = contains_exif_block(&original, file_type);
    let mut metadata = match parse_metadata(&original, file_type) {
        Ok(metadata) => metadata,
        Err(error) if !has_existing_exif && is_no_metadata_error(&error) => Metadata::new(),
        Err(error) => return Err(error),
    };
    if metadata.get_ifds().is_empty() && has_existing_exif {
        return Err("photo contains unreadable EXIF metadata; leaving it unchanged".to_owned());
    }
    metadata.set_tag(ExifTag::DateTimeOriginal(date.exif_datetime.clone()));
    metadata.set_tag(ExifTag::CreateDate(date.exif_datetime.clone()));
    metadata.set_tag(ExifTag::ModifyDate(date.exif_datetime.clone()));
    metadata.set_tag(ExifTag::OffsetTimeOriginal(date.offset.clone()));
    metadata.set_tag(ExifTag::OffsetTimeDigitized(date.offset.clone()));
    metadata.set_tag(ExifTag::OffsetTime(date.offset));
    for tag in [0x9290, 0x9291, 0x9292] {
        metadata.remove_tag_by_hex_group(tag, little_exif::ifd::ExifTagGroup::EXIF);
    }

    let mut updated = original.clone();
    std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        metadata.write_to_vec(&mut updated, file_type)
    }))
    .map_err(|_| "metadata writer rejected the photo; leaving it unchanged".to_owned())?
    .map_err(|error| format!("could not encode photo metadata: {error}"))?;
    if updated.len() as u64 > MAX_IMAGE_BYTES {
        return Err("updated photo exceeds the supported size limit".to_owned());
    }

    let verified = parse_metadata(&updated, file_type)?;
    if !has_expected_date(&verified, &date.exif_datetime) {
        return Err("could not verify updated photo metadata; leaving it unchanged".to_owned());
    }

    atomic_replace(path, &updated, date.system_time)?;
    Ok(())
}

fn sniff_image_type(path: &Path) -> Result<Option<FileExtension>, String> {
    let mut options = OpenOptions::new();
    options.read(true);
    configure_no_follow(&mut options);
    let mut file = options
        .open(path)
        .map_err(|error| format!("could not open downloaded media: {error}"))?;
    if !file
        .metadata()
        .map_err(|error| error.to_string())?
        .is_file()
    {
        return Err("downloaded media is not a regular file".to_owned());
    }
    let mut prefix = [0; 8];
    let count = file
        .read(&mut prefix)
        .map_err(|error| format!("could not inspect downloaded media: {error}"))?;
    Ok(image_type(&prefix[..count]))
}

fn configure_no_follow(options: &mut OpenOptions) {
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NOFOLLOW);
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        const FILE_FLAG_OPEN_REPARSE_POINT: u32 = 0x0020_0000;
        options.custom_flags(FILE_FLAG_OPEN_REPARSE_POINT);
    }
}

fn read_bounded_image(path: &Path) -> Result<Vec<u8>, String> {
    let mut options = OpenOptions::new();
    options.read(true);
    configure_no_follow(&mut options);
    let file = options
        .open(path)
        .map_err(|error| format!("could not open downloaded photo: {error}"))?;
    let metadata = file
        .metadata()
        .map_err(|error| format!("could not inspect downloaded photo: {error}"))?;
    if metadata.len() > MAX_IMAGE_BYTES {
        return Err("downloaded photo exceeds the supported size limit".to_owned());
    }
    let mut bytes = Vec::with_capacity(metadata.len() as usize);
    file.take(MAX_IMAGE_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|error| format!("could not read downloaded photo: {error}"))?;
    if bytes.len() as u64 > MAX_IMAGE_BYTES {
        return Err("downloaded photo exceeds the supported size limit".to_owned());
    }
    Ok(bytes)
}

/*
 * Parse only enough of the container structure to ensure metadata readers do
 * not receive truncated JPEG segments, PNG chunks, or out-of-bounds TIFF
 * offsets. The actual image payload remains opaque and is never decoded.
 */
fn validate_container(bytes: &[u8], file_type: FileExtension) -> bool {
    match file_type {
        FileExtension::JPEG => validate_jpeg(bytes),
        FileExtension::PNG { .. } => validate_png(bytes),
        _ => false,
    }
}

fn validate_jpeg(bytes: &[u8]) -> bool {
    if bytes.len() < 4 || bytes[0..2] != [0xff, 0xd8] {
        return false;
    }
    let mut at = 2usize;
    while at + 1 < bytes.len() {
        if bytes[at] != 0xff {
            return false;
        }
        while at < bytes.len() && bytes[at] == 0xff {
            at += 1;
        }
        if at >= bytes.len() {
            return false;
        }
        let marker = bytes[at];
        at += 1;
        if marker == 0xd9 {
            return at == bytes.len();
        }
        if marker == 0xda {
            return at + 2 <= bytes.len() && bytes.ends_with(&[0xff, 0xd9]);
        }
        if marker == 0x01 || (0xd0..=0xd7).contains(&marker) {
            continue;
        }
        if at + 2 > bytes.len() {
            return false;
        }
        let len = u16::from_be_bytes([bytes[at], bytes[at + 1]]) as usize;
        if len < 2 || at + len > bytes.len() {
            return false;
        }
        if marker == 0xe1
            && bytes.get(at + 2..at + 8) == Some(b"Exif\0\0")
            && !validate_tiff(&bytes[at + 8..at + len])
        {
            return false;
        }
        at += len;
    }
    false
}

fn validate_png(bytes: &[u8]) -> bool {
    const SIG: &[u8; 8] = b"\x89PNG\r\n\x1a\n";
    if !bytes.starts_with(SIG) {
        return false;
    }
    let mut at = 8usize;
    let mut saw_end = false;
    while at + 12 <= bytes.len() {
        let len = u32::from_be_bytes(bytes[at..at + 4].try_into().unwrap()) as usize;
        let end = match at.checked_add(12).and_then(|v| v.checked_add(len)) {
            Some(v) if v <= bytes.len() => v,
            _ => return false,
        };
        let name = &bytes[at + 4..at + 8];
        if name == b"eXIf" && !validate_tiff(&bytes[at + 8..at + 8 + len]) {
            return false;
        }
        // little_exif's legacy zTXt decoder has indexing assertions for broken
        // profiles. Keep these images byte-for-byte intact and report failure.
        if name == b"zTXt" && bytes[at + 8..at + 8 + len].starts_with(b"Raw profile type exif\0") {
            return false;
        }
        if name == b"IEND" {
            saw_end = len == 0 && end == bytes.len();
            break;
        }
        at = end;
    }
    saw_end
}

fn validate_tiff(bytes: &[u8]) -> bool {
    if bytes.len() < 8 {
        return false;
    }
    let little = match &bytes[..2] {
        b"II" => true,
        b"MM" => false,
        _ => return false,
    };
    let u16_at = |at: usize| -> Option<u16> {
        let b: [u8; 2] = bytes.get(at..at + 2)?.try_into().ok()?;
        Some(if little {
            u16::from_le_bytes(b)
        } else {
            u16::from_be_bytes(b)
        })
    };
    let u32_at = |at: usize| -> Option<u32> {
        let b: [u8; 4] = bytes.get(at..at + 4)?.try_into().ok()?;
        Some(if little {
            u32::from_le_bytes(b)
        } else {
            u32::from_be_bytes(b)
        })
    };
    if u16_at(2) != Some(42) {
        return false;
    }
    let mut pending = vec![u32_at(4).unwrap_or(0) as usize];
    let mut seen = std::collections::HashSet::new();
    while let Some(offset) = pending.pop() {
        if offset == 0 {
            continue;
        }
        if !seen.insert(offset) || seen.len() > 64 {
            return false;
        }
        let Some(count) = u16_at(offset).map(usize::from) else {
            return false;
        };
        let Some(entries_end) = offset.checked_add(2 + count.saturating_mul(12) + 4) else {
            return false;
        };
        if entries_end > bytes.len() {
            return false;
        }
        let mut tags = std::collections::HashSet::new();
        for i in 0..count {
            let at = offset + 2 + i * 12;
            let Some(tag_id) = u16_at(at) else {
                return false;
            };
            if !tags.insert(tag_id) {
                return false;
            }
            let Some(kind) = u16_at(at + 2) else {
                return false;
            };
            let Some(n) = u32_at(at + 4).map(|v| v as usize) else {
                return false;
            };
            let unit = match kind {
                1 | 2 | 6 | 7 => 1usize,
                3 | 8 => 2,
                4 | 9 | 11 => 4,
                5 | 10 | 12 => 8,
                _ => return false,
            };
            if n == 0 {
                return false;
            }
            let Some(size) = n.checked_mul(unit) else {
                return false;
            };
            if size > 4 {
                let Some(value_offset) = u32_at(at + 8).map(|v| v as usize) else {
                    return false;
                };
                if value_offset
                    .checked_add(size)
                    .is_none_or(|end| end > bytes.len())
                {
                    return false;
                }
            }
            // IFD and EXIF/GPS pointer tags.
            if kind == 4
                && n == 1
                && matches!(tag_id, 0x8769 | 0x8825 | 0xa005)
                && let Some(value) = u32_at(at + 8)
                && value != 0
            {
                pending.push(value as usize);
            }
        }
        if let Some(next) = u32_at(offset + 2 + count * 12)
            && next != 0
        {
            pending.push(next as usize);
        }
    }
    true
}

fn image_type(bytes: &[u8]) -> Option<FileExtension> {
    if bytes.starts_with(&[0xff, 0xd8, 0xff]) {
        Some(FileExtension::JPEG)
    } else if bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        Some(FileExtension::PNG {
            as_zTXt_chunk: false,
        })
    } else {
        None
    }
}

fn parse_metadata(bytes: &[u8], file_type: FileExtension) -> Result<Metadata, String> {
    std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        Metadata::new_from_vec(&bytes.to_vec(), file_type)
    }))
    .map_err(|_| "photo metadata could not be parsed safely".to_owned())?
    .map_err(|error| format!("photo metadata is invalid: {error}"))
}

fn is_no_metadata_error(error: &str) -> bool {
    error.ends_with("No EXIF data found!") || error.ends_with("No metadata found!")
}

fn contains_exif_block(bytes: &[u8], file_type: FileExtension) -> bool {
    match file_type {
        FileExtension::JPEG => {
            let mut at = 2usize;
            while at + 1 < bytes.len() && bytes[at] == 0xff {
                while at < bytes.len() && bytes[at] == 0xff {
                    at += 1;
                }
                if at >= bytes.len() {
                    break;
                }
                let marker = bytes[at];
                at += 1;
                if marker == 0xda || marker == 0xd9 {
                    break;
                }
                if marker == 0x01 || (0xd0..=0xd7).contains(&marker) {
                    continue;
                }
                if at + 2 > bytes.len() {
                    break;
                }
                let length = u16::from_be_bytes([bytes[at], bytes[at + 1]]) as usize;
                if length < 2 || at + length > bytes.len() {
                    break;
                }
                if marker == 0xe1 && bytes.get(at + 2..at + 8) == Some(b"Exif\0\0") {
                    return true;
                }
                at += length;
            }
            false
        }
        FileExtension::PNG { .. } => {
            let mut at = 8usize;
            while at + 12 <= bytes.len() {
                let Ok(raw_len) = <[u8; 4]>::try_from(&bytes[at..at + 4]) else {
                    return false;
                };
                let len = u32::from_be_bytes(raw_len) as usize;
                let Some(end) = at.checked_add(12).and_then(|v| v.checked_add(len)) else {
                    return false;
                };
                if end > bytes.len() {
                    return false;
                }
                if &bytes[at + 4..at + 8] == b"eXIf"
                    || (&bytes[at + 4..at + 8] == b"zTXt"
                        && bytes[at + 8..at + 8 + len].starts_with(b"Raw profile type exif\0"))
                {
                    return true;
                }
                if &bytes[at + 4..at + 8] == b"IEND" {
                    break;
                }
                at = end;
            }
            false
        }
        _ => false,
    }
}

fn has_expected_date(metadata: &Metadata, value: &str) -> bool {
    metadata
        .get_tag(&ExifTag::DateTimeOriginal(String::new()))
        .any(|tag| format!("{tag:?}").contains(value))
}

fn atomic_replace(
    path: &Path,
    bytes: &[u8],
    timestamp: std::time::SystemTime,
) -> Result<(), String> {
    let parent = path.parent().unwrap_or_else(|| Path::new("."));
    let temp_path = temp_path(parent, path.file_name().unwrap_or_default());
    let permissions = fs::metadata(path)
        .map_err(|error| format!("could not inspect photo permissions: {error}"))?
        .permissions();
    let write_result = (|| -> std::io::Result<()> {
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temp_path)?;
        file.write_all(bytes)?;
        file.sync_all()?;
        drop(file);
        fs::set_permissions(&temp_path, permissions)?;
        set_file_times(&temp_path, timestamp).map_err(std::io::Error::other)?;
        replace_file(&temp_path, path)
    })();
    if write_result.is_err() {
        let _ = fs::remove_file(&temp_path);
    }
    write_result.map_err(|error| format!("could not safely replace photo: {error}"))
}

fn temp_path(parent: &Path, filename: &std::ffi::OsStr) -> PathBuf {
    let count = TEMP_COUNTER.fetch_add(1, Ordering::Relaxed);
    let mut name = filename.to_os_string();
    name.push(format!(".carrier-meta-{}-{count}.tmp", std::process::id()));
    parent.join(name)
}

#[cfg(not(windows))]
fn replace_file(temp: &Path, destination: &Path) -> std::io::Result<()> {
    fs::rename(temp, destination)
}

#[cfg(windows)]
fn replace_file(temp: &Path, destination: &Path) -> std::io::Result<()> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Storage::FileSystem::{
        MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH, MoveFileExW,
    };
    let temp: Vec<u16> = temp.as_os_str().encode_wide().chain(Some(0)).collect();
    let destination: Vec<u16> = destination
        .as_os_str()
        .encode_wide()
        .chain(Some(0))
        .collect();
    // SAFETY: both arguments are NUL-terminated UTF-16 buffers that remain alive for the call.
    let result = unsafe {
        MoveFileExW(
            temp.as_ptr(),
            destination.as_ptr(),
            MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
        )
    };
    if result == 0 {
        Err(std::io::Error::last_os_error())
    } else {
        Ok(())
    }
}

fn set_file_times(path: &Path, timestamp: std::time::SystemTime) -> Result<(), String> {
    let mut options = OpenOptions::new();
    options.write(true);
    configure_no_follow(&mut options);
    let file = options
        .open(path)
        .map_err(|error| format!("could not reopen updated media: {error}"))?;
    let times = std::fs::FileTimes::new().set_modified(timestamp);
    #[cfg(windows)]
    let times = {
        use std::os::windows::fs::FileTimesExt as _;
        times.set_created(timestamp)
    };
    #[cfg(target_os = "macos")]
    let times = {
        use std::os::darwin::fs::FileTimesExt as _;
        times.set_created(timestamp)
    };
    file.set_times(times)
        .map_err(|error| format!("could not set media timestamp: {error}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_offset_timestamp_and_rejects_invalid_dates() {
        let parsed = parse_shared_date("2022-03-04T05:06:07.123-04:30").unwrap();
        assert_eq!(parsed.exif_datetime, "2022:03:04 05:06:07");
        assert_eq!(parsed.offset, "-04:30");
        assert!(parse_shared_date("2022-02-29T05:06:07Z").is_err());
        assert!(parse_shared_date("2024-02-29T05:06:07Z").is_ok());
        assert!(parse_shared_date("2022-03-04T05:06:07").is_err());
        assert!(parse_shared_date("2003-12-31T23:59:59Z").is_err());
        assert!(parse_shared_date("2016-12-31T23:59:60Z").is_err());
        assert!(parse_shared_date("2101-01-01T00:00:00Z").is_err());
    }

    #[test]
    fn updates_jpeg_and_png_metadata_without_changing_pixels() {
        for (source, file_type) in [
            (
                include_bytes!("../tests/fixtures/shared-date-metadata.jpg").as_slice(),
                FileExtension::JPEG,
            ),
            (
                include_bytes!("../tests/fixtures/shared-date-metadata.png").as_slice(),
                FileExtension::PNG {
                    as_zTXt_chunk: false,
                },
            ),
        ] {
            let path = test_path("photo");
            fs::write(&path, source).unwrap();
            apply_shared_date(&path, "2022-03-04T05:06:07.123-04:30").unwrap();
            let updated = fs::read(&path).unwrap();
            let metadata = Metadata::new_from_vec(&updated, file_type).unwrap();
            for (tag, value) in [
                (0x9003, "2022:03:04 05:06:07"),
                (0x9004, "2022:03:04 05:06:07"),
                (0x0132, "2022:03:04 05:06:07"),
                (0x9011, "-04:30"),
                (0x9012, "-04:30"),
                (0x9010, "-04:30"),
            ] {
                assert!(
                    metadata
                        .get_tag_by_hex(tag, None)
                        .any(|found| format!("{found:?}").contains(value))
                );
            }
            assert!(
                metadata
                    .get_tag_by_hex(0x0112, None)
                    .any(|found| format!("{found:?}").contains("[6]"))
            ); // Orientation.
            assert!(
                metadata
                    .get_tag_by_hex(0x010e, None)
                    .any(|found| format!("{found:?}").contains("Carrier metadata test"))
            );
            assert_eq!(
                pixel_payload(source, file_type),
                pixel_payload(&updated, file_type)
            );
            let mtime = fs::metadata(&path).unwrap().modified().unwrap();
            assert_eq!(
                mtime.duration_since(UNIX_EPOCH).unwrap().as_secs(),
                1_646_386_567
            );
            #[cfg(any(target_os = "macos", windows))]
            assert_eq!(fs::metadata(&path).unwrap().created().unwrap(), mtime);
            fs::remove_file(path).unwrap();
        }
    }

    #[test]
    fn rejects_malformed_exif_without_replacing_original() {
        let mut malformed = include_bytes!("../tests/fixtures/shared-date-metadata.jpg").to_vec();
        let exif = malformed
            .windows(6)
            .position(|window| window == b"Exif\0\0")
            .expect("fixture has EXIF")
            + 6;
        // The first IFD offset is outside the EXIF segment.
        malformed[exif + 4..exif + 8].copy_from_slice(&u32::MAX.to_le_bytes());
        let path = test_path("malformed");
        fs::write(&path, &malformed).unwrap();
        assert!(apply_shared_date(&path, "2022-03-04T05:06:07Z").is_err());
        assert_eq!(fs::read(&path).unwrap(), malformed);
        fs::remove_file(path).unwrap();
    }

    #[test]
    fn adds_metadata_to_jpeg_and_png_without_existing_exif() {
        for (source, file_type) in [
            (
                include_bytes!("../tests/fixtures/shared-date-metadata.jpg").as_slice(),
                FileExtension::JPEG,
            ),
            (
                include_bytes!("../tests/fixtures/shared-date-metadata.png").as_slice(),
                FileExtension::PNG {
                    as_zTXt_chunk: false,
                },
            ),
        ] {
            let mut clean = source.to_vec();
            Metadata::clear_metadata(&mut clean, file_type).unwrap();
            let path = test_path("no-exif");
            fs::write(&path, clean).unwrap();
            apply_shared_date(&path, "2022-03-04T05:06:07Z").unwrap();
            let bytes = fs::read(&path).unwrap();
            let metadata = Metadata::new_from_vec(&bytes, file_type).unwrap();
            assert!(
                metadata
                    .get_tag_by_hex(0x9003, None)
                    .any(|tag| format!("{tag:?}").contains("2022:03:04 05:06:07"))
            );
            fs::remove_file(path).unwrap();
        }
    }

    #[test]
    fn large_unsupported_media_uses_filesystem_dates_without_loading_it() {
        let path = test_path("large-video");
        let file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&path)
            .unwrap();
        file.set_len(MAX_IMAGE_BYTES + 1024).unwrap();
        drop(file);
        apply_shared_date(&path, "2022-03-04T05:06:07Z").unwrap();
        let metadata = fs::metadata(&path).unwrap();
        assert_eq!(metadata.len(), MAX_IMAGE_BYTES + 1024);
        assert_eq!(
            metadata
                .modified()
                .unwrap()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_secs(),
            1_646_370_367
        );
        fs::remove_file(path).unwrap();
    }

    fn test_path(label: &str) -> PathBuf {
        std::env::temp_dir().join(format!(
            "carrier-metadata-{}-{label}-{}",
            std::process::id(),
            TEMP_COUNTER.fetch_add(1, Ordering::Relaxed)
        ))
    }

    fn pixel_payload(bytes: &[u8], file_type: FileExtension) -> Vec<u8> {
        match file_type {
            FileExtension::JPEG => {
                let start = bytes
                    .windows(2)
                    .position(|pair| pair == [0xff, 0xda])
                    .expect("fixture has a JPEG scan");
                bytes[start..].to_vec()
            }
            FileExtension::PNG { .. } => {
                let mut at = 8;
                let mut payload = Vec::new();
                while at + 12 <= bytes.len() {
                    let length = u32::from_be_bytes(bytes[at..at + 4].try_into().unwrap()) as usize;
                    if &bytes[at + 4..at + 8] == b"IDAT" {
                        payload.extend_from_slice(&bytes[at + 8..at + 8 + length]);
                    }
                    at += length + 12;
                }
                payload
            }
            _ => unreachable!(),
        }
    }
}
