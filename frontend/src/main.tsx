import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import '@fontsource/im-fell-english'
import '@fontsource/im-fell-english/400-italic.css'
import '@fontsource-variable/literata/opsz.css'
import '@fontsource-variable/literata/opsz-italic.css'
import '@fontsource/courier-prime'
import '@fontsource/courier-prime/700.css'
import './index.css'
import './reader.css'
import App from './App.tsx'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
