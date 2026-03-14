import { connect, JSONCodec, type NatsConnection } from "nats";

const NATS_URL = process.env.NATS_URL || "nats://host.docker.internal:4222";

async function bootstrap() {
  let nc: NatsConnection;

  try {
    nc = await connect({ servers: NATS_URL });
    console.log(`Connected to NATS at ${nc.getServer()}`);

    const jc = JSONCodec();
    const handshakePayload = {
      type: "service.worker.codex",
      name: `worker-${Math.random().toString(36).substring(7)}`,
    };

    const response = await nc.request(
      "registry.handshake",
      jc.encode(handshakePayload),
      { timeout: 10000 }
    );

    const { uuid } = jc.decode(response.data) as {
      uuid: string;
    };

    console.log(`Registration successful. ServiceID: ${uuid}`);

    const handleShutdown = async () => {
      console.log("Gracefully shutting down NATS connection...");
      await nc.drain();
      process.exit(0);
    };

    process.on("SIGINT", handleShutdown);
    process.on("SIGTERM", handleShutdown);

  } catch (error) {
    console.error("Failed to connect or register:", error instanceof Error ? error.message : error);
    process.exit(1);
  }
}

bootstrap();
