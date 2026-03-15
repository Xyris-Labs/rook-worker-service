import { connect, JSONCodec, StringCodec, type NatsConnection } from "nats";
import { CliManager } from "./processManager.ts";
import * as fs from "node:fs";
import * as path from "node:path";

const NATS_URL = process.env.NATS_URL || "nats://host.docker.internal:4222";

interface StartPayload {
  action: "start";
  processId: string;
  command: string[];
  env?: Record<string, string>;
  files?: { path: string; content: string }[];
}

async function bootstrap() {
  let nc: NatsConnection;
  const processes = new Map<string, CliManager>();

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

    nc.subscribe(`worker.${uuid}.control`, {
      callback: (err, msg) => {
        if (err) {
          console.error("Error receiving NATS message for control:", err);
          return;
        }
        try {
          const payload = jc.decode(msg.data) as StartPayload;
          if (payload.action === "start" && payload.processId && payload.command) {
            if (processes.has(payload.processId)) {
              console.error(`Process already exists: ${payload.processId}`);
              return;
            }

            console.log(`Starting isolated process: ${payload.processId} -> ${payload.command.join(" ")}`);

            // Inject files
            if (payload.files) {
              for (const file of payload.files) {
                const dir = path.dirname(file.path);
                fs.mkdirSync(dir, { recursive: true });
                fs.writeFileSync(file.path, file.content);
              }
            }

            const cliManager = new CliManager(
              payload.command,
              (data: string) => {
                nc.publish(`worker.${uuid}.${payload.processId}.stdout`, sc.encode(data));
              },
              payload.env
            );

            processes.set(payload.processId, cliManager);
            cliManager.start();

            // Subscribe to stdin for this process
            nc.subscribe(`worker.${uuid}.${payload.processId}.stdin`, {
              callback: (err, stdinMsg) => {
                if (err) {
                  console.error(`Error on stdin for ${payload.processId}:`, err);
                  return;
                }
                processes.get(payload.processId)?.write(sc.decode(stdinMsg.data));
              }
            });
          }
        } catch (e) {
          console.error("Failed to parse control message:", e);
        }
      },
    });

    const handleShutdown = async () => {
      console.log("Gracefully shutting down...");
      for (const [id, manager] of processes) {
        console.log(`Killing process ${id}...`);
        manager.kill();
      }
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
