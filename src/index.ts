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
  status: 'created' | 'running' | 'stopped';
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
    type: "service.workspace.manager",
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
    callback: (err, msg) => {
      if (msg.reply) msg.respond(jc.encode(Array.from(workspaces.values())));
    }
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
        const wsDir = path.join("/workspace", wsId);
        const codexDir = path.join(wsDir, ".codex");
        if (!fs.existsSync(codexDir)) fs.mkdirSync(codexDir, { recursive: true });

        if (payload.profileId && kv) {
           try {
             const profile = await kv.get(payload.profileId);
             if (profile) {
               fs.writeFileSync(path.join(codexDir, "auth.json"), profile.value);
               console.log(`[Librarian] Seeded auth.json for ${wsId}`);
             }
           } catch(e) { console.error(e); }
        }

        workspaces.set(wsId, { id: wsId, name: payload.name, engine: payload.engine, status: 'created' });
        broadcastState();
      }

      if (payload.action === "start") {
        if (activeProcesses.has(wsId)) return;
        const wsDir = path.join("/workspace", wsId);
        const env = { ...process.env, HOME: wsDir, CODEX_HOME: path.join(wsDir, ".codex") };

        const onOutput = (data: string) => nc.publish(`worker.${uuid}.${wsId}.stdout`, sc.encode(data));
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
