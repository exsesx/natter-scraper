import { expect, test } from "bun:test";
import { spawn } from "node:child_process";

for (const [signal, expectedCode] of [
  ["SIGINT", 130],
  ["SIGTERM", 143],
] as const) {
  // Windows kill() terminates a process instead of delivering POSIX signals.
  test.skipIf(process.platform === "win32")(
    `${signal} exits after cancelling an actual blocked stdout pipe`,
    async () => {
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
    },
  );
}
