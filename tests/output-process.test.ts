import { expect, test } from "bun:test";
import { spawn } from "node:child_process";

test("a downstream JSON command receives the full export without terminal output", async () => {
  const producer = Bun.spawn(
    [process.execPath, "tests/helpers/blocked-output-cli.ts"],
    { stdin: "ignore", stdout: "pipe", stderr: "pipe" },
  );
  const consumer = Bun.spawn(
    [
      process.execPath,
      "--eval",
      // Use the pinned runtime so this pipe regression does not require jq.
      "const catalog = await Bun.stdin.json(); console.log(JSON.stringify({ rows: catalog.results.length, total: catalog.total }));",
    ],
    { stdin: producer.stdout, stdout: "pipe", stderr: "pipe" },
  );

  try {
    const [producerCode, consumerCode, stdout, producerError, consumerError] =
      await Promise.all([
        producer.exited,
        consumer.exited,
        new Response(consumer.stdout).text(),
        new Response(producer.stderr).text(),
        new Response(consumer.stderr).text(),
      ]);

    expect(producerCode).toBe(0);
    expect(consumerCode).toBe(0);
    expect(stdout).toBe('{"rows":50000,"total":50000}\n');
    expect(producerError).toContain("Completed: 50000 products, 50000 results");
    expect(consumerError).toBe("");
  } finally {
    if (producer.exitCode === null) producer.kill();
    if (consumer.exitCode === null) consumer.kill();
  }
});

for (const [signal, expectedCode] of [
  ["SIGINT", 130],
  ["SIGTERM", 143],
] as const) {
  test(`${signal} exits after cancelling an actual blocked stdout pipe`, async () => {
    const child = spawn(
      process.execPath,
      ["tests/helpers/blocked-output-cli.ts"],
      {
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let stderr = "";

    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });

    // Leave stdout paused: observe its first bytes without draining the pipe.
    child.stdout.once("readable", () => child.kill(signal));

    let timer: ReturnType<typeof setTimeout> | undefined;

    try {
      const code = await new Promise<number | null>((resolve, reject) => {
        child.once("error", reject);
        child.once("exit", resolve);
        timer = setTimeout(
          () =>
            reject(
              new Error("Cancellation did not exit a blocked stdout writer"),
            ),
          3_000,
        );
      });

      expect(code).toBe(expectedCode);
      expect(stderr).toContain("Cancelled:");
      expect(stderr).not.toContain("Completed:");
    } finally {
      clearTimeout(timer);

      if (child.exitCode === null) child.kill("SIGKILL");

      child.stdout.destroy();
      child.stderr.destroy();
    }
  });
}
