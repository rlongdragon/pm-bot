/**
 * 自己管 Xvfb，不用 xvfb-run：xvfb-run 是 shell 包一層，SIGTERM 打到它時裡面的程式不會跟著收，
 * 錄音程序會變孤兒繼續待在會議裡。這裡起一個 Xvfb、把 DISPLAY 交給呼叫端，結束時由呼叫端 kill。
 */
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

export function hasXvfb(): boolean {
  return (process.env.PATH ?? "").split(":").some((d) => fs.existsSync(path.join(d, "Xvfb")));
}

export interface Xvfb {
  proc: ChildProcess;
  display: string;
  stop(): void;
}

/** 起一個 Xvfb。-displayfd 3 讓它自己挑沒用的 display 號碼，寫到 fd 3 */
export function startXvfb(width = 1280, height = 800): Promise<Xvfb> {
  return new Promise((resolve, reject) => {
    const proc = spawn("Xvfb", ["-displayfd", "3", "-screen", "0", `${width}x${height}x24`, "-nolisten", "tcp"], {
      stdio: ["ignore", "ignore", "ignore", "pipe"],
    });
    let buf = "";
    let done = false;
    const stop = () => {
      if (proc.exitCode === null) proc.kill("SIGTERM");
    };
    proc.stdio[3]!.on("data", (d: Buffer) => {
      buf += d.toString();
      const m = buf.match(/(\d+)\n/);
      if (m && !done) {
        done = true;
        resolve({ proc, display: `:${m[1]}`, stop });
      }
    });
    proc.on("exit", (c) => {
      if (!done) {
        done = true;
        reject(new Error(`Xvfb 起不來（exit ${c}）。apt install xvfb`));
      }
    });
    proc.on("error", (e) => {
      if (!done) {
        done = true;
        reject(e);
      }
    });
    setTimeout(() => {
      if (!done) {
        done = true;
        stop();
        reject(new Error("Xvfb 10 秒內沒回 display 號碼"));
      }
    }, 10_000);
  });
}
