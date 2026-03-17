import React, { useState, useEffect, useRef } from 'react';
import { createRoot } from 'react-dom/client';

interface TerminalLine { text: string; color: string; isStream?: boolean }
interface ActiveSession { id: string; type: 'agent' | 'raw'; name: string }

// --- TERMINAL COMPONENT (DATA PLANE) ---
const AgentTerminal = ({ agentUuid, natsPublish, natsSubscribe }: any) => {
  const [lines, setLines] = useState<TerminalLine[]>([{text: `[SYSTEM] Connected to Agent JetStream: ${agentUuid}`, color: 'text-blue-400 font-bold'}]);
  const [input, setInput] = useState('');
  const [threadId, setThreadId] = useState<string | null>(null);
  const logsEndRef = useRef<HTMLDivElement>(null);
  const messageIdRef = useRef(3); // 1=init, 2=thread

  const appendLine = (text: string, color: string = 'text-gray-300') => setLines(prev => [...prev, { text, color }].slice(-300));
  const appendStream = (text: string) => {
    setLines(prev => {
      const arr = [...prev];
      const last = arr[arr.length - 1];
      if (last && last.isStream) { arr[arr.length - 1] = { ...last, text: last.text + text }; }
      else { arr.push({ text, color: 'text-green-400', isStream: true }); }
      return arr.slice(-300);
    });
  };

  useEffect(() => {
    if (!natsSubscribe) return;
    const sub = natsSubscribe(`agent.${agentUuid}.outbox`, (data: string) => {
      try {
        const payload = JSON.parse(data);
        if (payload.id === 1 && payload.result?.userAgent) {
          appendLine(`[SYSTEM] Handshake Accepted. Opening workspace thread...`, 'text-blue-400');
          natsPublish(`agent.${agentUuid}.inbox`, {
            jsonrpc: "2.0", id: 2, method: "thread/start",
            params: { model: "gpt-5.3-codex", cwd: "/workspace", sandbox: "workspace-write", approvalPolicy: "on-request", experimentalRawEvents: false }
          });
        } else if (payload.id === 2 && payload.result) {
          const tId = payload.result.thread?.id || payload.result.threadId;
          if (tId) {
            setThreadId(tId);
            appendLine(`[SYSTEM] Workspace established: ${tId}`, 'text-blue-400 font-bold');
            appendLine('', 'transparent');
          }
        } else if (payload.method === 'item/agentMessage/delta') {
          appendStream(payload.params?.delta || "");
        } else if (payload.method === 'error' || payload.error) {
          const errMsg = payload.error?.message || payload.params?.error?.message || "Unknown Error";
          appendLine(`\n[AGENT ERROR] ${errMsg}`, 'text-red-500 font-bold');
        }
      } catch(e) {}
    });
    return () => sub.unsubscribe();
  }, [natsSubscribe, agentUuid, natsPublish]);

  useEffect(() => logsEndRef.current?.scrollIntoView(), [lines]);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!input.trim() || !threadId) return;
    const text = input; setInput('');
    appendLine(`\n> ${text}`, 'text-yellow-400');
    appendLine('', 'transparent');
    natsPublish(`agent.${agentUuid}.inbox`, {
      jsonrpc: "2.0", id: messageIdRef.current++, method: "turn/start",
      params: { threadId, input: [{ type: "text", text, text_elements: [] }] }
    });
  };

  return (
    <div className="flex flex-col h-full bg-black font-mono text-sm relative">
      <div className="flex-1 overflow-y-auto p-4 pb-12">
        {lines.map((l, i) => <div key={i} className={`whitespace-pre-wrap ${l.color}`}>{l.text}</div>)}
        <div ref={logsEndRef} />
      </div>
      <form onSubmit={handleSubmit} className="absolute bottom-0 w-full p-2 border-t border-gray-800 bg-gray-900 flex">
        <span className="text-green-500 mr-2 font-bold">{'>'}</span>
        <input type="text" value={input} onChange={e => setInput(e.target.value)} disabled={!threadId} className="flex-1 bg-transparent outline-none text-gray-200 disabled:opacity-50" placeholder={threadId ? "Execute command..." : "Waiting for workspace..."} autoFocus />
      </form>
    </div>
  );
}

