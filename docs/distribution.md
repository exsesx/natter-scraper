# Standalone executables

The executable includes Bun and the application dependencies. Users need the file for their OS and architecture, network access to the catalog, and an installed Chrome-family browser (Chrome, Chromium, Edge, or Brave). No separate Bun/Node runtime or repository checkout is required. Clipboard and file-opening actions have separate [desktop requirements](#desktop-actions).

Extraction uses Bun.WebView's Chrome backend on all platforms, including macOS, for request interception and network observation. Bun searches standard browser locations; `BUN_CHROME_PATH` can provide an absolute executable path, including in CI or with an empty `PATH`. The browser runs headlessly with an ephemeral profile, so scraping does not need a desktop session. The WebView API is experimental and tied to the pinned Bun release. See [Bun's backend documentation](https://bun.com/docs/runtime/webview#backends).

Download from [GitHub Releases](https://github.com/exsesx/natter-scraper/releases), or build locally. CI uploads native builds as workflow artifacts; publishing a release is a separate step. The build does not configure publisher signing or notarization.

Keep `THIRD_PARTY_NOTICES.txt` with redistributed executables. `bun run build` copies the [notices](THIRD_PARTY_NOTICES.txt) to `dist/`. Refresh them when upgrading Bun or production dependencies.

## Run an executable

On an Apple silicon Mac:

```sh
chmod +x natter-scraper-darwin-arm64

./natter-scraper-darwin-arm64 --help
./natter-scraper-darwin-arm64
./natter-scraper-darwin-arm64 --output products.json --pretty
```

On Windows x64 in PowerShell:

```powershell
.\natter-scraper-windows-x64.exe --help
.\natter-scraper-windows-x64.exe
.\natter-scraper-windows-x64.exe --output products.json --pretty
```

Linux uses the macOS command form with its own filename. See the [CLI flags](../README.md#run) and [browser controls](../README.md#browse-in-a-terminal).

A plain interactive terminal run opens the browser. `--output products.csv` infers CSV, saves, and exits; add `-i` to browse afterward. Pipes, redirected streams, active CI, `TERM=dumb`, `--no-interactive`, and `--output -` bypass the browser. Prefer `--output` to shell redirection when saving so a failed crawl preserves the previous file.

## Build from source

Use the pinned Bun version in [`.bun-version`](../.bun-version), currently 1.4.2, from the repository root:

```sh
bun install --frozen-lockfile

bun run check

bun run build --help
bun run build
```

Without a target, the build selects the current OS and architecture. To compile a different target:

```sh
bun run build --target bun-linux-x64
```

| Platform | Target argument | Output file |
| --- | --- | --- |
| macOS, Apple silicon | `bun-darwin-arm64` | `dist/natter-scraper-darwin-arm64` |
| macOS, Intel | `bun-darwin-x64` | `dist/natter-scraper-darwin-x64` |
| Linux, arm64 | `bun-linux-arm64` | `dist/natter-scraper-linux-arm64` |
| Linux, x64 | `bun-linux-x64` | `dist/natter-scraper-linux-x64` |
| Windows, arm64 | `bun-windows-arm64` | `dist/natter-scraper-windows-arm64.exe` |
| Windows, x64 | `bun-windows-x64` | `dist/natter-scraper-windows-x64.exe` |

Linux builds require glibc. Alpine and other musl distributions are outside these targets. x64 builds use Bun's baseline CPU target. Cross-compiling a file does not verify that it runs on the target platform; run the native checks there.

The build embeds Ink's Yoga WebAssembly asset, omits optional React development tools, and disables automatic loading of `.env` and `bunfig.toml`. Process environment settings, including `CI`, still apply.

## Verify on the target platform

```sh
bun run check

bun run test:terminal

bun run test:binary
```

| Command | Coverage |
| --- | --- |
| `check` | Types, lint, and tests using captured HTML, synthetic cases, and local HTTP servers. |
| `test:terminal` | Source CLI in `Bun.Terminal`: navigation, dialogs, exports, resize, interaction defaults, and cancellation. |
| `test:binary` | Builds temporary production and fixture executables; checks help, exports, file replacement, failures, and the terminal CLI cases against the compiled fixture. The additional mocked UI case still runs from source. |

These checks neither crawl the public catalog nor change the real clipboard or open desktop windows. Extraction tests launch a headless browser against local fixtures. Headless binary checks run outside the checkout with no Bun or desktop helpers on `PATH`; an installed browser is still required.

On macOS/Linux, terminal checks compare `stty -g` before and after each session. Windows uses ConPTY, tests Ctrl+C as terminal input, and skips POSIX SIGTERM cases. Full Windows console-mode restoration remains unverified. The terminal transcript is not a screen emulator; rendering tests in `check` inspect the current frame.

[CI](../.github/workflows/check.yml) configures six native jobs, one per platform above. Each runs all three commands, builds, and uploads `dist/` for 14 days. Configuration alone does not establish a pass; consult [workflow results](https://github.com/exsesx/natter-scraper/actions/workflows/check.yml) for the exact commit. Record the checked commit, native platforms, and artifacts when publishing a release.

The workflow installs a browser with [setup-chrome](https://github.com/browser-actions/setup-chrome) and passes its absolute path to all checks. It uses the stable channel except on Windows arm64, where the action supports Chromium snapshots instead. These CI changes need a remote run; local macOS verification does not establish that the other jobs pass.

## Desktop actions

Scraping and file export work without a desktop session. Browser actions that copy text or open a file or folder need the OS integration below:

| Platform | Clipboard | Open saved file or folder |
| --- | --- | --- |
| macOS | `pbcopy` | System `open` command |
| Windows | PowerShell clipboard support | Windows shell through PowerShell |
| Linux | `wl-copy` for Wayland or `xsel` for X11 | `xdg-open` |

After saving, `p` copies the path, `o` opens its folder, and `f` opens the file in its default application. These actions require a desktop session and the helpers above. Saving alone launches nothing. Detected failures appear in the browser without changing the export; an open-request confirmation does not prove that an application became visible.

Desktop tests inject helpers. They do not verify real clipboard access or application launches across these platforms.
