import { connect, JSONCodec, StringCodec } from "nats";
import { CliManager } from "./processManager.ts";
import { CodexAdapter } from "./adapters/codex.ts";
import * as fs from "fs";
import * as path from "path";

const NATS_URL = process.env.NATS_URL || "nats://host.docker.internal:4222";
const jc = JSONCodec();
const sc = StringCodec();

interface Workspace {
  id: string;
  name: string;
  engine: string;
  status: 'created' | 'provisioning' | 'running' | 'stopped';
  agentUuid?: string;
}

const workspaces = new Map<string, Workspace>();
const activeProcesses = new Map<string, CliManager | CodexAdapter>();

async function main() {
  const nc = await connect({ servers: NATS_URL });
  console.log(`[Manager] Connected to NATS at ${nc.getServer()}`);

  const js = nc.jetstream();
  const kv = await js.views.kv("librarian_profiles").catch(async () => {
     return await js.views.kv("librarian_profiles", { history: 1 });
  }).catch(() => null);

  const handshakePayload = {
    type: "service.worker.manager",
    name: `manager-${Math.random().toString(36).substring(7)}`,
  };
  const registryKey = `${handshakePayload.type}.${handshakePayload.name}`;

  const response = await nc.request("registry.handshake", jc.encode(handshakePayload), { timeout: 10000 });
  const { uuid } = jc.decode(response.data) as { uuid: string };
  console.log(`[Manager] Registration successful. ManagerID: ${uuid}`);

  setInterval(() => nc.publish("registry.heartbeat", jc.encode({ key: registryKey, uuid })), 15000);

  const broadcastState = () => {
    nc.publish(`worker.${uuid}.state`, jc.encode(Array.from(workspaces.values())));
  };

  // Initial state request for when UI first connects
  nc.subscribe(`worker.${uuid}.request_state`, {
    callback: () => broadcastState()
  });

  nc.subscribe(`worker.${uuid}.get_ui`, {
    callback: (err, msg) => {
      if (err) return;
      const uiPath = path.join(process.cwd(), "dist", "CodexPlugin.js");
      msg.respond(sc.encode(fs.existsSync(uiPath) ? fs.readFileSync(uiPath, "utf-8") : "/* UI not found */"));
    }
  });

  nc.subscribe(`worker.${uuid}.control`, {
    callback: async (err, msg) => {
      if (err) return;
      const payload = jc.decode(msg.data) as any;
      const wsId = payload.workspaceId;
      console.log(`[Control] Action: ${payload.action} on ${wsId}`);

      if (payload.action === "create") {
        // Immediately set status to provisioning and broadcast
        const ws: Workspace = { id: wsId, name: payload.name, engine: payload.engine, status: 'provisioning' };
        workspaces.set(wsId, ws);
        broadcastState();

        const wsDir = path.join("/workspace", wsId);
        const codexDir = path.join(wsDir, ".codex");
        const sshDir = path.join(wsDir, ".ssh");

        try {
          if (!fs.existsSync(codexDir)) fs.mkdirSync(codexDir, { recursive: true });
          if (!fs.existsSync(sshDir)) fs.mkdirSync(sshDir, { recursive: true });

          // 1. LIBRARIAN PROFILE INJECTION (App Auth)
          if (payload.profileId && kv) {
             try {
               const profile = await kv.get(payload.profileId);
               if (profile) {
                 fs.writeFileSync(path.join(codexDir, "auth.json"), profile.value);
                 console.log(`[Librarian] Seeded auth.json for ${wsId}`);
               }
             } catch(e) { console.error(`[Librarian] App profile failed:`, e); }
          }

          // 2. SSH KEY INJECTION (Git Auth)
          if (payload.gitProfileId && kv) {
            try {
              const gitProfile = await kv.get(payload.gitProfileId);
              if (gitProfile) {
                const keyPath = path.join(sshDir, "id_rsa");
                fs.writeFileSync(keyPath, gitProfile.value);
                fs.chmodSync(keyPath, 0o600);
                console.log(`[Librarian] Injected SSH key for ${wsId}`);
              }
            } catch(e) { console.error(`[Librarian] Git profile failed:`, e); }
          }

          // 3. SECURE CLONE
          if (payload.repoUrl) {
            console.log(`[Provisioning] Cloning ${payload.repoUrl} into ${wsDir}...`);
            const keyPath = path.join(sshDir, "id_rsa");
            const hasKey = fs.existsSync(keyPath);
            
            const cloneProcess = Bun.spawn(["git", "clone", payload.repoUrl, "."], {
              cwd: wsDir,
              env: {
                ...process.env,
                GIT_SSH_COMMAND: hasKey 
                  ? `ssh -i ${keyPath} -o StrictHostKeyChecking=no` 
                  : "ssh -o StrictHostKeyChecking=no"
              }
            });
            
            const exitCode = await cloneProcess.exited;
            if (exitCode !== 0) {
              console.error(`[Provisioning] Clone failed with code ${exitCode}`);
            } else {
              console.log(`[Provisioning] Clone successful.`);
            }
          }

        } catch (e) {
          console.error(`[Provisioning] Fatal error during workspace setup:`, e);
        } finally {
          // Finalize state
          ws.status = 'stopped';
          broadcastState();
        }
      }

      if (payload.action === "start") {
        if (activeProcesses.has(wsId)) return;
        const wsDir = path.join("/workspace", wsId);
        const env = { ...process.env, HOME: wsDir, CODEX_HOME: path.join(wsDir, ".codex") };

        const onOutput = (data: string) => {
          nc.publish(`worker.${uuid}.${wsId}.stdout`, sc.encode(data));

          // Intercept agent identity natively and push to UI
          const match = data.match(/\[SYSTEM_EVENT:AGENT_ONLINE:(.+)\]/);
          if (match) {
            const wsData = workspaces.get(wsId);
            if (wsData) {
              wsData.agentUuid = match[1];
              broadcastState();
            }
          }
        };
        const instance = new CodexAdapter(['codex', 'app-server'], onOutput, env);
        activeProcesses.set(wsId, instance);

        const wsData = workspaces.get(wsId);
        if (wsData) {
          wsData.status = 'running';
          wsData.agentUuid = instance.getAgentUuid(); // Wait, this is sync, UUID isn't populated until handshake. We will catch it via stdout intercept below.
          broadcastState();
        }

        const sub = nc.subscribe(`worker.${uuid}.${wsId}.stdin`, {
          callback: (err, stdMsg) => {
            if (!err && activeProcesses.has(wsId)) instance.write(sc.decode(stdMsg.data) + "\n");
          }
        });

        await instance.start();

        if (instance.exited) {
          instance.exited.then(() => {
            activeProcesses.delete(wsId);
            sub.unsubscribe();
            if (workspaces.has(wsId)) workspaces.get(wsId)!.status = 'stopped';
            broadcastState();
          }).catch(() => {
            activeProcesses.delete(wsId);
            sub.unsubscribe();
            if (workspaces.has(wsId)) workspaces.get(wsId)!.status = 'stopped';
            broadcastState();
          });
        }
      }

      if (payload.action === "stop") {
        const instance = activeProcesses.get(wsId);
        if (instance) {
          instance.kill();
          activeProcesses.delete(wsId);
          if (workspaces.has(wsId)) workspaces.get(wsId)!.status = 'stopped';
          broadcastState();
        }
      }

      if (payload.action === "delete") {
        const instance = activeProcesses.get(wsId);
        if (instance) instance.kill();
        activeProcesses.delete(wsId);
        workspaces.delete(wsId);
        fs.rmSync(path.join("/workspace", wsId), { recursive: true, force: true });
        broadcastState();
      }
    }
  });
}

main().catch(console.error);
