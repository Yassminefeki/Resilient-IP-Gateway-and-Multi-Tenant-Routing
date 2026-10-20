import { Component, type ReactNode, type ErrorInfo } from 'react'

interface Props {
  children: ReactNode
}

interface State {
  hasError: boolean
  error: Error | null
}

export class ErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props)
    this.state = { hasError: false, error: null }
  }

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error }
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    console.error('Uncaught error in CloudPulse dashboard UI:', error, errorInfo)
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="min-h-screen flex items-center justify-center p-6 bg-[#F8F6F9] text-[#170B1B]">
          <div className="max-w-lg w-full rounded-2xl p-8 border border-rose-300 bg-white shadow-xl">
            <div className="flex items-center gap-3 text-rose-700 mb-4">
              <span className="material-symbols-outlined text-[28px]">error</span>
              <h2 className="text-lg font-bold">CloudPulse Console Runtime Error</h2>
            </div>
            <p className="text-xs text-[#827787] mb-4">
              An unexpected exception was encountered while rendering the infrastructure workspace.
            </p>
            <div className="p-3 rounded-lg font-mono text-xs bg-[#170B1B] text-rose-300 mb-6 overflow-x-auto">
              {this.state.error?.message || 'Unknown runtime error'}
            </div>
            <div className="flex gap-3">
              <button
                onClick={() => {
                  this.setState({ hasError: false, error: null })
                  window.location.reload()
                }}
                className="px-4 py-2 rounded-xl text-xs font-semibold text-white bg-[#2D0035] hover:bg-[#3D0346] transition-all"
              >
                Reload Console
              </button>
              <button
                onClick={() => {
                  sessionStorage.clear()
                  window.location.reload()
                }}
                className="px-4 py-2 rounded-xl text-xs font-medium text-[#827787] hover:text-[#170B1B] border border-[#E8E0EA] bg-[#F8F6F9]"
              >
                Clear Session &amp; Re-login
              </button>
            </div>
          </div>
        </div>
      )
    }

    return this.props.children
  }
}
