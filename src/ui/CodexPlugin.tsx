import React from "react";

export default function CodexPlugin({ uuid, natsPublish }: { uuid: string, natsPublish: (topic: string, data: any) => void }) {
  return (
    <div style={{ padding: "1rem", border: "1px solid #444", borderRadius: "8px", background: "#1e1e1e", color: "white" }}>
      <h2>Codex Agent Node ({uuid.slice(0,6)})</h2>
      <p>This UI was dynamically loaded over NATS!</p>
      <button 
        onClick={() => natsPublish(`worker.${uuid}.control`, { action: "ping" })}
        style={{ padding: "0.5rem 1rem", background: "#3b82f6", color: "white", border: "none", cursor: "pointer" }}
      >
        Ping Worker
      </button>
    </div>
  );
}
// Mount helper for the host environment
export const mount = (props: any) => <CodexPlugin {...props} />;
