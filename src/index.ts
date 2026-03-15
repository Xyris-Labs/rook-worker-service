import { connect, JSONCodec, StringCodec, type NatsConnection } from "nats";
import { CliManager } from "./processManager.ts";
import { CodexAdapter } from "./adapters/codex.ts";
import * as fs from "node:fs";
import * as path from "node:path";

const NATS_URL = process.env.NATS_URL || "nats://host.docker.internal:4222";

interface StartPayload {
  action: "start";
  processId: string;
  command: string[];
  env?: Record<string, string>;
  files?: { path: string; content: string }[];
  authFlow?: {
    loginCommand: string[];
    targetFile: string;
    runCommand: string[];
  };
}

async function bootstrap() {
  let nc: NatsConnection;
  const processes = new Map<string, CliManager | CodexAdapter>();

  // Load the bundled UI into memory
  const uiBundlePath = path.join(process.cwd(), "dist", "CodexPlugin.js");
  const uiBundle = fs.existsSync(uiBundlePath) ? fs.readFileSync(uiBundlePath, "utf-8") : "/* UI bundle not found */";

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

    // Serve the UI bundle
    nc.subscribe(`worker.${uuid}.get_ui`, {
      callback: (err, msg) => {
        if (err) return;
        msg.respond(sc.encode(uiBundle));
      }
    });

    nc.subscribe(`worker.${uuid}.control`, {
      callback: async (err, msg) => {
        if (err) {
          console.error("Error receiving NATS message for control:", err);
          return;
        }
        try {
          const payload = jc.decode(msg.data) as StartPayload;
          if (payload.action === "start" && payload.processId) {
            if (processes.has(payload.processId)) {
              console.error(`Process already exists: ${payload.processId}`);
              return;
            }

            // Provisioning / Auth Flow
            if (payload.authFlow && (!payload.files || payload.files.length === 0)) {
              console.log("Initiating autonomous provisioning flow...");

              if (payload.env && payload.env.CODEX_HOME) {
                 fs.mkdirSync(payload.env.CODEX_HOME, { recursive: true });
              }

              const provisioner = new CliManager(
                payload.authFlow.loginCommand,
                (data: string) => {
                  process.stdout.write(data);
                  nc.publish(`worker.${uuid}.${payload.processId}.stdout`, sc.encode(data));
                },
                payload.env
              );

              provisioner.start();
              await provisioner.exited;

              if (fs.existsSync(payload.authFlow.targetFile)) {
                const newProfile = fs.readFileSync(payload.authFlow.targetFile, "utf-8");
                nc.publish(`worker.${uuid}.${payload.processId}.profile_generated`, sc.encode(newProfile));
                console.log("Provisioning complete, pivoting to execution mode...");
                payload.command = payload.authFlow.runCommand;
              } else {
                console.error(`Provisioning failed: target file ${payload.authFlow.targetFile} not found.`);
                return;
              }
            }

            if (!payload.command) {
              console.error(`No command provided for process ${payload.processId}`);
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

            let activeProcess: CliManager | CodexAdapter;
            if (payload.command[0] === "codex" && payload.command[1] === "app-server") {
              activeProcess = new CodexAdapter(
                payload.command,
                (data: string) => {
                  process.stdout.write(data);
                  nc.publish(`worker.${uuid}.${payload.processId}.stdout`, sc.encode(data));
                },
                payload.env
              );
            } else {
              activeProcess = new CliManager(
                payload.command,
                (data: string) => {
                  process.stdout.write(data);
                  nc.publish(`worker.${uuid}.${payload.processId}.stdout`, sc.encode(data));
                },
                payload.env
              );
            }

            processes.set(payload.processId, activeProcess);
            activeProcess.start();

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
          console.error("Failed to parse or process control message:", e);
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
