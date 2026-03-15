import { connect, StringCodec, JSONCodec } from "nats";

async function run() {
  const nc = await connect({ servers: "nats://localhost:4222" });
  const sc = StringCodec();
  const jc = JSONCodec();
  const uuid = "1277b779-185d-4ca9-8e38-2b8d0c4b6a8e"; 

  nc.subscribe(`worker.${uuid}.codex1.stdout`, {
    callback: (err, msg) => {
      if (err) console.error(err);
      else process.stdout.write(sc.decode(msg.data));
    },
  });

  nc.subscribe(`worker.${uuid}.codex1.profile_generated`, {
    callback: (err, msg) => {
      if (err) console.error(err);
      else console.log(`\n[PROFILE CAPTURED] ${sc.decode(msg.data)}`);
    },
  });

  console.log("Publishing start command with authFlow...");
  nc.publish(`worker.${uuid}.control`, jc.encode({
    action: "start",
    processId: "codex1",
    command: ["codex", "app-server"],
    env: { "CODEX_HOME": "/tmp/codex1/.codex" },
    authFlow: {
      loginCommand: ["codex", "login", "--device-auth"],
      targetFile: "/tmp/codex1/.codex/auth.json",
      runCommand: ["codex", "app-server"]
    }
  }));

  // Keep alive for manual login
  console.log("Waiting for user to complete login in browser...");
}

run();
