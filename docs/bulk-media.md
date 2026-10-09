# Carrier Media local fork

This fork adds a sequential photo/video download control to Carrier's Messenger
media viewer. It uses the signed-in Messenger page and Carrier's existing native
download handling. Live sequential photo saving has been verified on this Mac;
this remains a prototype and does not guarantee a complete chat export.

## Try it

1. Open **Carrier Media**, sign in to Facebook, and restore Messenger history if
   Facebook requests your PIN.
2. Open the target chat, open its shared media gallery, then open a full-size
   photo or video.
3. Use the **Batch download** panel at the top left, choose **Previous** or
   **Next**, and start. The currently open item is included. Files go into your
   Downloads folder. The top-right download icon still saves just one item.
4. Keep the viewer open. Pause before interacting with the gallery. A download
   already being saved may finish after pausing or stopping.

The selected direction follows Messenger's viewer buttons. It does not imply
chronological order. To cover both sides of a starting item, run in each
direction; successful items are deduplicated during the current page session.
Existing local files are never overwritten.

The control reports files saved only after Carrier confirms native completion.
If it stops because navigation cannot be recognized, that does not establish
that the whole chat has been downloaded. Missing, expired, unavailable, and
not-yet-restored media may prevent a complete export. This version does not
collect voice messages, arbitrary attachments, or message text. Carrier's
existing 512 MiB per-file limit applies.

If Settings is configured to ask where to save every download, change its
download setting to **Downloads folder** before starting a batch.

## Build locally on this Mac

From the repository root (Bun can also be installed normally):

```sh
npm exec --yes --package bun -- bun install --frozen-lockfile
npm exec --yes --package bun -- bun run build:inject
RUSTUP_TOOLCHAIN=1.95.0 npm exec --yes --package bun -- bun run tauri build --debug --features diagnostics --bundles app
open 'src-tauri/target/debug/bundle/macos/Carrier Media.app'
```

The local app uses the bundle identifier `local.carrier.media`, separate settings
and logs, and disables automatic upstream update checks. This diagnostics build
blocks upstream release updates. The original Carrier licensing and attribution
remain in place.

## Validation on this Mac (October 9, 2026)

- Native app built and launched successfully; login survived the update.
- Rust formatting, Clippy, and all 316 native unit tests passed.
- TypeScript type checks and lint completed successfully (one existing warning).
- All six new queue tests and the new Chrome media-selection fixture passed.
- The full JavaScript suite finished with 712 passes, 3 skips, and 11 browser
  failures involving timeouts or Chrome termination/display errors. It is not
  fully green on this machine.
- Fixed the panel for Messenger's fullscreen viewer without a dialog role.
  Regression coverage includes this layout, a single navigation arrow, and
  exclusion of unrelated chat controls and nested dialogs.
- Live verification confirmed the panel was visible at the top left and the
  batch reached **Saved 4, Failed 0** while advancing automatically. New nonempty
  image files were also confirmed in Downloads. Whole-chat completeness and
  video coverage have not yet been verified.
