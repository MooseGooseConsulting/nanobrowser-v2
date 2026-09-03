import { useHub } from './useHub';

const DOT: Record<string, string> = {
  connecting: 'bg-amber-400',
  connected: 'bg-emerald-500',
  disconnected: 'bg-rose-500',
};

export default function App() {
  const hub = useHub();

  return (
    <div className="flex h-screen flex-col bg-paper text-ink">
      <header className="flex items-center justify-between border-b border-black/10 px-4 py-3">
        <h1 className="text-sm font-semibold tracking-tight">nanobrowser</h1>
        <div className="flex items-center gap-2 text-xs text-black/60" title={hub.status}>
          <span className={`size-2 rounded-full ${DOT[hub.status]}`} aria-hidden />
          <span data-testid="hub-status">{hub.status}</span>
          {hub.extensionVersion ? <span className="tabular-nums">v{hub.extensionVersion}</span> : null}
        </div>
      </header>
      <main className="flex-1 overflow-auto p-4 text-sm text-black/60">
        <p>Scaffold. The run log and the Leader/Follower transcript land here.</p>
      </main>
    </div>
  );
}
