import React, { useState, useEffect } from 'react';

interface SyncMonitorProps {
  isQuotaExceeded: boolean;
  user: any;
  isChannelReady: boolean;
  lastUpdate: number;
  latency: number | null;
}

const SyncMonitor: React.FC<SyncMonitorProps> = ({ isQuotaExceeded, user, isChannelReady, lastUpdate, latency }) => {
  const [insight, setInsight] = useState<string>('Monitoring clinical data stream...');

  useEffect(() => {
    // FIX #7: Deterministic logic instead of AI calls
    let status = 'Connection stable.';
    
    if (isQuotaExceeded) {
      status = 'Network capacity reached. Real-time updates may be delayed.';
    } else if (latency !== null && latency > 5000) {
      status = 'Significant network latency detected. Check connection.';
    } else if (!isChannelReady) {
      status = 'Local communication channel initializing...';
    } else if (!lastUpdate) {
      status = 'Waiting for initial simulation data...';
    } else {
      const secondsSinceUpdate = (Date.now() - lastUpdate) / 1000;
      if (secondsSinceUpdate < 10) {
        status = 'Clinical data stream is active and synchronized.';
      } else if (secondsSinceUpdate < 60) {
        status = 'Connection maintained. Awaiting next update.';
      } else {
        status = 'Data stream idle. Waiting for facilitator activity.';
      }
    }
    
    setInsight(status);
  }, [isQuotaExceeded, !!user, isChannelReady, lastUpdate, latency]);

  return (
    <div className="mt-8 p-6 bg-white/5 rounded-3xl border border-white/10 backdrop-blur-xl max-w-sm w-full">
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-3">
          <div className={`w-2 h-2 rounded-full ${isQuotaExceeded ? 'bg-red-500 animate-pulse' : 'bg-emerald-500'}`}></div>
          <span className="text-[10px] font-black text-slate-500 uppercase tracking-[0.2em]">
            Clinical Sync Status
          </span>
        </div>
        {latency !== null && (
          <span className={`text-[8px] font-black uppercase tracking-widest ${latency < 500 ? 'text-emerald-500' : latency < 2000 ? 'text-amber-500' : 'text-red-500'}`}>
            {latency}ms
          </span>
        )}
      </div>
      <p className="text-xs text-slate-300 font-medium leading-relaxed italic">
        "{insight}"
      </p>
    </div>
  );
};

export default SyncMonitor;
