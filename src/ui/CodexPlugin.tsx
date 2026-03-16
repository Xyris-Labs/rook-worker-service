import React, { useState, useEffect, useRef } from 'react';

const CodexPlugin = ({ uuid, natsPublish, natsSubscribe }: any) => {
  const [logs, setLogs] = useState<string[]>([]);
  const logsEndRef = useRef<HTMLDivElement>(null);

  // Listen for streaming logs from the worker's processes
  useEffect(() => {
    if (!natsSubscribe) return;
    const sub = natsSubscribe(`worker.${uuid}.*.stdout`, (data: string) => {
      setLogs(prev => [...prev, data].slice(-200)); // Keep last 200 log entries
    });
    return () => { if (sub && sub.unsubscribe) sub.unsubscribe(); };
  }, [natsSubscribe, uuid]);

  // Auto-scroll terminal
  useEffect(() => {
    logsEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [logs]);

  const handleStart = () => {
    natsPublish(`worker.${uuid}.control`, {
      action: 'start',
      processId: 'codex-main',
      // Testing payload. We can replace with actual 'codex app-server' commands later
      command: ['echo', 'Starting Codex App Server...', '&&', 'sleep', '2', '&&', 'echo', 'Codex Online!'] 
    });
  };

  const handleProvision = () => {
     natsPublish(`worker.${uuid}.control`, {
       action: 'start',
       processId: 'codex-auth',
       authFlow: {
         loginCommand: ['echo', 'Simulating OAuth Flow. Please click the link to authenticate...'],
         targetFile: '/tmp/profile.json',
         runCommand: ['echo', 'Authenticated successfully! Pivoting to main server...']
       }
     });
  };

  return (
    <div className="flex flex-col h-full space-y-4 text-gray-200">
      <div className="flex items-center justify-between border-b border-gray-700 pb-4">
        <div>
          <h2 className="text-xl font-bold text-white">Codex Agent Node</h2>
          <p className="text-xs text-gray-500 font-mono">ID: {uuid}</p>
        </div>
        <div className="flex gap-2">
          <button 
            onClick={handleProvision} 
            className="px-4 py-2 bg-yellow-600/20 text-yellow-500 border border-yellow-500/50 hover:bg-yellow-600/40 text-sm font-bold rounded transition-colors"
          >
            Provision Identity
          </button>
          <button 
            onClick={handleStart} 
            className="px-4 py-2 bg-blue-600 hover:bg-blue-500 text-white text-sm font-bold rounded transition-colors"
          >
            Start Server
          </button>
        </div>
      </div>

      <div className="flex-1 bg-black rounded-lg border border-gray-800 p-4 font-mono text-xs overflow-y-auto min-h-[350px]">
        {logs.length === 0 ? (
          <span className="text-gray-600">Waiting for process output...</span>
        ) : (
          logs.map((log, i) => (
            <div key={i} className="text-green-400 whitespace-pre-wrap">{log}</div>
          ))
        )}
        <div ref={logsEndRef} />
      </div>
    </div>
  );
};

export const mount = CodexPlugin;
export default CodexPlugin;
