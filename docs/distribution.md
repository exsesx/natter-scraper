# Standalone executables

The executable includes Bun and the application dependencies. Supported platforms are macOS and Linux with glibc, on x64 and arm64. Users need the file for their OS and architecture. Scraping requires network access to the catalog and an installed Chrome-family browser (Chrome, Chromium, Edge, or Brave); reopening saved JSON with `--input` requires neither. No separate Bun/Node runtime or repository checkout is required. Clipboard and file-opening actions have separate [desktop requirements](#desktop-actions).

Extraction uses Bun.WebView's Chrome backend on both platforms for request interception and network observation. Bun searches standard browser locations; `BUN_CHROME_PATH` can provide an absolute executable path, including in CI or with an empty `PATH`. The browser runs headlessly with an ephemeral profile, so scraping does not need a desktop session. The WebView API is experimental and tied to the pinned Bun release. See [Bun's backend documentation](https://bun.com/docs/runtime/webview#backends).

Build locally, or download an executable from [GitHub Releases](https://github.com/exsesx/natter-scraper/releases) when a release is available. CI uploads native builds as workflow artifacts; publishing a release is a separate step. The build does not configure publisher signing or notarization.

Keep `LICENSE` and `THIRD_PARTY_NOTICES.txt` with redistributed executables. `bun run build` copies the application's [license](../LICENSE) and the [third-party notices](THIRD_PARTY_NOTICES.txt) to `dist/`. Refresh the notices when upgrading Bun or production dependencies.

## Run an executable

On an Apple silicon Mac:

```sh
chmod +x natter-scraper-darwin-arm64

./natter-scraper-darwin-arm64 --help
./natter-scraper-darwin-arm64
./natter-scraper-darwin-arm64 --output products.json --pretty
./natter-scraper-darwin-arm64 --input products.json
```

Linux uses the macOS command form with its own filename. See the [CLI flags](../README.md#run) and [browser controls](../README.md#browse-in-a-terminal).

A plain interactive terminal run scrapes, then opens the catalog browser; `--input FILE` opens saved JSON without scraping. `--output products.csv` infers CSV, saves, and exits; add `-i` to browse afterward. Pipes, redirected streams, active CI, `TERM=dumb`, `--no-interactive`, and `--output -` bypass the browser. Prefer `--output` to shell redirection when saving so a failed crawl or load preserves the previous file. Opening saved JSON does not rewrite it. An explicit output path replaces its destination, including the input file if both paths match.

The startup concurrency default uses available CPUs and total RAM, with a cap of six. `--concurrency N` overrides it, including values above six. See the [default calculation and limits](../README.md#run).

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
| `test:terminal` | Source CLI in `Bun.Terminal`: navigation, dialogs, exports, saved-catalog reopening without crawling, resize, interaction defaults, and cancellation. |
| `test:binary` | Builds temporary production and fixture executables; checks help, exports, saved JSON loading and conversion without Chrome, file replacement, failures, and the terminal CLI cases against the compiled fixture. The additional mocked UI case still runs from source. |

These checks neither crawl the public catalog nor change the real clipboard or open desktop windows. Extraction tests launch a headless browser against local fixtures. Headless binary checks run outside the checkout with no Bun or desktop helpers on `PATH`. The saved-input checks deliberately use an invalid Chrome path; extraction checks still require an installed browser.

Terminal checks compare `stty -g` before and after each session and exercise Ctrl+C and SIGTERM on both supported platforms. The terminal transcript is not a screen emulator; rendering tests in `check` inspect the current frame.

[CI](../.github/workflows/check.yml) configures four native jobs, one per platform above. Each runs all three commands, builds, and uploads `dist/` for 14 days. Configuration alone does not establish a pass; consult [workflow results](https://github.com/exsesx/natter-scraper/actions/workflows/check.yml) for the exact commit. Record the checked commit, native platforms, and artifacts when publishing a release.

The workflow installs a browser with [setup-chrome](https://github.com/browser-actions/setup-chrome), checks that Bun.WebView can start it, and passes its absolute path to all checks. Linux uses the stable channel. macOS pins Chrome for Testing `153.0.8010.52`: the action's version installer preserves the `.app` bundle needed by Chrome's helper processes, while its channel installer strips that directory. Use the remote run for evidence on each platform; local macOS verification does not establish that the other jobs pass.

On Ubuntu runners, CI allows user namespaces for that exact browser executable through an AppArmor profile, following [Chromium's guidance](https://chromium.googlesource.com/chromium/src/+/main/docs/security/apparmor-userns-restrictions.md). It checks browser startup before and after loading the profile. Chrome's sandbox remains enabled; the workflow does not change the machine-wide namespace policy. Linux installations with the same restriction may need an administrator to configure their browser's profile.

## Publish a release

Releases are manual. Maintainers need repository write access and an authenticated [GitHub CLI](https://cli.github.com/); no agent application or personal tooling is required.

1. Update `version` in [package.json](../package.json). The CLI imports it, and both source and standalone checks compare `--version` with it. The release tag must be `v` followed by that version.
2. Install with `bun install --frozen-lockfile`, then run `check`, `test:terminal`, and `test:binary` as described above. Review and commit the release changes, then push.
3. Wait for the `Check` workflow to pass on that exact commit for all four platforms. Inspect its annotations as well as its overall status. Do not substitute results from an earlier commit.
4. Download that run's four artifacts into an empty directory with `gh run download RUN_ID --dir ARTIFACT_DIRECTORY`. Collect the four executables and identical copies of `LICENSE` and `THIRD_PARTY_NOTICES.txt` into a separate release directory. Use these native CI builds, not old files left in a local `dist/` directory.
5. Generate `SHA256SUMS` for the four executables and both license/notice files. Write release notes covering changes, platform/browser requirements, the checked commit and CI link, and verification limits. Create the release with `gh release create TAG --target CHECKED_COMMIT --title TAG --notes-file NOTES_FILE --latest`, passing all seven asset paths as positional arguments. Replace the uppercase placeholders with the selected version, commit, run, and local paths; never move an existing release tag.
6. Confirm the new release is marked latest and its tag points to the checked commit. Download its assets, verify their hashes against `SHA256SUMS`, and check `--version` on a native executable. Keep both license/notice files alongside redistributed executables.

## Desktop actions

Scraping and file export work without a desktop session. Browser actions that copy text or open a file or folder need the OS integration below:

| Platform | Clipboard | Open saved file or folder |
| --- | --- | --- |
| macOS | `pbcopy` | System `open` command |
| Linux | `wl-copy` for Wayland or `xsel` for X11 | `xdg-open` |

After loading a JSON file or saving, `p` copies the current file path, `o` opens its folder, and `f` opens the file in its default application. These actions require a desktop session and the helpers above. Saving alone launches nothing. Detected failures appear in the browser without changing the export; an open-request confirmation does not prove that an application became visible.

Desktop tests inject helpers. They do not verify real clipboard access or application launches across these platforms.
