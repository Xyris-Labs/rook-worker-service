import React, { useState, useEffect, useRef } from 'react';
import { createRoot } from 'react-dom/client';

interface TerminalLine { text: string; color: string; isStream?: boolean }
interface Workspace { id: string; name: string; engine: string; profileId: string; }

// --- TERMINAL COMPONENT (DATA PLANE) ---
const AgentTerminal = ({ agentUuid, natsPublish, natsSubscribe }: any) => {
  const [lines, setLines] = useState<TerminalLine[]>([{text: `[SYSTEM] Connected to Agent JetStream: ${agentUuid}`, color: 'text-blue-400 font-bold'}]);
  const [input, setInput] = useState('');
  const [threadId, setThreadId] = useState<string | null>(null);
  const logsEndRef = useRef<HTMLDivElement>(null);
  const messageIdRef = useRef(3); 

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
    <div className="flex flex-col h-full bg-black font-mono text-sm relative border border-gray-800 rounded">
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
    <div className="flex flex-col h-96 bg-black font-mono text-sm relative border border-gray-800 rounded">
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

// --- MAIN MANAGER APP ---
const CodexPlugin = ({ uuid: workerUuid, natsPublish, natsSubscribe }: any) => {
  // Persist workspaces in local storage for now until backend DB is ready
  const [workspaces, setWorkspaces] = useState<Workspace[]>(() => {
    try { return JSON.parse(localStorage.getItem('rook_workspaces') || '[]'); } catch { return []; }
  });

  const [view, setView] = useState<'list' | 'create' | 'details'>('list');
  const [selectedWs, setSelectedWs] = useState<Workspace | null>(null);

  // Create Form State
  const [newName, setNewName] = useState('');
  const [newEngine, setNewEngine] = useState('codex');
  const [newProfile, setNewProfile] = useState('new');

  // Runtime State
  const [runningProcesses, setRunningProcesses] = useState<any[]>([]);
  const [agentUuids, setAgentUuids] = useState<Record<string, string>>({}); // Maps workspace.id to Agent UUID

  useEffect(() => {
    localStorage.setItem('rook_workspaces', JSON.stringify(workspaces));
  }, [workspaces]);

  // Listen for Agent Discovery events to map the workspace ID to the newly minted Agent UUID
  useEffect(() => {
    if (!natsSubscribe) return;
    const sub = natsSubscribe(`worker.${workerUuid}.*.stdout`, (data: string, err: any, msg: any) => {
      const agentMatch = data.match(/\[SYSTEM_EVENT:AGENT_ONLINE:(.+)\]/);
      if (agentMatch && msg.subject) {
        // Subject looks like: worker.<workerUuid>.<workspaceId>.stdout
        const parts = msg.subject.split('.');
        if (parts.length >= 4) {
          const wsId = parts[2];
          const newAgentId = agentMatch[1];
          setAgentUuids(prev => ({ ...prev, [wsId]: newAgentId }));
        }
      }
    });
    return () => sub.unsubscribe();
  }, [natsSubscribe, workerUuid]);

  // Poll Backend Status
  useEffect(() => {
    if (!natsPublish || !natsSubscribe) return;
    const interval = setInterval(() => {
      natsPublish(`worker.${workerUuid}.status`, {}, {
        reply: `inbox.status.${Date.now()}`
      });
    }, 2000);

    const sub = natsSubscribe(`inbox.status.*`, (data: string) => {
      try {
        const res = JSON.parse(data);
        if (res.processes) setRunningProcesses(res.processes);
      } catch(e) {}
    });

    return () => { clearInterval(interval); sub.unsubscribe(); };
  }, [natsPublish, natsSubscribe, workerUuid]);

  const handleCreate = (e: React.FormEvent) => {
    e.preventDefault();
    const ws: Workspace = { id: `ws-${Date.now()}`, name: newName, engine: newEngine, profileId: newProfile };
    setWorkspaces(prev => [...prev, ws]);
    setNewName(''); setNewProfile('new');
    setView('list');
  };

  const handleStart = (ws: Workspace) => {
    natsPublish(`worker.${workerUuid}.control`, {
      action: 'start', 
      processId: ws.id, 
      profileId: ws.profileId === 'new' ? undefined : ws.profileId,
      command: ['codex', 'app-server']
    });
  };

  const handleStop = (wsId: string) => {
    natsPublish(`worker.${workerUuid}.control`, { action: 'stop', processId: wsId });
    setAgentUuids(prev => { const next = {...prev}; delete next[wsId]; return next; });
  };

  const handleRemove = (wsId: string) => {
    handleStop(wsId);
    setWorkspaces(prev => prev.filter(w => w.id !== wsId));
    if (selectedWs?.id === wsId) { setView('list'); setSelectedWs(null); }
  };

  const handleAuth = (wsId: string) => {
    // Optimistically render terminal so we don't miss the initial stdout chunk
    setRunningProcesses(prev => [...prev, { processId: `auth-${wsId}`, type: 'cli' }]);

    natsPublish(`worker.${workerUuid}.control`, {
      action: 'start', processId: `auth-${wsId}`,
      authFlow: { loginCommand: ['codex', 'login', '--device-auth'] }
    });
  };

  // --- VIEWS ---
  const renderList = () => (
    <div className="p-6 max-w-4xl mx-auto">
      <div className="flex justify-between items-center mb-6">
        <h2 className="text-2xl font-bold text-white">CLI Worker Manager</h2>
        <button onClick={() => setView('create')} className="bg-blue-600 hover:bg-blue-500 text-white px-4 py-2 rounded font-bold text-sm">Create Workspace</button>
      </div>
      {workspaces.length === 0 ? (
        <div className="text-gray-500 italic text-sm">No workspaces created yet.</div>
      ) : (
        <div className="grid gap-4">
          {workspaces.map(ws => {
            const isRunning = runningProcesses.some(p => p.processId === ws.id);
            return (
              <div key={ws.id} onClick={() => { setSelectedWs(ws); setView('details'); }} className="bg-gray-900 border border-gray-800 p-4 rounded cursor-pointer hover:border-gray-600 transition-colors flex justify-between items-center">
                <div>
                  <h3 className="text-lg font-bold text-gray-200">{ws.name}</h3>
                  <p className="text-xs text-gray-500 font-mono mt-1">{ws.engine} | {ws.id}</p>
                </div>
                <div className="flex items-center gap-3">
                  <span className={`text-xs font-bold px-2 py-1 rounded uppercase tracking-wider ${isRunning ? 'bg-green-500/20 text-green-400' : 'bg-gray-800 text-gray-500'}`}>
                    {isRunning ? 'Started' : 'Stopped'}
                  </span>
                  <span className="text-gray-500">→</span>
                </div>
              </div>
            )
          })}
        </div>
      )}
    </div>
  );

  const renderCreate = () => (
    <div className="p-6 max-w-lg mx-auto">
      <button onClick={() => setView('list')} className="text-gray-500 hover:text-white mb-6 text-sm">← Back to List</button>
      <h2 className="text-2xl font-bold text-white mb-6">Create Workspace</h2>
      <form onSubmit={handleCreate} className="space-y-4">
        <div>
          <label className="block text-xs font-bold text-gray-400 uppercase tracking-wider mb-2">Workspace Name</label>
          <input required type="text" value={newName} onChange={e => setNewName(e.target.value)} className="w-full bg-gray-900 border border-gray-800 text-white rounded p-3 outline-none focus:border-blue-500" placeholder="e.g. Backend Refactor Agent" />
        </div>
        <div>
          <label className="block text-xs font-bold text-gray-400 uppercase tracking-wider mb-2">Agent Engine</label>
          <select value={newEngine} onChange={e => setNewEngine(e.target.value)} className="w-full bg-gray-900 border border-gray-800 text-white rounded p-3 outline-none focus:border-blue-500">
            <option value="codex">Codex CLI</option>
            <option value="copilot" disabled>GitHub Copilot (Coming Soon)</option>
          </select>
        </div>
        <div>
          <label className="block text-xs font-bold text-gray-400 uppercase tracking-wider mb-2">Identity Profile</label>
          <select value={newProfile} onChange={e => setNewProfile(e.target.value)} className="w-full bg-gray-900 border border-gray-800 text-white rounded p-3 outline-none focus:border-blue-500">
            <option value="new">New (Requires Authentication)</option>
            <option value="profile.codex.default">profile.codex.default (From Librarian)</option>
          </select>
        </div>
        <button type="submit" className="w-full bg-blue-600 hover:bg-blue-500 text-white font-bold py-3 rounded mt-4">Create & Load Utilities</button>
      </form>
    </div>
  );

  const renderDetails = () => {
    if (!selectedWs) return null;
    const isRunning = runningProcesses.some(p => p.processId === selectedWs.id);
    const isAuthRunning = runningProcesses.some(p => p.processId === `auth-${selectedWs.id}`);
    const isAuthorized = selectedWs.profileId !== 'new'; // Simplistic auth check
    const agentId = agentUuids[selectedWs.id];

    return (
      <div className="p-6 h-full flex flex-col max-w-5xl mx-auto">
        <button onClick={() => setView('list')} className="text-gray-500 hover:text-white mb-4 text-sm w-fit">← Back to List</button>

        <div className="bg-gray-900 border border-gray-800 rounded-lg p-6 mb-6 flex justify-between items-start">
          <div>
            <h2 className="text-2xl font-bold text-white mb-2">{selectedWs.name}</h2>
            <div className="flex gap-4 text-sm font-mono text-gray-500">
              <span>Engine: <span className="text-gray-300">{selectedWs.engine}</span></span>
              <span>Profile: <span className="text-gray-300">{selectedWs.profileId}</span></span>
            </div>
          </div>
          <div className="flex flex-col gap-2 items-end">
            <div className="flex gap-2">
              <span className={`text-xs font-bold px-2 py-1 rounded uppercase tracking-wider ${isAuthorized ? 'bg-blue-500/20 text-blue-400' : 'bg-red-500/20 text-red-400'}`}>
                {isAuthorized ? 'Authorized' : 'Unauthorized'}
              </span>
              <span className={`text-xs font-bold px-2 py-1 rounded uppercase tracking-wider ${isRunning ? 'bg-green-500/20 text-green-400' : 'bg-gray-800 text-gray-500'}`}>
                {isRunning ? 'Started' : 'Stopped'}
              </span>
            </div>
            <div className="flex gap-2 mt-2">
              <button onClick={() => handleRemove(selectedWs.id)} className="px-3 py-1 text-xs font-bold text-red-500 hover:bg-red-500/10 rounded transition-colors">Remove</button>
              {!isAuthorized && !isRunning && !isAuthRunning && (
                <button onClick={() => handleAuth(selectedWs.id)} className="px-4 py-1 text-sm font-bold bg-yellow-600/20 text-yellow-500 hover:bg-yellow-600/30 border border-yellow-500/50 rounded transition-colors">Authenticate</button>
              )}
              {isRunning ? (
                <button onClick={() => handleStop(selectedWs.id)} className="px-4 py-1 text-sm font-bold bg-red-600 hover:bg-red-500 text-white rounded transition-colors">Stop</button>
              ) : (
                <button onClick={() => handleStart(selectedWs)} disabled={!isAuthorized} className="px-4 py-1 text-sm font-bold bg-green-600 hover:bg-green-500 disabled:bg-gray-700 disabled:text-gray-500 text-white rounded transition-colors">Start</button>
              )}
            </div>
          </div>
        </div>

        {/* CONDITIONAL RENDER: TERMINALS */}
        <div className="flex-1 min-h-[400px]">
          {isAuthRunning && !isAuthorized && (
            <RawTerminal processId={`auth-${selectedWs.id}`} workerUuid={workerUuid} natsPublish={natsPublish} natsSubscribe={natsSubscribe} />
          )}

          {isRunning && isAuthorized && agentId ? (
            <AgentTerminal agentUuid={agentId} natsPublish={natsPublish} natsSubscribe={natsSubscribe} />
          ) : isRunning && isAuthorized && !agentId ? (
            <div className="h-full flex items-center justify-center border border-gray-800 rounded bg-black text-gray-500 font-mono text-sm">
              Awaiting Agent Identity via JetStream...
            </div>
          ) : !isAuthRunning && (
            <div className="h-full flex items-center justify-center border border-gray-800 rounded bg-black text-gray-600 font-mono text-sm">
              {isAuthorized ? 'Workspace stopped. Click Start to connect.' : 'Workspace unauthorized. Click Authenticate to begin device flow.'}
            </div>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="h-full w-full bg-gray-950 overflow-y-auto">
      {view === 'list' && renderList()}
      {view === 'create' && renderCreate()}
      {view === 'details' && renderDetails()}
    </div>
  );
};

export function mount(el: HTMLElement, props: any) {
  const root = createRoot(el);
  root.render(<CodexPlugin {...props} />);
  return () => root.unmount();
}