// --- RAW TERMINAL (PROVISIONING) ---
const RawTerminal = ({ processId, workerUuid, natsPublish, natsSubscribe }: any) => {
  const [lines, setLines] = useState<string[]>(['[SYSTEM] Attached to raw process stream...']);
  const [input, setInput] = useState('');
  const logsEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!natsSubscribe) return;
    const sub = natsSubscribe(`worker.${workerUuid}.${processId}.stdout`, (data: string) => {
      const cleanText = data.replace(/\x1b\[[0-9;]*m/g, '');
      if (cleanText.trim()) setLines(prev => [...prev, cleanText].slice(-300));
    });
    return () => sub.unsubscribe();
  }, [natsSubscribe, workerUuid, processId]);

  useEffect(() => logsEndRef.current?.scrollIntoView(), [lines]);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!input.trim()) return;
    natsPublish(`worker.${workerUuid}.${processId}.stdin`, input);
    setInput('');
  };

  return (
    <div className="flex flex-col h-full bg-black font-mono text-sm relative">
      <div className="flex-1 overflow-y-auto p-4 pb-12 text-gray-300">
        {lines.map((l, i) => <div key={i} className="whitespace-pre-wrap">{l}</div>)}
        <div ref={logsEndRef} />
      </div>
      <form onSubmit={handleSubmit} className="absolute bottom-0 w-full p-2 border-t border-gray-800 bg-gray-900 flex">
        <span className="text-yellow-500 mr-2 font-bold">{'>'}</span>
        <input type="text" value={input} onChange={e => setInput(e.target.value)} className="flex-1 bg-transparent outline-none text-gray-200" placeholder="Raw stdin..." autoFocus />
      </form>
    </div>
  );
}

