import { connect, StringCodec } from "nats";

const NATS_URL = process.env.NATS_URL || "nats://localhost:4222";

async function run() {
  const args = process.argv.slice(2);
  const [command, topic, payload] = args;

  if (!command || !topic || (["pub", "req"].includes(command) && !payload)) {
    console.log("Usage: bun run src/rook-cli.ts <sub|pub|req> <topic> [payload]");
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

      default:
        console.log("Usage: bun run src/rook-cli.ts <sub|pub|req> <topic> [payload]");
        await nc.close();
        process.exit(1);
    }
  } catch (err) {
    console.error("NATS Connection Error:", err instanceof Error ? err.message : err);
    process.exit(1);
  }
}

run();
