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

  const registryKey = `${handshakePayload.type}.${handshakePayload.name}`;
  const response = await nc.request("registry.handshake", jc.encode(handshakePayload), { timeout: 10000 });
  const { uuid } = jc.decode(response.data) as { uuid: string };
  console.log(`[Worker] Registration successful. ManagerID: ${uuid}`);

  // Restore liveness heartbeat so the Hub doesn't drop the worker
  setInterval(() => {
    nc.publish("registry.heartbeat", jc.encode({ key: registryKey, uuid }));
  }, 15000);

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

      // Extract base workspace ID (strip 'auth-' prefix if present)
      const wsId = payload.processId.replace("auth-", "");
      const wsDir = path.join("/workspace", wsId);
      const codexDir = path.join(wsDir, ".codex");

      // Create isolated physical directory for this workspace AND the .codex folder
      if (!fs.existsSync(codexDir)) {
        fs.mkdirSync(codexDir, { recursive: true });
      }

      // Force the process to use this isolated directory as its home
      const isolatedEnv = { 
        ...process.env, 
        HOME: wsDir,
        CODEX_HOME: codexDir 
      };

      if (payload.profileId && kv) {
         try {
           const profileEntry = await kv.get(payload.profileId);
           if (profileEntry) {
             fs.writeFileSync(path.join(codexDir, "auth.json"), profileEntry.value);
             console.log(`[Librarian] Injected profile ${payload.profileId} into ${wsDir}`);
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
        instance = new CodexAdapter(payload.command, onOutput, isolatedEnv);
      } else if (payload.authFlow) {
        instance = new CliManager(payload.authFlow.loginCommand, onOutput, isolatedEnv);
      } else {
        instance = new CliManager(payload.command, onOutput, isolatedEnv);
      }

        activeProcesses.set(payload.processId, instance);

        const sub = nc.subscribe(`worker.${uuid}.${payload.processId}.stdin`, {
          callback: (err, stdMsg) => {
            if (err || !activeProcesses.has(payload.processId)) return;
            instance.write(sc.decode(stdMsg.data) + "\n");
          }
        });

        // Await the boot sequence to prevent race conditions on the exited promise
        await instance.start();

        if (instance.exited) {
          instance.exited.then((code: number) => {
            console.log(`[Process] ${payload.processId} exited with code ${code}`);
            activeProcesses.delete(payload.processId);
            sub.unsubscribe();
          }).catch(() => {
            activeProcesses.delete(payload.processId);
            sub.unsubscribe();
          });
        }
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
