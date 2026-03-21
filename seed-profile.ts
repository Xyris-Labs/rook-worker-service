import { connect } from "nats";
import * as fs from "fs";
import * as path from "path";

async function seed() {
  const nc = await connect({ servers: process.env.NATS_URL || "nats://127.0.0.1:4222" });
  const js = nc.jetstream();

  // Ensure the bucket exists
  const kv = await js.views.kv("librarian_profiles", { history: 1 });

  const localProfilePath = path.join(process.cwd(), "auth.json");

  if (fs.existsSync(localProfilePath)) {
    const authContent = fs.readFileSync(localProfilePath, "utf-8");
    await kv.put("profile.codex.default", authContent);
    console.log(`[Success] auth.json injected into Librarian KV as 'profile.codex.default'`);
  } else {
    console.error(`[Error] Could not find auth.json at ${localProfilePath}. Make sure you copied it to the root directory!`);
  }

  await nc.close();
}

seed().catch(console.error);
