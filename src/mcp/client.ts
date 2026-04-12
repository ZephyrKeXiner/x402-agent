import { ChildProcess, spawn } from "child_process";
import { Interface, createInterface } from "readline";

const MCP_REQUEST_TIMEOUT = 30_000;

export class McpClient {
  private process: ChildProcess;
  private rl: Interface;
  private nextId = 1;
  private pending = new Map<number, { resolve: (result: any) => void; reject: (err: Error) => void }>();

  constructor(command: string, args: string[]) {
    this.process = spawn(command, args, {
      stdio: ["pipe", "pipe", "pipe"],
    });

    this.rl = createInterface({ input: this.process.stdout! });
    this.rl.on("line", (line) => {
      const msg = JSON.parse(line);
      const entry = this.pending.get(msg.id);
      if (entry) {
        this.pending.delete(msg.id);
        if (msg.error) {
          entry.reject(new Error(msg.error.message || JSON.stringify(msg.error)));
        } else {
          entry.resolve(msg.result);
        }
      }
    });
  }

  request(method: string, params?: any, timeoutMs: number = MCP_REQUEST_TIMEOUT): Promise<any> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`MCP request "${method}" timed out after ${timeoutMs}ms`));
      }, timeoutMs);

      this.pending.set(id, {
        resolve: (result) => { clearTimeout(timer); resolve(result); },
        reject: (err) => { clearTimeout(timer); reject(err); },
      });

      const msg = JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n";
      this.process.stdin!.write(msg);
    });
  }

  async connect(): Promise<void> {
    await this.request("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "coda", version: "1.0.0" },
    });
    this.process.stdin!.write(
      JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) +
        "\n",
    );
  }

  async listTools(): Promise<any[]> {
    const result = await this.request("tools/list", {});
    return result.tools;
  }

  async callTool(name: string, args: Record<string, any>): Promise<any> {
    return await this.request("tools/call", { name, arguments: args });
  }
}
