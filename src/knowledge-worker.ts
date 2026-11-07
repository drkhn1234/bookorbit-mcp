import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

/** One serialized, restartable process retains the CPU embedding model. */
export class KnowledgeWorker {
  constructor(private readonly timeoutMs = 300_000) {}
  private child?: ChildProcessWithoutNullStreams;
  private queue: Promise<unknown> = Promise.resolve();
  private pending?: { resolve: (value: any) => void; reject: (error: Error) => void };

  request<T = any>(data: unknown): Promise<T> {
    const operation = this.queue.catch(() => {}).then(() => this.execute<T>(data));
    this.queue = operation;
    return operation;
  }

  private execute<T>(data: unknown): Promise<T> {
    if (!this.child) {
      const child = spawn(
        process.env.KNOWLEDGE_PYTHON ?? "python3",
        [fileURLToPath(new URL("../knowledge/worker.py", import.meta.url))],
        { stdio: "pipe" },
      );
      this.child = child;
      createInterface({ input: child.stderr }).on("line", (line) => {
        if (/^\[Knowledge\] indexing book=\d+ passages=\d+$/.test(line))
          console.error(line);
      });
      createInterface({ input: child.stdout }).on("line", (line) => {
        if (this.child !== child) return;
        try {
          const response = JSON.parse(line);
          const pending = this.pending;
          this.pending = undefined;
          if (response.error) pending?.reject(new Error(response.error));
          else pending?.resolve(response.result);
        } catch {
          this.pending?.reject(new Error("Invalid knowledge worker response"));
        }
      });
      const died = () => {
        if (this.child !== child) return;
        this.child = undefined;
        this.pending?.reject(new Error("Knowledge worker stopped; retry the operation"));
        this.pending = undefined;
      };
      child.once("error", died);
      child.once("exit", died);
    }
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.child?.kill("SIGKILL");
        this.child = undefined;
        this.pending = undefined;
        reject(
          new Error(
            "Knowledge operation timed out; completed index batches are retained. Retry or inspect job status.",
          ),
        );
      }, this.timeoutMs);
      this.pending = {
        resolve: (v) => {
          clearTimeout(timer);
          resolve(v);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      };
      this.child!.stdin.write(JSON.stringify(data) + "\n", (error) => {
        if (error) this.pending?.reject(error);
      });
    });
  }

  close(): void {
    this.child?.kill();
  }
}
export const knowledgeWorker = new KnowledgeWorker();

/** Long-running indexing is isolated from interactive query/extraction requests. */
export const indexingWorker = new KnowledgeWorker(3_600_000);
