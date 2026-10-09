# Windows installer builds

The **Windows installer** workflow builds a Windows x64 installer and portable archive for this branch. It runs when changes are pushed to `feature/bulk-media-download`, or on demand from GitHub Actions.

To download a build, open the repository's **Actions** tab, select **Windows installer**, and open the run you want. Download **Carrier-Media-Windows-x64** under **Artifacts**, then unzip it. Run `Carrier-Media-Windows-x64-setup.exe` to install, or extract `Carrier-Media-Windows-x64-portable.zip` and run `Carrier.exe`. The artifact includes `SHA256SUMS.txt` with checksums for both downloads. Artifacts are available for 30 days.

This is an unsigned test build. Windows may display an unknown-publisher or reputation prompt. The setup installer handles the WebView2 runtime dependency; the portable version requires WebView2 to be installed already.

Carrier uses Facebook Messenger's own sign-in. Sign in separately in this Windows copy, and restore Messenger history through Facebook's normal account and device recovery flow if needed. The bulk media download feature is shared across platforms, but this Windows build has not yet been tried by a Windows user.

The workflow builds only x64 for now. ARM64 can be added after this initial Windows build is confirmed.
