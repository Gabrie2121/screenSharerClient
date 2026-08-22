import { $ } from './core/dom.js'
import { state } from './core/state.js'
import { sendWS } from './websocket.js'

/* ═══════════════════════════════════════════════════════════════
   PING — latência com o servidor (barrinhas + ms)
═══════════════════════════════════════════════════════════════ */
export function startPing() {
  stopPing()
  const tick = () => {
    if (state.ws?.readyState !== WebSocket.OPEN) return
    state.pingWaiting = true
    sendWS({ type: 'ping', payload: { t: Date.now() } })
  }
  tick()
  state.pingInterval = setInterval(tick, 3000)
}

export function stopPing() {
  clearInterval(state.pingInterval)
  state.pingInterval = null
  updatePingUI(null)
}

export function handlePong(payload) {
  state.pingWaiting = false
  const sentAt = payload?.t
  if (!sentAt) return
  updatePingUI(Date.now() - sentAt)
}

const PING_HISTORY_MAX = 20 // ~1min de histórico (ping a cada 3s)

function updatePingUI(ms) {
  const box = $('ping-box')
  const msEl = $('ping-ms')
  if (ms == null) {
    box.dataset.level = '0'
    msEl.textContent = '-- ms'
    state.pingHistory = []
    updatePingDetail()
    return
  }
  msEl.textContent = `${ms} ms`
  let level = 4
  if (ms > 400) level = 1
  else if (ms > 200) level = 2
  else if (ms > 100) level = 3
  box.dataset.level = String(level)

  state.pingHistory.push(ms)
  if (state.pingHistory.length > PING_HISTORY_MAX) state.pingHistory.shift()
  updatePingDetail()
}

// Popover de detalhe (hover no ping-box) — mantido atualizado mesmo
// escondido, é só CSS (:hover) que decide quando mostrar.
function updatePingDetail() {
  const history = state.pingHistory
  const now = history[history.length - 1]

  $('ping-detail-now').textContent = now != null ? `${now} ms` : '-- ms'
  if (history.length > 0) {
    const avg = Math.round(history.reduce((a, b) => a + b, 0) / history.length)
    $('ping-detail-avg').textContent = `${avg} ms`
    $('ping-detail-minmax').textContent = `${Math.min(...history)} / ${Math.max(...history)} ms`
  } else {
    $('ping-detail-avg').textContent = '-- ms'
    $('ping-detail-minmax').textContent = '-- / -- ms'
  }

  const svg = $('ping-graph')
  if (history.length < 2) {
    svg.innerHTML = ''
    return
  }
  const w = 100, h = 28, pad = 2
  const max = Math.max(...history)
  const min = Math.min(...history)
  const range = Math.max(max - min, 1) // evita divisão por zero com ping constante
  const points = history.map((v, i) => {
    const x = (i / (history.length - 1)) * w
    const y = h - pad - ((v - min) / range) * (h - pad * 2)
    return `${x.toFixed(1)},${y.toFixed(1)}`
  }).join(' ')
  svg.innerHTML = `<polyline points="${points}" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round" stroke-linecap="round" />`
}
