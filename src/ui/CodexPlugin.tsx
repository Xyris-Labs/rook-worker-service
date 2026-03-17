import React, { useState, useEffect, useRef } from 'react';
import { createRoot } from 'react-dom/client';

interface TerminalLine { text: string; color: string; isStream?: boolean }

const CodexPlugin = ({ uuid: workerUuid, natsPublish, natsSubscribe }: any) => {
  const [lines, setLines] = useState<TerminalLine[]>([{text: 'Initializing Codex Mesh Interface...', color: 'text-gray-500'}]);
  const [input, setInput] = useState('');
  const [agentUuid, setAgentUuid] = useState<string | null>(null);
  const [threadId, setThreadId] = useState<string | null>(null);
  const logsEndRef = useRef<HTMLDivElement>(null);
  const messageIdRef = useRef(3); // 1 = init, 2 = thread/start

  const appendLine = (text: string, color: string = 'text-gray-300') => {
    setLines(prev => [...prev, { text, color }].slice(-300));
  };

  const appendStream = (text: string) => {
    setLines(prev => {
      const arr = [...prev];
      const last = arr[arr.length - 1];
      if (last && last.isStream) {
        arr[arr.length - 1] = { ...last, text: last.text + text };
      } else {
        arr.push({ text, color: 'text-green-400', isStream: true });
      }
      return arr.slice(-300);
    });
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
      const cleanText = data.replace(/\x1b\[[0-9;]*m/g, '');
      if (cleanText.trim()) appendLine(cleanText);
    });
    return () => { if (sub && sub.unsubscribe) sub.unsubscribe(); };
  }, [natsSubscribe, workerUuid]);

  // 2. JSON-RPC Protocol Handler
  useEffect(() => {
    if (!natsSubscribe || !agentUuid) return;
    const sub = natsSubscribe(`agent.${agentUuid}.outbox`, (data: string) => {
      try {
        const payload = JSON.parse(data);

        // A. Handle Initialization Success -> Start Thread
        if (payload.id === 1 && payload.result?.userAgent) {
          appendLine(`[SYSTEM] Handshake Accepted (${payload.result.userAgent}). Opening workspace thread...`, 'text-blue-400');
          const threadReq = {
            jsonrpc: "2.0", id: 2, method: "thread/start",
            params: { model: "gpt-5.3-codex", sandbox: "workspace-write", approvalPolicy: "on-request" }
          };
          natsPublish(`agent.${agentUuid}.inbox`, JSON.stringify(threadReq));
        }

        // B. Handle Thread Start Success -> Ready for Input
        else if (payload.id === 2 && payload.result) {
          const tId = payload.result.thread?.id || payload.result.threadId;
          if (tId) {
            setThreadId(tId);
            appendLine(`[SYSTEM] Workspace thread established: ${tId}. Jerry is online.`, 'text-blue-400 font-bold');
            // Break the stream state so Jerry's first message starts on a fresh line
            appendLine('', 'transparent'); 
          }
        }

        // C. Handle Streaming Output
        else if (payload.method === 'item/agentMessage/delta') {
          const delta = payload.params?.delta || "";
          appendStream(delta);
        }

        // D. Handle Server Errors
        else if (payload.method === 'error' || payload.error) {
          const errMsg = payload.error?.message || payload.params?.error?.message || JSON.stringify(payload);
          appendLine(`\n[AGENT ERROR] ${errMsg}`, 'text-red-500 font-bold');
        }

      } catch (e) {
        // Fallback for non-JSON or broken pipes
        appendLine(data, 'text-gray-500');
      }
    });
    return () => { if (sub && sub.unsubscribe) sub.unsubscribe(); };
  }, [natsSubscribe, agentUuid, natsPublish]);

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

    // Force a new line so user input breaks any existing streams
    appendLine(`\n> ${userText}`, 'text-yellow-400');
    // Add a dummy empty line so the upcoming agent stream starts on the next line
    appendLine('', 'transparent'); 

    if (agentUuid && threadId) {
      // Fire the strict turn/start execution schema
      const rpcPayload = {
        jsonrpc: "2.0", id: messageIdRef.current++, method: "turn/start",
        params: {
          threadId: threadId,
          input: [{ type: "text", text: userText }]
        }
      };
      natsPublish(`agent.${agentUuid}.inbox`, JSON.stringify(rpcPayload));
    } else if (!agentUuid) {
      // Dumb proxy mode for login/auth
      natsPublish(`worker.${workerUuid}.codex-auth.stdin`, userText);
      natsPublish(`worker.${workerUuid}.codex-main.stdin`, userText);
    } else {
      appendLine('[SYSTEM] Cannot execute turn: Workspace thread is not ready.', 'text-red-500');
    }
  };

  return (
    <div className="flex flex-col h-full bg-black text-gray-200 font-mono text-sm border border-gray-800 rounded-lg overflow-hidden relative">
      <div className="absolute top-0 w-full flex items-center justify-between bg-gray-900 border-b border-gray-800 p-2 z-10">
        <div className="flex space-x-2 px-2">
          <div className="w-3 h-3 rounded-full bg-red-500"></div>
          <div className="w-3 h-3 rounded-full bg-yellow-500"></div>
          <div className="w-3 h-3 rounded-full bg-green-500"></div>
        </div>
        <div className="text-xs text-gray-500">
          {threadId ? `thread.${threadId.split('-')[0]}` : agentUuid ? `agent.${agentUuid.split('-')[0]}` : `worker.${workerUuid.split('-')[0]}`}
        </div>
        <div className="flex gap-2">
          <button onClick={handleProvision} className="px-2 py-1 bg-gray-800 hover:bg-gray-700 text-xs text-yellow-500 rounded border border-gray-700">Auth</button>
          <button onClick={handleStart} className="px-2 py-1 bg-gray-800 hover:bg-gray-700 text-xs text-blue-400 rounded border border-gray-700">Boot</button>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto p-4 pt-14 pb-12">
        {lines.map((line, i) => (
          <div key={i} className={`whitespace-pre-wrap leading-relaxed ${line.color}`}>
            {line.text}
          </div>
        ))}
        <div ref={logsEndRef} />
      </div>

      <form onSubmit={handleCommandSubmit} className="absolute bottom-0 w-full flex items-center bg-gray-900 border-t border-gray-800 p-2">
        <span className="text-green-500 font-bold mr-2 ml-2">{'>'}</span>
        <input
          type="text"
          value={input}
          onChange={e => setInput(e.target.value)}
          disabled={agentUuid !== null && threadId === null}
          className="flex-1 bg-transparent text-gray-200 outline-none placeholder-gray-700 disabled:opacity-50"
          autoFocus
          placeholder={threadId ? "Execute command..." : agentUuid ? "Opening workspace..." : "Awaiting boot..."}
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
