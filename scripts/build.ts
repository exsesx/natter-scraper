import { copyFile, mkdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const targets = [
  "bun-darwin-arm64",
  "bun-darwin-x64",
  "bun-linux-arm64",
  "bun-linux-x64",
  "bun-windows-arm64",
  "bun-windows-x64",
] as const;

export type Target = (typeof targets)[number];
export const projectRoot = fileURLToPath(new URL("../", import.meta.url));

function parseTarget(value: string): Target {
  if (!targets.includes(value as Target))
    throw new Error(
      `Unsupported target ${value}. Choose ${targets.join(", ")}.`,
    );

  return value as Target;
}

export function nativeTarget(): Target {
  const os = process.platform === "win32" ? "windows" : process.platform;

  return parseTarget(`bun-${os}-${process.arch}`);
}

export function binaryName(target: Target): string {
  return `natter-scraper-${target.slice(4)}${target.includes("windows") ? ".exe" : ""}`;
}

/** Production and fixture executables share every bundling option. */
export async function compileBinary({
  entrypoint,
  outfile,
  target = nativeTarget(),
}: {
  entrypoint: string;
  outfile: string;
  target?: Target;
}): Promise<void> {
  await mkdir(dirname(outfile), { recursive: true });

  const result = await Bun.build({
    entrypoints: [entrypoint],
    target: "bun",
    compile: {
      target: target.endsWith("-x64")
        ? (`${target}-baseline` as Bun.Build.CompileTarget)
        : target,
      outfile,
      autoloadDotenv: false,
      autoloadBunfig: false,
    },
    minify: true,
    define: { "process.env.DEV": '"false"', NATTER_STANDALONE: "true" },
    plugins: [
      {
        name: "exclude-ink-devtools",
        setup(build) {
          // Ink's optional React DevTools entry is unreachable in production,
          // but its dynamic import is still resolved while bundling.
          build.onLoad(
            { filter: /[/\\]ink[/\\]build[/\\]devtools\.js$/ },
            () => ({ contents: "export {};", loader: "js" }),
          );
        },
      },
    ],
  });

  if (!result.success)
    throw new AggregateError(result.logs, `Could not compile ${target}`);
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const usage = `Usage: bun run build [--target bun-<os>-<arch>]\nTargets: ${targets.join(", ")}`;

  if (args.length === 1 && args[0] === "--help") {
    console.log(usage);
  } else if (
    args.length &&
    (args.length !== 2 ||
      args[0] !== "--target" ||
      !targets.includes(args[1] as Target))
  ) {
    console.error(usage);
    process.exitCode = 2;
  } else {
    const target = args[1] ? parseTarget(args[1]) : nativeTarget();
    const outfile = join(projectRoot, "dist", binaryName(target));

    await compileBinary({
      entrypoint: resolve(projectRoot, "src/cli.ts"),
      outfile,
      target,
    });
    await copyFile(
      join(projectRoot, "docs/THIRD_PARTY_NOTICES.txt"),
      join(projectRoot, "dist/THIRD_PARTY_NOTICES.txt"),
    );

    console.log(outfile);
  }
}
