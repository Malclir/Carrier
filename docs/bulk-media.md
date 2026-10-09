# Carrier Media local fork

This fork adds batch photo/video saving from Carrier's Messenger shared media
gallery and full-size media viewer. Year batches scan dated gallery sections and
save only originals Messenger exposes for the selected year. Direction batches
start with the open item and follow the viewer's Previous or Next controls. This
remains a prototype and does not guarantee a complete chat export.

## Try it

1. Open **Carrier Media**, sign in to Facebook, and restore Messenger history if
   Facebook requests your PIN.
2. Open the target chat and its shared media gallery. Use **Whole year** to
   select a year and save its dated photos and videos. The suggested year comes
   from visible gallery tiles when possible; edit it before starting if needed.
3. To batch from one item, open a full-size photo or video, choose **From open
   photo**, select **Previous** or **Next**, and start. This includes the open
   item and follows the viewer's controls.
4. The destination starts as **Downloads**. Choose **Choose folder** to pick a
   different native folder, such as `Downloads/2020`; the panel shows its name,
   not its path. Pause before interacting with the gallery during a year batch.
   A download already being saved may finish after pausing or stopping.

The selected direction follows Messenger's viewer buttons. It does not imply
chronological order. To cover both sides of a starting item, run in each
direction. Successfully saved items are deduplicated per chat and destination
during the current page session. Existing local files are never overwritten.

The control reports files saved only after Carrier confirms native completion.
If it stops because navigation cannot be recognized, that does not establish
that the whole chat has been downloaded. Missing, expired, unavailable, and
not-yet-restored media may prevent a complete export. This version does not
collect voice messages, arbitrary attachments, or message text. Carrier's
existing 512 MiB per-file limit applies.

If Settings is configured to ask where to save every download, choose a batch
folder first. That folder is used for this batch without changing the per-file
ask setting. Ordinary downloads continue to follow the setting.

Custom destinations need a build with the native batch-folder picker. If Carrier
reports that the feature needs a newer version, build the updated app and restart it.
Messenger only exposes part of a chat's gallery at a time; a year scan can stop
at the oldest loaded section and does not promise complete history. Items with
unknown dates are not included in a year batch.

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

## Year and folder validation (October 9, 2026)

- Full frontend check passed: lint, TypeScript, 716 tests (16 optional browser
  tests skipped), and regenerated injection bundles.
- The focused Chrome gallery fixture passed separately, covering adjacent-year
  exclusion, delayed loading, pause/cancel, destination-scoped deduplication,
  and a viewer that refuses to close.
- Rust formatting, Clippy, and all 319 library tests passed.
- A live 2020 year batch saved three nonempty images into a folder selected with
  the native picker, reported zero failures, and paused with the viewer closed.
- A complete year export and live video saving have not yet been verified.
  Windows needs a new build from the existing Windows installer workflow.

## Earlier direction-batch prototype validation (October 9, 2026)

These checks were recorded before year scanning and folder selection were
integrated. Rebuild and restart Carrier to validate the current year workflow.

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
