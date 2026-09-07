import React from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import { installClientErrorReporter } from './lib/clientErrorReporter'
import './style.css'

installClientErrorReporter()

createRoot(document.getElementById('root')).render(<App />)
