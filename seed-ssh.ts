import { connect, StringCodec } from "nats";
import * as fs from "fs";
import * as path from "path";

async function seedSSH() {
  const sc = StringCodec();
  const NATS_URL = process.env.NATS_URL || "nats://127.0.0.1:4222";
  
  console.log(`Connecting to NATS at ${NATS_URL}...`);
  const nc = await connect({ servers: NATS_URL });
  const js = nc.jetstream();

  try {
    // Access the KV bucket
    const kv = await js.views.kv("librarian_profiles");

    // Read the local SSH key
    const localKeyPath = path.join(process.cwd(), "id_rsa");
    
    if (!fs.existsSync(localKeyPath)) {
      throw new Error(`Could not find id_rsa at ${localKeyPath}. Please ensure the file exists in the project root.`);
    }

    const keyContent = fs.readFileSync(localKeyPath, "utf-8");

    // Push to KV
    await kv.put("secret.git.default", sc.encode(keyContent));

    console.log("\n[SUCCESS] SSH Key injected into Librarian KV as 'secret.git.default'");
    
    console.log("\n" + "=".repeat(60));
    console.log("!!! SECURITY WARNING !!!");
    console.log("Please DELETE the local 'id_rsa' file IMMEDIATELY.");
    console.log("Do NOT leave it in your working directory to prevent accidental commits.");
    console.log("=".repeat(60) + "\n");

  } catch (err) {
    console.error(`[ERROR] Failed to seed SSH key:`, err instanceof Error ? err.message : err);
  } finally {
    await nc.close();
  }
}

seedSSH().catch(console.error);
