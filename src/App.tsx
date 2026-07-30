import { GlobeCanvas } from './components/GlobeCanvas'
import { Hud } from './components/Hud'
import './App.css'

export default function App() {
  return (
    <main className="app">
      <GlobeCanvas />
      <Hud />
    </main>
  )
}
