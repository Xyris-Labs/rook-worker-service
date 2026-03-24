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

  // 1. INDEX LISTENER
  nc.subscribe("librarian.index.request", {
    callback: async (err, msg) => {
      if (err) return;
      try {
        const keys = [];
        const iter = await kv.keys();
        for await (const k of iter) {
          keys.push(k);
        }
        msg.respond(jc.encode(keys));
      } catch (e) {
        msg.respond(jc.encode([]));
      }
    }
  });

  // 2. GET LISTENER
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

  // 3. PUT LISTENER
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

  // 4. DELETE LISTENER
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

  console.log("[Librarian] RPC Handlers Active.");
}
