import { useState, useEffect } from 'react'
import { restoreToken, getToken } from './api'
import Login from './pages/Login'
import Shell from './pages/Shell'

export default function App() {
  const [authed, setAuthed] = useState(false)

  useEffect(() => {
    if (restoreToken() && getToken()) setAuthed(true)
  }, [])

  if (!authed) return <Login onLogin={() => setAuthed(true)} />
  return <Shell onLogout={() => setAuthed(false)} />
}
