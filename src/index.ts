import { connect, JSONCodec, StringCodec, type NatsConnection } from "nats";
import { CliManager } from "./processManager.ts";

const NATS_URL = process.env.NATS_URL || "nats://host.docker.internal:4222";

async function bootstrap() {
  let nc: NatsConnection;
  let cliManager: CliManager | null = null;

  try {
    nc = await connect({ servers: NATS_URL });
    console.log(`Connected to NATS at ${nc.getServer()}`);

    const jc = JSONCodec();
    const sc = StringCodec();

    const handshakePayload = {
      type: "service.worker.codex",
      name: `worker-${Math.random().toString(36).substring(7)}`,
    };

    const response = await nc.request(
      "registry.handshake",
      jc.encode(handshakePayload),
      { timeout: 10000 }
    );

    const { uuid } = jc.decode(response.data) as {
      uuid: string;
    };

    console.log(`Registration successful. ServiceID: ${uuid}`);

    nc.subscribe(`worker.${uuid}.stdin`, {
      callback: (err, msg) => {
        if (err) {
          console.error("Error receiving NATS message for stdin:", err);
          return;
        }
        cliManager?.write(sc.decode(msg.data));
      },
    });

    nc.subscribe(`worker.${uuid}.control`, {
      callback: (err, msg) => {
        if (err) {
          console.error("Error receiving NATS message for control:", err);
          return;
        }
        try {
          const payload = jc.decode(msg.data) as { action: string; command: string[] };
          if (payload.action === "start" && payload.command) {
            console.log(`Starting process: ${payload.command.join(" ")}`);
            cliManager = new CliManager(payload.command, (data: string) => {
              nc.publish(`worker.${uuid}.stdout`, sc.encode(data));
            });
            cliManager.start();
          }
        } catch (e) {
          console.error("Failed to parse control message:", e);
        }
      },
    });

    const handleShutdown = async () => {
      console.log("Gracefully shutting down...");
      cliManager?.kill();
      await nc.drain();
      process.exit(0);
    };

    process.on("SIGINT", handleShutdown);
    process.on("SIGTERM", handleShutdown);

  } catch (error) {
    console.error("Failed to connect or register:", error instanceof Error ? error.message : error);
    process.exit(1);
  }
}

bootstrap();
