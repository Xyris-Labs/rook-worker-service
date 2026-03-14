import { connect, JSONCodec, type NatsConnection } from "nats";

const NATS_URL = process.env.NATS_URL || "nats://localhost:4222";

async function bootstrap() {
  let nc: NatsConnection;

  try {
    nc = await connect({ servers: NATS_URL });
    console.log(`Connected to NATS at ${nc.getServer()}`);

    const jc = JSONCodec();
    const handshakePayload = {
      type: "CODEX_WORKER",
      tags: ["sandbox", "mcp"],
      status: "idle",
    };

    const response = await nc.request(
      "system.handshake",
      jc.encode(handshakePayload),
      { timeout: 10000 }
    );

    const { serviceId, clusterId } = jc.decode(response.data) as {
      serviceId: string;
      clusterId: string;
    };

    console.log(`Registration successful. ServiceID: ${serviceId}, ClusterID: ${clusterId}`);

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
