import { Component, type ReactNode } from 'react'
import { t } from '../i18n'

// A crash while rendering one page shouldn't leave a blank window: show what happened
// and a way out (reload, or copy a report to send).
export class ErrorBoundary extends Component<{ children: ReactNode }, { error?: Error }> {
  state: { error?: Error } = {}

  static getDerivedStateFromError(error: Error) {
    return { error }
  }

  render() {
    const { error } = this.state
    if (!error) return this.props.children
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 px-8 text-center">
        <div className="text-[16px] font-semibold">{t('crash.title')}</div>
        <pre className="max-h-40 max-w-2xl overflow-auto whitespace-pre-wrap rounded-lg bg-panel px-3 py-2 text-left text-[12px] text-muted selectable">{error.message}</pre>
        <div className="flex gap-2">
          <button className="rounded-lg bg-accent-2 px-4 py-2 text-[13px] font-medium text-white hover:bg-accent" onClick={() => location.reload()}>
            {t('crash.reload')}
          </button>
          <button
            className="rounded-lg border border-line px-4 py-2 text-[13px] text-muted hover:bg-hover hover:text-fg"
            onClick={() => void window.api?.diagnostics().then((d) => navigator.clipboard.writeText(`${d}\n\n${error.stack ?? error.message}`))}
          >
            {t('crash.copy')}
          </button>
        </div>
      </div>
    )
  }
}
