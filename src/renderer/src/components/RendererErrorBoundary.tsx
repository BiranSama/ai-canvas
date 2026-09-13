import { Component, type ReactNode } from 'react'
import { RefreshCw, ShieldCheck } from 'lucide-react'

interface RendererErrorBoundaryProps {
  readonly children: ReactNode
}

interface RendererErrorBoundaryState {
  readonly failed: boolean
}

interface WorkspaceRecoveryViewProps {
  readonly title: string
  readonly message: string
  readonly actionLabel: string
  readonly onAction: () => void
}

export function WorkspaceRecoveryView({ title, message, actionLabel, onAction }: WorkspaceRecoveryViewProps): ReactNode {
  return (
    <main className="renderer-error-shell" role="alert" aria-labelledby="renderer-error-title">
      <section className="renderer-error-card">
        <span className="renderer-error-mark" aria-hidden="true"><ShieldCheck size={20} /></span>
        <span className="settings-kicker">工作区恢复</span>
        <h1 id="renderer-error-title">{title}</h1>
        <p>{message}</p>
        <button type="button" onClick={onAction}><RefreshCw size={14} />{actionLabel}</button>
      </section>
    </main>
  )
}

export class RendererErrorBoundary extends Component<RendererErrorBoundaryProps, RendererErrorBoundaryState> {
  public state: RendererErrorBoundaryState = { failed: false }

  public static getDerivedStateFromError(): RendererErrorBoundaryState {
    return { failed: true }
  }

  public componentDidCatch(): void {
    // Do not include raw errors here: Provider and project failures may contain
    // private local context. The development console already owns stack capture.
    console.error('AI Canvas recovered from an unexpected renderer error.')
  }

  public render(): ReactNode {
    if (!this.state.failed) return this.props.children

    return (
      <WorkspaceRecoveryView
        title="界面遇到了一点问题"
        message="项目与已保存设置仍保留在本机。重新载入只会恢复工作台，不会自动发起生成、重试任务或增加费用。"
        actionLabel="重新载入工作台"
        onAction={() => globalThis.location.reload()}
      />
    )
  }
}
