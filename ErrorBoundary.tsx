import React, { Component, ErrorInfo, ReactNode } from 'react';
import { AlertTriangle, RefreshCcw, Home } from 'lucide-react';

interface Props {
  children: ReactNode;
  fallback?: ReactNode;
}

interface State {
  hasError: boolean;
  error: Error | null;
}

export class ErrorBoundary extends (Component as any) {
  constructor(props: Props) {
    super(props);
    this.state = {
      hasError: false,
      error: null
    };
  }

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    console.error('Uncaught error:', error, errorInfo);
  }

  handleReset = () => {
    this.setState({ hasError: false, error: null });
    window.location.reload();
  };

  handleGoHome = () => {
    this.setState({ hasError: false, error: null });
    window.location.href = '/';
  };

  render() {
    if (this.state.hasError) {
      if (this.props.fallback) {
        return this.props.fallback;
      }

      return (
        <div className="min-h-screen bg-slate-950 flex items-center justify-center p-4 font-sans text-slate-100">
          <div className="max-w-md w-full bg-slate-900 rounded-3xl shadow-2xl border border-white/10 p-8 text-center backdrop-blur-xl">
            <div className="w-20 h-20 bg-red-500/10 rounded-full flex items-center justify-center mx-auto mb-6 border border-red-500/20">
              <AlertTriangle className="w-10 h-10 text-red-500" />
            </div>
            
            <h1 className="text-2xl font-black text-white mb-2 uppercase tracking-tighter">System Interruption</h1>
            <p className="text-slate-400 mb-8 leading-relaxed text-sm font-medium">
              SimVeritas encountered a critical runtime error. The neural link has been safely disconnected to prevent data corruption.
            </p>

            <div className="bg-black/40 rounded-2xl p-4 mb-8 text-left border border-white/5 overflow-hidden">
              <p className="text-[10px] font-black text-slate-500 uppercase tracking-[0.2em] mb-2">Error Signature</p>
              <p className="text-xs font-mono text-red-400 break-all line-clamp-3 leading-relaxed">
                {this.state.error?.message || 'Unknown system fault'}
              </p>
            </div>

            <div className="grid grid-cols-2 gap-4">
              <button
                onClick={this.handleReset}
                className="flex items-center justify-center gap-2 px-6 py-4 bg-blue-600 text-white rounded-2xl font-black uppercase tracking-widest text-[10px] hover:bg-blue-500 transition-all active:scale-95 shadow-lg shadow-blue-500/20"
              >
                <RefreshCcw className="w-4 h-4" />
                Reboot
              </button>
              <button
                onClick={this.handleGoHome}
                className="flex items-center justify-center gap-2 px-6 py-4 bg-slate-800 text-slate-300 border border-white/10 rounded-2xl font-black uppercase tracking-widest text-[10px] hover:bg-slate-700 transition-all active:scale-95"
              >
                <Home className="w-4 h-4" />
                Terminal
              </button>
            </div>
            
            <p className="mt-8 text-[10px] text-slate-600 font-black uppercase tracking-[0.2em]">
              SimVeritas Core Security Protocol Active
            </p>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}
