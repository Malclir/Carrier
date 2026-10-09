import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const chromium =
  (Bun.env.CHROME_BIN && Bun.which(Bun.env.CHROME_BIN)) ||
  Bun.which("google-chrome") ||
  Bun.which("chromium");

test.skipIf(!chromium)(
  "bulk media source and localized navigation fixtures",
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "carrier-bulk-media-test-"));
    try {
      const entry = fileURLToPath(new URL("./bulk-media.ts", import.meta.url));
      const bundle = await build({
        stdin: {
          contents: `import { findBulkMediaSource, findMediaNavigation } from ${JSON.stringify(entry)}; import { findRolelessMediaViewer } from ${JSON.stringify(fileURLToPath(new URL("./bulk-media-viewer.ts", import.meta.url)))}; window.fixture = { findBulkMediaSource, findMediaNavigation, findRolelessMediaViewer };`,
          resolveDir: import.meta.dir,
        },
        bundle: true,
        write: false,
      });
      const html = `<!doctype html><html><head><meta charset="utf-8"><style>
      html,body{margin:0;width:100%;height:100%} [role=dialog]{position:fixed;inset:0}
      .media{position:absolute;inset:10%;width:80%;height:80%}button{position:absolute;top:12px;left:12px;width:50px;height:50px}
      .fullscreen{position:relative;overflow:hidden;width:100vw;height:100vh}
      .fullscreen img{position:absolute;left:10vw;top:10vh;width:80vw;height:80vh}
      .fullscreen a{position:absolute;left:8px;top:8px;width:36px;height:36px}
      .fullscreen button{width:44px;height:36px;top:8px;left:48px}
      .normal{position:absolute;left:20px;top:20px;width:300px;height:300px}
      [hidden]{display:none!important}
    </style></head><body><div id="viewer" role="dialog">
      <img class="media">
      <a download="original.jpg" href="https://cdn.test/original.jpg">Download</a>
      <button aria-label="Envoyer">Send</button><button aria-label="Supprimer">Delete</button>
      <button id="prev" aria-label="Photo précédente"></button><button id="next" title="Suivante"></button>
    </div><pre id="result">RUNNING</pre><script>${bundle.outputFiles[0]!.text}
      try {
        const dialog=document.getElementById('viewer');
        const image=dialog.querySelector('img');
        Object.defineProperty(image,'currentSrc',{value:'https://cdn.test/thumb.jpg'});
        Object.defineProperty(image,'src',{value:'https://cdn.test/thumb.jpg'});
        const selected=window.fixture.findBulkMediaSource(dialog);
        const older=window.fixture.findMediaNavigation(dialog,'older');
        const newer=window.fixture.findMediaNavigation(dialog,'newer');
        if(!selected || !selected.src.endsWith('/original.jpg')) throw new Error('download link was not preferred');
        if(older?.id!=='prev' || newer?.id!=='next') throw new Error('French navigation labels were not recognized');
        document.querySelector('a[download]').remove();
        const fallback=window.fixture.findBulkMediaSource(dialog);
        if(!fallback || !fallback.src.endsWith('/thumb.jpg')) throw new Error('visible media fallback was not selected');
        image.style.cssText='position:absolute;inset:auto;top:10px;left:10px;width:12px;height:12px';
        if(window.fixture.findBulkMediaSource(dialog)!==null) throw new Error('small avatar was accepted as full-size media');
        const video=document.createElement('video'); video.controls=true; video.className='media'; dialog.append(video);
        Object.defineProperty(video,'currentSrc',{value:'blob:https://www.facebook.com/opaque-video'});
        if(window.fixture.findBulkMediaSource(dialog)!==null) throw new Error('video thumbnail was selected for a blob-backed video');
        const fullscreen=document.createElement('div'); fullscreen.className='fullscreen'; fullscreen.id='roleless';
        fullscreen.innerHTML='<img src="https://cdn.test/full.jpg"><a download="photo.jpg" href="https://cdn.test/photo.jpg">Download</a><button aria-label="Close"></button><button aria-label="Previous photo"></button><button aria-label="Next photo"></button>';
        document.body.append(fullscreen);
        const detected=window.fixture.findRolelessMediaViewer();
        if(detected!==fullscreen) throw new Error('roleless fullscreen viewer was not recognized');
        if(window.fixture.findMediaNavigation(detected,'older')?.getAttribute('aria-label')!=='Previous photo') throw new Error('roleless previous navigation was not recognized');
        fullscreen.querySelector('[aria-label="Next photo"]').remove();
        const nested=document.createElement('div'); nested.setAttribute('role','dialog');
        nested.innerHTML='<a download="nested.jpg" href="https://cdn.test/nested.jpg">Download</a><button aria-label="Next photo"></button>';
        fullscreen.append(nested);
        if(window.fixture.findMediaNavigation(detected,'newer')!==null) throw new Error('nested dialog navigation was accepted');
        if(window.fixture.findBulkMediaSource(detected)?.src.endsWith('/nested.jpg')) throw new Error('nested dialog download was accepted');
        nested.remove();
        if(window.fixture.findRolelessMediaViewer()!==fullscreen) throw new Error('one-direction viewer endpoint was not recognized');
        fullscreen.remove();
        const chat=document.createElement('div'); chat.className='fullscreen';
        chat.innerHTML='<img src="https://cdn.test/chat.jpg"><a download="chat.jpg" href="https://cdn.test/chat.jpg">Download</a><button aria-label="Close"></button><button aria-label="Previous photo"></button><button aria-label="Next photo"></button><div contenteditable="true"></div>';
        document.body.append(chat);
        if(window.fixture.findRolelessMediaViewer()!==null) throw new Error('ordinary chat was accepted as a media viewer');
        document.getElementById('result').textContent='PASS';
      } catch(error) { document.getElementById('result').textContent=String(error); }
    </script></body></html>`;
      const file = join(directory, "fixture.html");
      await writeFile(file, html);
      const process = Bun.spawn(
        [
          chromium!,
          "--headless",
          "--disable-gpu",
          "--no-sandbox",
          "--no-first-run",
          `--user-data-dir=${join(directory, "profile")}`,
          "--disable-background-networking",
          "--disable-component-update",
          "--disable-sync",
          "--no-default-browser-check",
          "--window-size=800,700",
          "--virtual-time-budget=5000",
          "--dump-dom",
          pathToFileURL(file).href,
        ],
        { stdout: "pipe", stderr: "pipe", timeout: 30_000, killSignal: "SIGKILL" },
      );
      const reader = process.stdout.getReader();
      const decoder = new TextDecoder();
      let output = "";
      while (!output.includes("</html>")) {
        const chunk = await reader.read();
        if (chunk.done) break;
        output += decoder.decode(chunk.value, { stream: true });
      }
      // Some macOS Chrome builds keep updater/helper children alive after
      // --dump-dom has flushed the complete fixture document.
      if (output.includes("</html>")) process.kill("SIGKILL");
      await process.exited;
      expect(output.match(/<pre id="result">([^<]+)/)?.[1]).toBe("PASS");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
  60_000,
);

declare global {
  interface Window {
    fixture: {
      findBulkMediaSource(dialog: HTMLElement): unknown;
      findMediaNavigation(dialog: HTMLElement, direction: "older" | "newer"): HTMLElement | null;
      findRolelessMediaViewer(): HTMLElement | null;
    };
  }
}
