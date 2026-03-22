import { connect, JSONCodec, StringCodec, type NatsConnection } from "nats";
import { CliManager } from "../processManager.ts";

const NATS_URL = process.env.NATS_URL || "nats://host.docker.internal:4222";
const jc = JSONCodec();
const sc = StringCodec();

export class CodexAdapter {
  private cli: CliManager;
  public exited: Promise<number>;
  private nc!: NatsConnection;
  private agentUuid!: string;
  private heartbeatTimer?: any;
  private activeThreadId: string | null = null;
  private outboxBuffer: string[] = [];
  private readonly BUFFER_LIMIT = 50;

  public getAgentUuid() { return this.agentUuid; }

  constructor(
    private command: string[],
    private onOutput: (data: string) => void,
    private env?: Record<string, string>
  ) {
    // Initialize CLI without starting it yet
    this.cli = new CliManager(command, (data) => this.handleOutput(data), env);
    this.exited = this.cli.exited;
  }

  async start() {
    try {
      // 1. Establish Sovereign NATS Connection
      this.nc = await connect({ servers: NATS_URL });
      console.log(`[Agent] Connected to NATS at ${this.nc.getServer()}`);

      // 2. Autonomous Handshake
      const handshakePayload = {
        type: "agent.rook",
        name: `jerry-${Math.random().toString(36).substring(7)}`
      };

      const response = await this.nc.request(
        "registry.handshake",
        jc.encode(handshakePayload),
        { timeout: 10000 }
      );

      const { uuid } = jc.decode(response.data) as { uuid: string };
      this.agentUuid = uuid;
      console.log(`[Agent] Sovereign Identity Established. AgentID: ${this.agentUuid}`);
      
      // Initiate Sovereign Heartbeat
      this.heartbeatTimer = setInterval(() => {
        this.nc.publish("registry.heartbeat", jc.encode({ 
          key: `${handshakePayload.type}.${handshakePayload.name}`, 
          uuid: this.agentUuid 
        }));
      }, 15000);

      this.onOutput(`[SYSTEM_EVENT:AGENT_ONLINE:${this.agentUuid}]\n`);

      // 3. Setup Dedicated JSON-RPC Inbox
      this.nc.subscribe(`agent.${this.agentUuid}.inbox`, {
        callback: (err, msg) => {
          if (err) return;
          const rpcPayload = sc.decode(msg.data);
          
          // Thread State Sniffing (Inbound)
          try {
            const payload = JSON.parse(rpcPayload);
            if (payload.method === "turn/start" && payload.params?.threadId) {
              this.activeThreadId = payload.params.threadId;
            }
          } catch (e) {}

          // Pipe directly to the language server's stdin
          this.cli.write(rpcPayload); 
        }
      });

      // State Request Listener
      this.nc.subscribe(`agent.${this.agentUuid}.request_state`, {
        callback: (err, msg) => {
          this.nc.publish(`agent.${this.agentUuid}.state_reply`, jc.encode({
            threadId: this.activeThreadId,
            history: this.outboxBuffer
          }));
        }
      });

      // 4. Start the actual process
      this.cli.start();

      // 5. Fire JSON-RPC Initialization Handshake
      setTimeout(() => {
        const initPayload = JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: {
            clientInfo: { name: "xyris-mesh", version: "1.0.0" },
            capabilities: {}
          }
        });
        this.cli.write(initPayload);

        setTimeout(() => {
           this.cli.write(JSON.stringify({ jsonrpc: "2.0", method: "initialized", params: {} }));
        }, 500);
      }, 1000);

    } catch (err) {
      console.error("[Agent] Failed to establish autonomy:", err);
    }
  }

  private handleOutput(data: string) {
    // Rolling Outbox Buffer
    this.outboxBuffer.push(data);
    if (this.outboxBuffer.length > this.BUFFER_LIMIT) {
      this.outboxBuffer.shift();
    }

    if (this.nc && this.agentUuid) {
      // Thread State Sniffing (Outbound)
      try {
        const payload = JSON.parse(data);
        if (payload.id === 2 && payload.result?.thread?.id) {
          this.activeThreadId = payload.result.thread.id;
        }
      } catch (e) {}

      // Smart routing: Sovereign JSON-RPC outbox
      this.nc.publish(`agent.${this.agentUuid}.outbox`, sc.encode(data));
    } else {
      // Legacy routing: Only used before identity is established
      this.onOutput(data);
    }
  }

  write(payload: string) {
    // Legacy sidecar passthrough (mostly bypassed now)
    this.cli.write(payload);
  }

  async kill() {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
    }
    this.cli.kill();
    if (this.nc) {
      await this.nc.drain();
    }
  }
}
