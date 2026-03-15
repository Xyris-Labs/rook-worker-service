export class CliManager {
  private process: any;
  private decoder = new TextDecoder();
  public exited!: Promise<number>;

  constructor(
    private command: string[],
    private onOutput: (data: string) => void,
    private env?: Record<string, string>
  ) {}

  start() {
    this.process = Bun.spawn(this.command, {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, ...this.env },
    });

    this.exited = this.process.exited;
    this.readStream(this.process.stdout);
    this.readStream(this.process.stderr);
  }

  private async readStream(stream: ReadableStream) {
    const reader = stream.getReader();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        this.onOutput(this.decoder.decode(value));
      }
    } catch (err) {
      // Stream closed or error
    } finally {
      reader.releaseLock();
    }
  }

  write(payload: string) {
    if (this.process?.stdin) {
      this.process.stdin.write(payload + "\n");
      this.process.stdin.flush();
    }
  }

  kill() {
    this.process?.kill();
  }
}
