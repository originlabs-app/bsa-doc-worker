import type { ReaderConfig, ReaderMode } from "./config.js";
import {
  runReaderTick,
  type ReaderPipelineDependencies,
  type ReaderTickReport,
} from "./pipeline.js";

export interface ReaderServiceReport {
  mode: ReaderMode;
  ticks: number;
  claimed: number;
}

type Tick = (
  config: ReaderConfig,
  dependencies: ReaderPipelineDependencies,
) => Promise<ReaderTickReport>;

function currentMode(
  config: ReaderConfig,
  dependencies: ReaderPipelineDependencies,
): ReaderMode {
  return dependencies.modeSource?.() ?? config.mode;
}

async function abortableSleep(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return;
  await new Promise<void>((resolve) => {
    const timer = setTimeout(done, milliseconds);
    function done() {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    }
    signal.addEventListener("abort", done, { once: true });
  });
}

export async function runReaderService(
  config: ReaderConfig,
  dependencies: ReaderPipelineDependencies,
  runtime: {
    signal: AbortSignal;
    tick?: Tick;
    sleep?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
  },
): Promise<ReaderServiceReport> {
  const startingMode = currentMode(config, dependencies);
  const result: ReaderServiceReport = {
    mode: startingMode,
    ticks: 0,
    claimed: 0,
  };
  if (startingMode === "off" || runtime.signal.aborted) return result;

  const tick = runtime.tick ?? runReaderTick;
  if (startingMode === "dry_run") {
    const report = await tick(config, dependencies);
    result.ticks = 1;
    result.claimed = report.claimed;
    dependencies.logger?.info("reader_dry_run_result", { report });
    return result;
  }

  const sleep = runtime.sleep ?? abortableSleep;
  while (!runtime.signal.aborted && currentMode(config, dependencies) === "apply") {
    const report = await tick(config, dependencies);
    result.ticks += 1;
    result.claimed += report.claimed;
    if (report.claimed === 0) await sleep(config.pollMs, runtime.signal);
  }
  return result;
}
