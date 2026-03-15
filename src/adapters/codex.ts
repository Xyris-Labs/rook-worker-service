import { CliManager } from "../processManager.ts";

export class CodexAdapter {
  private cli: CliManager;
  public exited: Promise<number>;

  constructor(
    private command: string[],
    private onOutput: (data: string) => void,
    private env?: Record<string, string>
  ) {
    this.cli = new CliManager(command, (data) => this.handleOutput(data), env);
    this.exited = this.cli.exited;
  }

  start() {
    this.cli.start();
    // Automatically fire the JSON-RPC initialization handshake after boot
    setTimeout(() => {
      const initPayload = JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {}
      });
      this.cli.write(initPayload);
    }, 1000);
  }

  private handleOutput(data: string) {
    // Future: Translate JSON-RPC responses to standard MCP here.
    // For now, pass through.
    this.onOutput(data);
  }

  write(payload: string) {
    this.cli.write(payload);
  }

  kill() {
    this.cli.kill();
  }
}
