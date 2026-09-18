import { Effect } from "effect";
import { finishCli, runCli } from "./cli";

finishCli(await Effect.runPromise(runCli(process.argv.slice(2))));
