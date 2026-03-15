import { connect, StringCodec } from "nats";

const NATS_URL = process.env.NATS_URL || "nats://localhost:4222";

async function run() {
  const args = process.argv.slice(2);
  const [command, topic, payload] = args;

  if (!command || !topic || (["pub", "req", "kv-get"].includes(command) && !payload)) {
    console.log("Usage: bun run src/rook-cli.ts <sub|pub|req|kv-keys|kv-get|kv-watch> <topic/bucket> [payload/key]");
    process.exit(1);
  }

  try {
    const nc = await connect({ servers: NATS_URL });
    const sc = StringCodec();

    switch (command) {
      case "sub":
        console.log(`Subscribed to ${topic}...`);
        nc.subscribe(topic, {
          callback: (err, msg) => {
            if (err) console.error(err);
            else console.log(sc.decode(msg.data));
          },
        });
        break;

      case "pub":
        nc.publish(topic, sc.encode(payload));
        await nc.drain();
        process.exit(0);
        break;

      case "req":
        try {
          const rep = await nc.request(topic, sc.encode(payload), { timeout: 5000 });
          console.log(sc.decode(rep.data));
        } catch (err) {
          console.error("Request timed out or failed:", err instanceof Error ? err.message : err);
        }
        await nc.drain();
        process.exit(0);
        break;

      case "kv-keys":
        try {
          const js = nc.jetstream();
          const kv = await js.views.kv(topic);
          const keys = await kv.keys();
          for await (const k of keys) {
            console.log(k);
          }
        } catch (err) {
          console.error("KV Error:", err instanceof Error ? err.message : err);
        }
        await nc.drain();
        process.exit(0);
        break;

      case "kv-get":
        try {
          const js = nc.jetstream();
          const kv = await js.views.kv(topic);
          const entry = await kv.get(payload);
          if (entry) {
            console.log(sc.decode(entry.value));
          } else {
            console.log("Key not found");
          }
        } catch (err) {
          console.error("KV Error:", err instanceof Error ? err.message : err);
        }
        await nc.drain();
        process.exit(0);
        break;

      case "kv-watch":
        try {
          const js = nc.jetstream();
          const kv = await js.views.kv(topic);
          const iter = await kv.watch();
          for await (const e of iter) {
            console.log(`[${e.operation}] ${e.key} => ${sc.decode(e.value)}`);
          }
        } catch (err) {
          console.error("KV Error:", err instanceof Error ? err.message : err);
        }
        break;

      default:
        console.log("Usage: bun run src/rook-cli.ts <sub|pub|req|kv-keys|kv-get|kv-watch> <topic/bucket> [payload/key]");
        await nc.close();
        process.exit(1);
    }
  } catch (err) {
    console.error("NATS Connection Error:", err instanceof Error ? err.message : err);
    process.exit(1);
  }
}

run();
