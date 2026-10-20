import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";
import type { findDownloadChatName as findDownloadChatNameType } from "./download-chat-name";

const chromium = Bun.env.CHROME_BIN && Bun.which(Bun.env.CHROME_BIN);

test.skipIf(!chromium)("finds only a unique visible Messenger conversation name", async () => {
  const directory = await mkdtemp(join(tmpdir(), "carrier-chat-name-"));
  try {
    const bundle = await build({
      stdin: {
        contents: `
          import { findDownloadChatName } from "./download-chat-name";
          (${runFixture.toString()})(findDownloadChatName);
        `,
        resolveDir: import.meta.dir,
      },
      bundle: true,
      write: false,
    });
    const file = join(directory, "index.html");
    await writeFile(
      file,
      `<!doctype html><html><body>
        <nav id="chat-list"><h3>Conversation with Distracting Row</h3></nav>
        <section id="active"><div><h3>Conversation with First Last</h3><div contenteditable="true"></div></div></section>
        <section id="same"><div><h3>Conversation with First Last</h3><div contenteditable="true"></div></div></section>
        <section hidden><div><h3>Conversation with Hidden Person</h3><div contenteditable="true"></div></div></section>
        <section inert><div><h3>Conversation with Inert Person</h3><div contenteditable="true"></div></div></section>
        <section style="display:none"><div><h3>Conversation avec Personne Cachée</h3><div contenteditable="true"></div></div></section>
        <section id="generic"><div><h3>First Last</h3><div contenteditable="true"></div></div><p>Conversation with Message Text</p></section>
        <section id="french"><div><h3>Conversation avec Élodie Núñez</h3><div contenteditable="true"></div></div></section>
        <section id="empty"><div><h3>Conversation with</h3><div contenteditable="true"></div></div></section>
        <section id="log" role="log" aria-label="Conversation with Group Title"></section>
        <pre id="result">RUNNING</pre>
        <script>${bundle.outputFiles?.[0]?.text || ""}</script>
      </body></html>`,
    );
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
    if (output.includes("</html>")) process.kill("SIGKILL");
    await process.exited;
    expect(output.match(/<pre id="result">([^<]+)/)?.[1]).toBe("PASS");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

async function runFixture(find: typeof findDownloadChatNameType) {
  const result = document.getElementById("result")!;
  const check = (condition: unknown, message: string) => {
    if (!condition) throw new Error(message);
  };
  try {
    const root = document.body;
    check(find(root) === undefined, "conflicting visible conversations must be ambiguous");
    document.getElementById("french")!.remove();
    document.getElementById("log")!.remove();
    check(find(root) === "First Last", "duplicate copies of one visible name should agree");

    document.getElementById("same")!.remove();
    document.getElementById("active")!.remove();
    document.getElementById("generic")!.remove();
    document.getElementById("empty")!.remove();
    check(find(root) === undefined, "chat-list and hidden headings must be ignored");

    const french = document.createElement("section");
    french.innerHTML =
      '<div><h3>Conversation avec Élodie Núñez</h3><div contenteditable="true"></div></div>';
    root.append(french);
    check(find(root) === "Élodie Núñez", "French conversation heading must be recognized");

    french.remove();
    const log = document.createElement("section");
    log.setAttribute("role", "log");
    log.setAttribute("aria-label", "Conversation with Group Title");
    root.append(log);
    check(find(root) === "Group Title", "role=log label variant must be recognized");

    log.remove();
    const empty = document.createElement("section");
    empty.innerHTML = '<div><h3>Conversation with</h3><div contenteditable="true"></div></div>';
    root.append(empty);
    check(find(root) === undefined, "empty titles must not provide a prefix");
    result.textContent = "PASS";
  } catch (error) {
    result.textContent = `FAIL: ${error instanceof Error ? error.message : String(error)}`;
  }
}
