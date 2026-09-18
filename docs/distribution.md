# Standalone executables

The executable includes Bun and the application dependencies. An end user needs the matching executable and network access to the assigned catalog. They do not need Bun, Node.js, Python, or a checkout of this repository. Clipboard and folder actions have separate [desktop requirements](#desktop-actions).

Download executables from [GitHub Releases](https://github.com/exsesx/natter-scraper/releases), or build them locally. CI attaches native builds to its workflow runs; release assets are published separately from those checked builds. The build does not configure publisher signing or notarization; Bun's macOS executable has an ad hoc signature.

Keep `THIRD_PARTY_NOTICES.txt` with the executable when redistributing it. `bun run build` copies the [versioned notices](THIRD_PARTY_NOTICES.txt) to `dist/`. They cover Bun and the production dependency tree pinned for this release. Refresh the notices when upgrading those dependencies.

## Run an executable

Choose the file for your OS and architecture. Keep the filename below, or rename it to `natter-scraper` on macOS/Linux or `natter-scraper.exe` on Windows.

For example, on an Apple silicon Mac:

```sh
chmod +x natter-scraper-darwin-arm64

./natter-scraper-darwin-arm64 --help
./natter-scraper-darwin-arm64 --output products.json --pretty
```

On Windows x64 in PowerShell:

```powershell
.\natter-scraper-windows-x64.exe --help
.\natter-scraper-windows-x64.exe --output products.json --pretty
```

Linux uses the same `./filename` commands as macOS with the appropriate Linux filename. All executable variants accept the flags and completion keys documented in the [README](../README.md#run). Prefer `--output` when saving a file so an unsuccessful crawl preserves the previous result. `--no-interactive` disables terminal interaction for automation.

## Build from source

Use the repository's pinned Bun **1.4.2** from the repository root:

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

The build embeds Ink's Yoga WebAssembly asset and omits optional React development tools. It disables automatic loading of `.env` and `bunfig.toml` files so a user's working directory does not silently configure the executable. Explicit process environment settings, including the documented `CI` behavior, still apply.

## Verify on the target platform

```sh
bun run check

bun run test:terminal

bun run build
bun run test:binary
```

`check` covers the source application using captured HTML, synthetic cases, and local HTTP servers. `test:terminal` uses `Bun.Terminal` and fixture servers to exercise the source CLI. `test:binary` builds temporary production and fixture executables, checks output, and runs the main terminal cases through the compiled fixture. These checks do not crawl the public catalog, copy real clipboard contents, or open folders.

The terminal suite has 13 cases on macOS/Linux. It covers completion keys, alternate copy formats, resize, opt-out/CI behavior, and cancellation while running or after completion. It compares `stty -g` before and after each terminal session to check POSIX terminal-mode restoration.

Windows uses ConPTY and runs 11 cases. It skips the two POSIX SIGTERM cases. Ctrl+C is exercised as terminal input; force-killing a Windows process is not a graceful cancellation path. Full Windows console-mode restoration is not verified by these checks.

During `test:binary`, 10 terminal cases execute the compiled fixture on macOS/Linux, or 8 on Windows. The three alternate-copy cases still use the source UI helper with mocked desktop actions. They do not establish that the packaged executable can access the real clipboard.

[CI](../.github/workflows/check.yml) has six native jobs, one per OS/architecture pair above. Each runs the source checks, terminal checks, compiled checks, and uploads its executable as a workflow artifact. [Workflow results](https://github.com/exsesx/natter-scraper/actions/workflows/check.yml) record the outcome for each commit. Release notes identify the checked commit and supported artifacts.

## Desktop actions

Scraping and file export work without a desktop session. Completion keys that copy or open a folder need the OS integration below:

| Platform | Clipboard | Open saved file's folder |
| --- | --- | --- |
| macOS | `pbcopy` | System `open` command |
| Windows | PowerShell clipboard support | Windows shell through PowerShell |
| Linux | `wl-copy` for Wayland or `xsel` for X11 | `xdg-open` |

A desktop session must make these helpers available. Missing helpers and other detected failures appear in the completion view. “Folder open requested” confirms that the request was handed to the launcher; it does not establish that a folder became visible, and a later launcher failure may go undetected. The completed export remains available and the file is unchanged. Use `--no-interactive` for unattended runs.

Desktop checks use injected helpers. Actual clipboard writes and folder opening have not been verified across these platforms.
