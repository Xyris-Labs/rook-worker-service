import React, { useState, useEffect, useRef } from 'react';
import { createRoot } from 'react-dom/client';

interface TerminalLine { text: string; color: string; isStream?: boolean }
interface Workspace { id: string; name: string; engine: string; status: string; agentUuid?: string; }

const AgentTerminal = ({ agentUuid, natsPublish, natsSubscribe }: any) => {
  const [lines, setLines] = useState<TerminalLine[]>([{text: `[SYSTEM] Connected to Agent JetStream: ${agentUuid}`, color: 'text-blue-400'}]);
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
    if (!natsSubscribe || !agentUuid) return;
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
          appendLine(`\n[AGENT ERROR] ${payload.error?.message || "Unknown Error"}`, 'text-red-500 font-bold');
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

export const CodexPlugin = ({ uuid: workerUuid, natsPublish, natsSubscribe }: any) => {
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [view, setView] = useState<'list' | 'create' | 'details'>('list');
  const [selectedWsId, setSelectedWsId] = useState<string | null>(null);

  const [newName, setNewName] = useState('');
  const [newEngine, setNewEngine] = useState('codex');
  const [newProfile, setNewProfile] = useState('profile.codex.default');

  // Reactive State Subscription (No Polling)
  useEffect(() => {
    if (!natsSubscribe || !natsPublish) return;

    const sub = natsSubscribe(`worker.${workerUuid}.state`, (data: string) => {
      try { setWorkspaces(JSON.parse(data)); } catch(e) {}
    });

    // Intercept agent UUID broadcast to update local state mapping
    const logSub = natsSubscribe(`worker.${workerUuid}.*.stdout`, (data: string, err: any, msg: any) => {
      const match = data.match(/\[SYSTEM_EVENT:AGENT_ONLINE:(.+)\]/);
      if (match && msg.subject) {
        const wsId = msg.subject.split('.')[2];
        setWorkspaces(prev => prev.map(ws => ws.id === wsId ? { ...ws, agentUuid: match[1] } : ws));
      }
    });

    // Request initial state on mount
    natsPublish(`worker.${workerUuid}.request_state`, {}, {
      callback: (err: any, msg: any) => {
        if (msg) try { setWorkspaces(JSON.parse(new TextDecoder().decode(msg.data))); } catch(e) {}
      }
    });

    return () => { sub.unsubscribe(); logSub.unsubscribe(); };
  }, [natsSubscribe, natsPublish, workerUuid]);

  const activeWs = workspaces.find(w => w.id === selectedWsId);

  const handleCreate = (e: React.FormEvent) => {
    e.preventDefault();
    natsPublish(`worker.${workerUuid}.control`, {
      action: 'create', workspaceId: `ws-${Date.now()}`, name: newName, engine: newEngine, profileId: newProfile === 'none' ? null : newProfile
    });
    setNewName(''); setView('list');
  };

  return (
    <div className="flex h-full w-full text-gray-200 font-sans bg-gray-950 overflow-hidden">
      <div className="w-80 flex flex-col border-r border-gray-800 bg-gray-900">
        <div className="p-4 border-b border-gray-800">
          <h2 className="text-lg font-bold text-white tracking-wide">WORKSPACE MANAGER</h2>
          <p className="text-xs text-gray-500 font-mono mt-1">ID: {workerUuid.split('-')[0]}</p>
        </div>

        <div className="p-4 border-b border-gray-800">
          <button onClick={() => setView('create')} className="w-full bg-blue-600 hover:bg-blue-500 text-white font-bold py-2 rounded text-sm transition-colors">New Workspace</button>
        </div>

        <div className="flex-1 overflow-y-auto p-4">
          {workspaces.length === 0 ? <div className="text-xs text-gray-600 italic">No workspaces exist.</div> : null}
          {workspaces.map(ws => (
            <div key={ws.id} onClick={() => { setSelectedWsId(ws.id); setView('details'); }} className={`p-3 mb-2 rounded cursor-pointer border transition-colors ${selectedWsId === ws.id ? 'bg-blue-900/20 border-blue-500/50' : 'bg-black border-gray-800 hover:border-gray-600'}`}>
              <div className="flex items-center justify-between mb-1">
                <span className="text-sm font-bold text-gray-200">{ws.name}</span>
                <div className={`w-2 h-2 rounded-full ${ws.status === 'running' ? 'bg-green-500' : ws.status === 'stopped' ? 'bg-red-500' : 'bg-yellow-500'}`}></div>
              </div>
              <div className="text-[10px] text-gray-500 font-mono truncate uppercase">{ws.status}</div>
            </div>
          ))}
        </div>
      </div>

      <div className="flex-1 flex flex-col bg-black">
        {view === 'create' ? (
          <div className="p-6 max-w-lg mx-auto w-full mt-10">
            <h2 className="text-2xl font-bold text-white mb-6">Create Environment</h2>
            <form onSubmit={handleCreate} className="space-y-4">
              <div>
                <label className="block text-xs font-bold text-gray-400 uppercase mb-2">Workspace Name</label>
                <input required type="text" value={newName} onChange={e => setNewName(e.target.value)} className="w-full bg-gray-900 border border-gray-800 text-white rounded p-3 outline-none" />
              </div>
              <div>
                <label className="block text-xs font-bold text-gray-400 uppercase mb-2">Engine</label>
                <select value={newEngine} onChange={e => setNewEngine(e.target.value)} className="w-full bg-gray-900 border border-gray-800 text-white rounded p-3 outline-none">
                  <option value="codex">Codex CLI</option>
                </select>
              </div>
              <div>
                <label className="block text-xs font-bold text-gray-400 uppercase mb-2">Librarian Profile</label>
                <select value={newProfile} onChange={e => setNewProfile(e.target.value)} className="w-full bg-gray-900 border border-gray-800 text-white rounded p-3 outline-none">
                  <option value="profile.codex.default">profile.codex.default</option>
                  <option value="none">None (Requires Manual Auth)</option>
                </select>
              </div>
              <button type="submit" className="w-full bg-blue-600 text-white font-bold py-3 rounded mt-4">Initialize Workspace</button>
            </form>
          </div>
        ) : activeWs ? (
          <div className="p-6 h-full flex flex-col max-w-5xl mx-auto w-full">
            <div className="bg-gray-900 border border-gray-800 rounded-lg p-6 mb-6 flex justify-between items-start">
              <div>
                <h2 className="text-2xl font-bold text-white mb-1">{activeWs.name}</h2>
                <p className="text-xs font-mono text-gray-500">ID: {activeWs.id} | Engine: {activeWs.engine}</p>
              </div>
              <div className="flex flex-col items-end gap-2">
                <div className="flex gap-2">
                  <button onClick={() => natsPublish(`worker.${workerUuid}.control`, { action: 'delete', workspaceId: activeWs.id })} className="px-3 py-1 text-xs font-bold text-red-500 hover:bg-red-500/10 rounded border border-transparent hover:border-red-500/30">Delete</button>
                  {activeWs.status === 'running' ? (
                    <button onClick={() => natsPublish(`worker.${workerUuid}.control`, { action: 'stop', workspaceId: activeWs.id })} className="px-4 py-1 text-sm font-bold bg-red-600 hover:bg-red-500 text-white rounded">Stop Agent</button>
                  ) : (
                    <button onClick={() => natsPublish(`worker.${workerUuid}.control`, { action: 'start', workspaceId: activeWs.id })} className="px-4 py-1 text-sm font-bold bg-green-600 hover:bg-green-500 text-white rounded">Boot Agent</button>
                  )}
                </div>
              </div>
            </div>

            <div className="flex-1 min-h-[400px]">
              {activeWs.status === 'running' && activeWs.agentUuid ? (
                <AgentTerminal agentUuid={activeWs.agentUuid} natsPublish={natsPublish} natsSubscribe={natsSubscribe} />
              ) : (
                <div className="h-full flex items-center justify-center border border-gray-800 rounded bg-black text-gray-600 font-mono text-sm">
                  {activeWs.status === 'running' ? 'Awaiting Agent Identity Broadcast...' : 'Agent offline. Click Boot Agent to connect.'}
                </div>
              )}
            </div>
          </div>
        ) : (
          <div className="flex-1 flex items-center justify-center text-gray-600 font-mono text-sm">Select a workspace to manage.</div>
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
