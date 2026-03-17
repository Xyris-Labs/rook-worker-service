import { connect, JSONCodec, StringCodec } from "nats";
import { CliManager } from "./processManager.ts";
import { CodexAdapter } from "./adapters/codex.ts";
import * as fs from "fs";
import * as path from "path";

const NATS_URL = process.env.NATS_URL || "nats://host.docker.internal:4222";
const jc = JSONCodec();
const sc = StringCodec();

const activeProcesses = new Map<string, CliManager | CodexAdapter>();

async function main() {
  const nc = await connect({ servers: NATS_URL });
  console.log(`[Worker] Connected to NATS at ${nc.getServer()}`);

  // Initialize Librarian KV Store
  const js = nc.jetstream();
  const kv = await js.views.kv("librarian_profiles").catch(async () => {
     return await js.views.kv("librarian_profiles", { history: 1 });
  }).catch((e) => {
     console.log("[Librarian] KV Store not available yet. Proceeding without profiles.");
     return null;
  });

  const handshakePayload = {
    type: "service.worker.rook",
    name: `worker-${Math.random().toString(36).substring(7)}`,
  };

  const response = await nc.request("registry.handshake", jc.encode(handshakePayload), { timeout: 10000 });
  const { uuid } = jc.decode(response.data) as { uuid: string };
  console.log(`[Worker] Registration successful. ManagerID: ${uuid}`);

  // 1. STATUS ENDPOINT (Control Plane)
  nc.subscribe(`worker.${uuid}.status`, {
    callback: (err, msg) => {
      if (err) return;
      const status = {
        workerId: uuid,
        processes: Array.from(activeProcesses.entries()).map(([pid, instance]) => ({
          processId: pid,
          type: instance instanceof CodexAdapter ? 'agent' : 'cli',
          agentUuid: instance instanceof CodexAdapter ? instance.getAgentUuid() : null
        }))
      };
      if (msg.reply) msg.respond(jc.encode(status));
    },
  });

  // Serve the UI bundle
  nc.subscribe(`worker.${uuid}.get_ui`, {
    callback: (err, msg) => {
      if (err) return;
      const uiBundlePath = path.join(process.cwd(), "dist", "CodexPlugin.js");
      const uiBundle = fs.existsSync(uiBundlePath) ? fs.readFileSync(uiBundlePath, "utf-8") : "/* UI bundle not found */";
      msg.respond(sc.encode(uiBundle));
    }
  });

  // 2. CONTROL ENDPOINT (Execution & Provisioning)
  nc.subscribe(`worker.${uuid}.control`, {
    callback: async (err, msg) => {
      if (err) return;
      const payload = jc.decode(msg.data) as any;
      console.log(`[Control] Received action: ${payload.action} for ${payload.processId}`);

      if (payload.action === "start") {
        if (activeProcesses.has(payload.processId)) {
           console.log(`[Control] Process ${payload.processId} is already running.`);
           return;
        }

        // 3. LIBRARIAN PROFILE INJECTION
        if (payload.profileId && kv) {
           try {
             const profileEntry = await kv.get(payload.profileId);
             if (profileEntry) {
               const codexDir = "/root/.codex";
               if (!fs.existsSync(codexDir)) fs.mkdirSync(codexDir, { recursive: true });

               // Seed the filesystem before process boot
               fs.writeFileSync(path.join(codexDir, "config.json"), profileEntry.value);
               console.log(`[Librarian] Injected profile ${payload.profileId} into workspace.`);
             }
           } catch(e) {
             console.error(`[Librarian] Failed to load profile:`, e);
           }
        }

        let instance;
        const onOutput = (data: string) => {
          nc.publish(`worker.${uuid}.${payload.processId}.stdout`, sc.encode(data));
        };

        if (payload.command && payload.command[1] === "app-server") {
          instance = new CodexAdapter(payload.command, onOutput, process.env);
        } else if (payload.authFlow) {
          instance = new CliManager(payload.authFlow.loginCommand, onOutput, process.env);
          // Future: Catch auth success here and push new config.json to Librarian KV
        } else {
          instance = new CliManager(payload.command, onOutput, process.env);
        }

        activeProcesses.set(payload.processId, instance);

        const sub = nc.subscribe(`worker.${uuid}.${payload.processId}.stdin`, {
          callback: (err, stdMsg) => {
            if (err || !activeProcesses.has(payload.processId)) return;
            instance.write(sc.decode(stdMsg.data) + "\n");
          }
        });

        instance.start();

        instance.exited.then((code: number) => {
          console.log(`[Process] ${payload.processId} exited with code ${code}`);
          activeProcesses.delete(payload.processId);
          sub.unsubscribe();
        });
      }

      if (payload.action === "stop") {
        const instance = activeProcesses.get(payload.processId);
        if (instance) {
          instance.kill();
          activeProcesses.delete(payload.processId);
        }
      }
    },
  });
}

main().catch(console.error);
