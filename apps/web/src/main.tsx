import './styles.css'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './app/App.tsx'
import { session } from './app/session.ts'
import { theme } from './app/theme.ts'

// Both run before the first render: the theme to avoid a flash, the session to take the token
// out of the address bar as early as possible.
theme.init()
session.init()

const root = document.getElementById('root')
if (!root) throw new Error('missing #root element')
createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