// --- DASHBOARD (CONTROL PLANE) ---
const CodexPlugin = ({ uuid: workerUuid, natsPublish, natsSubscribe }: any) => {
  const [sessions, setSessions] = useState<ActiveSession[]>([]);
  const [selectedSession, setSelectedSession] = useState<ActiveSession | null>(null);
  const [engine, setEngine] = useState('codex');
  const [profileId, setProfileId] = useState('profile.codex.default');

  // Global listener for Agent Discovery
  useEffect(() => {
    if (!natsSubscribe) return;
    const sub = natsSubscribe(`worker.${workerUuid}.*.stdout`, (data: string) => {
      const agentMatch = data.match(/\[SYSTEM_EVENT:AGENT_ONLINE:(.+)\]/);
      if (agentMatch) {
        const newAgentId = agentMatch[1];
        setSessions(prev => {
          if (prev.some(s => s.id === newAgentId)) return prev;
          const newSession: ActiveSession = { id: newAgentId, type: 'agent', name: `Jerry (${newAgentId.split('-')[0]})` };
          setSelectedSession(newSession); // Auto-focus new agent
          return [...prev, newSession];
        });
      }
    });
    return () => sub.unsubscribe();
  }, [natsSubscribe, workerUuid]);

  const handleBoot = () => {
    const processId = `agent-${Date.now()}`;
    natsPublish(`worker.${workerUuid}.control`, {
      action: 'start', processId, profileId, command: ['codex', 'app-server']
    });
  };

  const handleProvision = () => {
    const processId = `auth-${Date.now()}`;
    natsPublish(`worker.${workerUuid}.control`, {
      action: 'start', processId,
      authFlow: { loginCommand: ['codex', 'login', '--device-auth'], targetFile: '/root/.codex/config.json', runCommand: [] }
    });
    const newSession: ActiveSession = { id: processId, type: 'raw', name: 'Provisioning Flow' };
    setSessions(prev => [...prev, newSession]);
    setSelectedSession(newSession);
  };

  return (
    <div className="flex h-full w-full text-gray-200 font-sans bg-gray-950 overflow-hidden">
      {/* LEFT SIDEBAR: CONTROL PLANE */}
      <div className="w-80 flex flex-col border-r border-gray-800 bg-gray-900">
        <div className="p-4 border-b border-gray-800">
          <h2 className="text-lg font-bold text-white tracking-wide">ROOK MANAGER</h2>
          <p className="text-xs text-gray-500 font-mono mt-1">ID: {workerUuid.split('-')[0]}</p>
        </div>

        <div className="p-4 border-b border-gray-800">
          <h3 className="text-xs font-bold text-gray-400 uppercase tracking-wider mb-3">Launch Instance</h3>

          <label className="block text-xs text-gray-400 mb-1">Agent Engine</label>
          <select value={engine} onChange={e=>setEngine(e.target.value)} className="w-full bg-black border border-gray-700 text-sm rounded p-2 mb-3 outline-none focus:border-blue-500">
            <option value="codex">Codex (OpenAI/T3)</option>
            <option value="copilot" disabled>GitHub Copilot (Soon)</option>
            <option value="gemini" disabled>Gemini CLI (Soon)</option>
          </select>

          <label className="block text-xs text-gray-400 mb-1">Librarian Profile (KV)</label>
          <input type="text" value={profileId} onChange={e=>setProfileId(e.target.value)} className="w-full bg-black border border-gray-700 text-sm rounded p-2 mb-4 outline-none focus:border-blue-500" placeholder="profile.id" />

          <div className="flex gap-2">
            <button onClick={handleBoot} className="flex-1 bg-blue-600 hover:bg-blue-500 text-white font-bold py-2 rounded text-sm transition-colors">Boot Agent</button>
            <button onClick={handleProvision} className="flex-1 bg-yellow-600/20 text-yellow-500 border border-yellow-500/50 hover:bg-yellow-600/40 font-bold py-2 rounded text-sm transition-colors">Provision</button>
          </div>
        </div>

        <div className="flex-1 overflow-y-auto p-4">
          <h3 className="text-xs font-bold text-gray-400 uppercase tracking-wider mb-3">Active Sessions</h3>
          {sessions.length === 0 ? <div className="text-xs text-gray-600 italic">No running sessions</div> : null}
          {sessions.map(s => (
            <div key={s.id} onClick={() => setSelectedSession(s)} className={`p-3 mb-2 rounded cursor-pointer border transition-colors ${selectedSession?.id === s.id ? 'bg-blue-900/20 border-blue-500/50' : 'bg-black border-gray-800 hover:border-gray-600'}`}>
              <div className="flex items-center gap-2 mb-1">
                <div className={`w-2 h-2 rounded-full ${s.type === 'agent' ? 'bg-green-500' : 'bg-yellow-500'}`}></div>
                <span className="text-sm font-bold text-gray-200">{s.name}</span>
              </div>
              <div className="text-[10px] text-gray-500 font-mono truncate">{s.id}</div>
            </div>
          ))}
        </div>
      </div>

      {/* RIGHT PANEL: DATA PLANE */}
      <div className="flex-1 flex flex-col bg-black">
        {!selectedSession ? (
          <div className="flex-1 flex items-center justify-center text-gray-600 font-mono text-sm">
            Configure and launch an agent from the Control Plane.
          </div>
        ) : (
          <>
            <div className="h-10 border-b border-gray-800 bg-gray-900 flex items-center px-4 gap-3">
              <div className={`text-[10px] font-bold px-2 py-0.5 rounded uppercase tracking-wider ${selectedSession.type === 'agent' ? 'bg-green-500/20 text-green-400' : 'bg-yellow-500/20 text-yellow-400'}`}>
                {selectedSession.type === 'agent' ? 'JSON-RPC' : 'RAW STDIO'}
              </div>
              <span className="text-xs font-mono text-gray-400">{selectedSession.id}</span>
            </div>
            <div className="flex-1 relative">
              {selectedSession.type === 'agent' ? (
                <AgentTerminal agentUuid={selectedSession.id} natsPublish={natsPublish} natsSubscribe={natsSubscribe} />
              ) : (
                <RawTerminal processId={selectedSession.id} workerUuid={workerUuid} natsPublish={natsPublish} natsSubscribe={natsSubscribe} />
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
};

export function mount(el: HTMLElement, props: any) {
  const root = createRoot(el);
  root.render(<CodexPlugin {...props} />);
  return () => root.unmount();
}
