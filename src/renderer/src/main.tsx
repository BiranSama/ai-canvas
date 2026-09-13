import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App'
import { RendererErrorBoundary } from './components/RendererErrorBoundary'
import './styles.css'
import './creation-workbench.css'

const rootElement = document.getElementById('root')
if (rootElement === null) throw new Error('Root element is missing')

createRoot(rootElement).render(
  <StrictMode>
    <RendererErrorBoundary>
      <App />
    </RendererErrorBoundary>
  </StrictMode>
)
