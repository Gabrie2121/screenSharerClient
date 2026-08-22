import { $ } from './core/dom.js'
import { state } from './core/state.js'
import { sendWS } from './websocket.js'

/* ═══════════════════════════════════════════════════════════════
   SNAPSHOT PERIÓDICO — pra prévia de quem não está assistindo (sidebar)
   Manda um JPEG pequeno pra sala ao começar a compartilhar e depois a
   cada 3min. Usa um <video> escondido dedicado (#snapshot-source-video)
   em vez do vídeo da autovisualização, porque a autovisualização só
   existe quando a pessoa ativa aquela preferência opcional — o snapshot
   precisa funcionar sempre, independente disso.
═══════════════════════════════════════════════════════════════ */
const SNAPSHOT_INTERVAL_MS = 3 * 60 * 1000

export function startSnapshotLoop() {
  stopSnapshotLoop()
  const srcVideo = $('snapshot-source-video')
  srcVideo.srcObject = state.localStream
  srcVideo.play().catch(() => {})

  // Espera ter pelo menos um frame decodificado antes do primeiro snapshot
  const sendFirst = () => {
    captureAndSendSnapshot()
    srcVideo.removeEventListener('loadeddata', sendFirst)
  }
  srcVideo.addEventListener('loadeddata', sendFirst)

  state.snapshotInterval = setInterval(captureAndSendSnapshot, SNAPSHOT_INTERVAL_MS)
}

export function stopSnapshotLoop() {
  clearInterval(state.snapshotInterval)
  state.snapshotInterval = null
  const srcVideo = $('snapshot-source-video')
  srcVideo.srcObject = null
}

function captureAndSendSnapshot() {
  if (!state.sharing || !state.localStream) return
  const srcVideo = $('snapshot-source-video')
  if (!srcVideo.videoWidth) return // ainda sem frame decodificado

  try {
    const canvas = document.createElement('canvas')
    canvas.width = 160
    canvas.height = 90
    canvas.getContext('2d').drawImage(srcVideo, 0, 0, canvas.width, canvas.height)
    const image = canvas.toDataURL('image/jpeg', 0.5)
    sendWS({ type: 'screen-snapshot', payload: { image } })
  } catch (err) {
    console.warn('[SNAPSHOT] Falha ao gerar prévia da tela:', err)
  }
}
