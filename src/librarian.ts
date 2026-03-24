import { connect, JSONCodec, StringCodec, type NatsConnection } from "nats";

const NATS_URL = process.env.NATS_URL || "nats://host.docker.internal:4222";
const jc = JSONCodec();
const sc = StringCodec();

export async function startLibrarian() {
  const nc = await connect({ servers: NATS_URL });
  console.log(`[Librarian] Connected to NATS at ${nc.getServer()}`);

  const js = nc.jetstream();
  const kv = await js.views.kv("librarian_profiles", { history: 1 }).catch(async () => {
    return await js.views.kv("librarian_profiles", { history: 1 });
  });

  // LIVE TELEMETRY STREAM
  (async () => {
    const watcher = await kv.watch();
    for await (const entry of watcher) {
      const key = entry.key;
      const op = entry.operation;
      const val = entry.value ? sc.decode(entry.value) : null;
      nc.publish("librarian.telemetry", jc.encode({ key, op, value: val }));
    }
  })().catch(console.error);

  // 1. GET LISTENER
  nc.subscribe("librarian.profile.get", {
    callback: async (err, msg) => {
      if (err) return;
      try {
        const { key } = jc.decode(msg.data) as { key: string };
        const entry = await kv.get(key);
        msg.respond(jc.encode({ key, value: entry ? sc.decode(entry.value) : null }));
      } catch (e) {
        msg.respond(jc.encode({ error: "Failed to fetch profile" }));
      }
    }
  });

  // 2. PUT LISTENER
  nc.subscribe("librarian.profile.put", {
    callback: async (err, msg) => {
      if (err) return;
      try {
        const { key, value } = jc.decode(msg.data) as { key: string, value: string };
        await kv.put(key, sc.encode(value));
        msg.respond(jc.encode({ success: true }));
      } catch (e) {
        msg.respond(jc.encode({ error: "Failed to store profile" }));
      }
    }
  });

  // 3. DELETE LISTENER
  nc.subscribe("librarian.profile.delete", {
    callback: async (err, msg) => {
      if (err) return;
      try {
        const { key } = jc.decode(msg.data) as { key: string };
        await kv.purge(key);
        msg.respond(jc.encode({ success: true }));
      } catch (e) {
        msg.respond(jc.encode({ error: "Failed to delete profile" }));
      }
    }
  });

  console.log("[Librarian] Reactive Telemetry Active.");
}
