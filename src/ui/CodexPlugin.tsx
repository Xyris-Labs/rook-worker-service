import React, { useState, useEffect, useRef } from 'react';
import { createRoot } from 'react-dom/client';

const CodexPlugin = ({ uuid: workerUuid, natsPublish, natsSubscribe }: any) => {
  const [lines, setLines] = useState<string[]>(['Initializing Codex Mesh Interface...']);
  const [input, setInput] = useState('');
  const [agentUuid, setAgentUuid] = useState<string | null>(null);
  const logsEndRef = useRef<HTMLDivElement>(null);
  const messageIdRef = useRef(2);

  const appendLine = (line: string, colorClass: string = 'text-gray-300') => {
    setLines(prev => [...prev, `<span class="${colorClass}">${line}</span>`].slice(-300));
  };

  // 1. Raw stdout listener (Login flow & Discovery)
  useEffect(() => {
    if (!natsSubscribe) return;
    const sub = natsSubscribe(`worker.${workerUuid}.*.stdout`, (data: string) => {
      const agentMatch = data.match(/\[SYSTEM_EVENT:AGENT_ONLINE:(.+)\]/);
      if (agentMatch) {
        setAgentUuid(agentMatch[1]);
        appendLine(`\n[SYSTEM] Agent connection established via JetStream. UUID: ${agentMatch[1]}`, 'text-blue-400 font-bold');
        return;
      }

      // Strip basic ANSI codes for clean web rendering
      const cleanText = data.replace(/\x1b\[[0-9;]*m/g, '');
      if (cleanText.trim()) appendLine(cleanText);
    });
    return () => { if (sub && sub.unsubscribe) sub.unsubscribe(); };
  }, [natsSubscribe, workerUuid]);

  // 2. JSON-RPC outbox listener (Agent Execution)
  useEffect(() => {
    if (!natsSubscribe || !agentUuid) return;
    const sub = natsSubscribe(`agent.${agentUuid}.outbox`, (data: string) => {
      try {
        const payload = JSON.parse(data);

        // If it's a direct string result
        if (payload.result && typeof payload.result === 'string') {
          appendLine(payload.result, 'text-green-400');
        } 
        // If it's the initialize confirmation
        else if (payload.id === 1 && payload.result?.userAgent) {
          appendLine(`[SYSTEM] JSON-RPC Handshake Accepted. Server: ${payload.result.userAgent}`, 'text-blue-400');
        }
        // Log unexpected JSON for debugging
        else {
          appendLine(JSON.stringify(payload), 'text-gray-500');
        }
      } catch (e) {
        // Not JSON, just print it
        appendLine(data, 'text-green-400');
      }
    });
    return () => { if (sub && sub.unsubscribe) sub.unsubscribe(); };
  }, [natsSubscribe, agentUuid]);

  // Auto-scroll
  useEffect(() => {
    logsEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [lines]);

  const handleStart = () => {
    appendLine('\n> Starting Codex App Server...', 'text-yellow-400');
    natsPublish(`worker.${workerUuid}.control`, {
      action: 'start', processId: 'codex-main', command: ['codex', 'app-server'] 
    });
  };

  const handleProvision = () => {
    appendLine('\n> Initiating Device Auth...', 'text-yellow-400');
    natsPublish(`worker.${workerUuid}.control`, {
      action: 'start', processId: 'codex-auth',
      authFlow: {
        loginCommand: ['codex', 'login', '--device-auth'],
        targetFile: '/tmp/profile.json',
        runCommand: ['codex', 'app-server']
      }
    });
  };

  const handleCommandSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!input.trim()) return;

    const userText = input;
    setInput('');
    appendLine(`\n> ${userText}`, 'text-yellow-400');

    if (agentUuid) {
      // Smart Mode: Wrap in JSON-RPC
      const rpcPayload = {
        jsonrpc: "2.0", id: messageIdRef.current++, method: "chat/completions", // We will adjust the method if server rejects
        params: { messages: [{ role: "user", content: userText }] }
      };
      natsPublish(`agent.${agentUuid}.inbox`, JSON.stringify(rpcPayload));
    } else {
      // Dumb Mode: Raw stdin pipe
      natsPublish(`worker.${workerUuid}.codex-auth.stdin`, userText);
      natsPublish(`worker.${workerUuid}.codex-main.stdin`, userText);
    }
  };

  return (
    <div className="flex flex-col h-full bg-black text-gray-200 font-mono text-sm border border-gray-800 rounded-lg overflow-hidden relative">
      {/* Top Control Bar */}
      <div className="absolute top-0 w-full flex items-center justify-between bg-gray-900 border-b border-gray-800 p-2 z-10">
        <div className="flex space-x-2 px-2">
          <div className="w-3 h-3 rounded-full bg-red-500"></div>
          <div className="w-3 h-3 rounded-full bg-yellow-500"></div>
          <div className="w-3 h-3 rounded-full bg-green-500"></div>
        </div>
        <div className="text-xs text-gray-500">
          {agentUuid ? `agent.${agentUuid.split('-')[0]}` : `worker.${workerUuid.split('-')[0]}`}
        </div>
        <div className="flex gap-2">
          <button onClick={handleProvision} className="px-2 py-1 bg-gray-800 hover:bg-gray-700 text-xs text-yellow-500 rounded border border-gray-700">Auth</button>
          <button onClick={handleStart} className="px-2 py-1 bg-gray-800 hover:bg-gray-700 text-xs text-blue-400 rounded border border-gray-700">Boot</button>
        </div>
      </div>

      {/* Terminal Window */}
      <div className="flex-1 overflow-y-auto p-4 pt-14 pb-12">
        {lines.map((line, i) => (
          <div key={i} dangerouslySetInnerHTML={{ __html: line }} className="whitespace-pre-wrap leading-relaxed" />
        ))}
        <div ref={logsEndRef} />
      </div>

      {/* Command Line Input */}
      <form onSubmit={handleCommandSubmit} className="absolute bottom-0 w-full flex items-center bg-gray-900 border-t border-gray-800 p-2">
        <span className="text-green-500 font-bold mr-2 ml-2">{'>'}</span>
        <input
          type="text"
          value={input}
          onChange={e => setInput(e.target.value)}
          className="flex-1 bg-transparent text-gray-200 outline-none placeholder-gray-700"
          autoFocus
          placeholder={agentUuid ? "Ready." : "Awaiting boot..."}
        />
      </form>
    </div>
  );
};

export function mount(el: HTMLElement, props: any) {
  const root = createRoot(el);
  root.render(<CodexPlugin {...props} />);
  return () => root.unmount();
}
