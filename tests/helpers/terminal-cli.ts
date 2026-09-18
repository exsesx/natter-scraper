import { Effect } from "effect";
import { finishCli, runCli } from "../../src/cli";
import { crawl } from "../../src/crawl";
import { fixturePage, fixturePrefix } from "./fixture-site";

// Repeatable terminal integration fixture; no traffic reaches the public source.
const server =
  process.env.FORBID_CRAWL === "1"
    ? undefined
    : Bun.serve({
        port: 0,
        hostname: "127.0.0.1",
        async fetch(request) {
          const url = new URL(request.url);

          if (process.env.SLOW_FIXTURE === "1") await Bun.sleep(5_000);

          const html = fixturePage(url.pathname, url.search);

          return new Response(html ?? "Missing", {
            status: html ? 200 : 404,
            headers: { "content-type": "text/html" },
          });
        },
      });
let code = 1;

try {
  code = await Effect.runPromise(
    runCli(process.argv.slice(2), {
      crawl: (options) => {
        if (!server)
          throw new Error("Crawl forbidden for saved catalog verification");

        return crawl({
          ...options,
          baseUrl: `http://127.0.0.1:${server.port}${fixturePrefix}`,
          runTimeoutMs: 30_000,
        });
      },
    }),
  );
} finally {
  server?.stop(true);
}

finishCli(code);
