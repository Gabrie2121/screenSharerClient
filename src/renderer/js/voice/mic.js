import { $ } from '../core/dom.js'
import { appLog } from '../core/logger.js'
import { toast } from '../core/toast.js'
import { playSound } from '../core/sounds.js'
import { state, MIC_MUTED_KEY, MIC_DEVICE_KEY } from '../core/state.js'
import {
  createNoiseSuppressedStream, prepareNoiseSuppression, destroyNoiseSuppression,
} from './noise-suppression.js'
import { setupLocalVoiceAnalyser } from './speaking-detection.js'
import { sendWS } from '../websocket.js'
import { renderParticipants } from '../participants.js'

/* ═══════════════════════════════════════════════════════════════
   MICROFONE — captura, troca de dispositivo, mutar/desmutar
═══════════════════════════════════════════════════════════════ */
// Captura o microfone uma única vez por sessão de sala — a mesma
// MediaStreamTrack é adicionada em todas as conexões de voz.
export async function ensureLocalMicStream() {
  if (state.localMicStream) return state.localMicStream
  let inputStream = null
  try {
    const constraints = {
      audio: state.micDeviceId ? { deviceId: { exact: state.micDeviceId } } : true,
      video: false,
    }
    inputStream = await navigator.mediaDevices.getUserMedia(constraints)
    await prepareNoiseSuppression()
    const stream = await createNoiseSuppressedStream(inputStream)
    stream.getAudioTracks().forEach(t => { t.enabled = !state.micMuted })
    state.localMicInputStream = inputStream
    state.localMicStream = stream
    setupLocalVoiceAnalyser(inputStream)
    appLog('INFO', 'Microfone capturado — chat de voz ativo')
    return stream
  } catch (err) {
    inputStream?.getTracks().forEach(t => t.stop())
    appLog('WARN', `Não foi possível acessar o microfone: ${err.message}`)
    toast('Não foi possível acessar o microfone. O chat de voz ficará desativado.')
    return null
  }
}

export async function switchMicDevice(deviceId) {
  state.micDeviceId = deviceId
  localStorage.setItem(MIC_DEVICE_KEY, deviceId)
  if (!state.localMicStream) return // será usado na próxima vez que ensureLocalMicStream rodar

  let newInputStream = null
  try {
    const constraints = { audio: deviceId ? { deviceId: { exact: deviceId } } : true, video: false }
    newInputStream = await navigator.mediaDevices.getUserMedia(constraints)
    const previousStream = state.localMicStream
    const previousInputStream = state.localMicInputStream
    destroyNoiseSuppression()
    await prepareNoiseSuppression()
    const newStream = await createNoiseSuppressedStream(newInputStream)
    const newTrack = newStream.getAudioTracks()[0]
    newTrack.enabled = !state.micMuted

    // Troca o track em todas as conexões de voz já abertas, sem precisar
    // renegociar (replaceTrack é instantâneo do ponto de vista do SDP).
    for (const pc of Object.values(state.voicePeers)) {
      const sender = pc.getSenders().find(s => s.track && s.track.kind === 'audio')
      if (sender) await sender.replaceTrack(newTrack)
    }

    previousInputStream?.getTracks().forEach(t => t.stop())
    previousStream?.getTracks().forEach(t => t.stop())
    state.localMicInputStream = newInputStream
    state.localMicStream = newStream
    setupLocalVoiceAnalyser(newInputStream)
    appLog('INFO', 'Microfone alterado')
  } catch (err) {
    newInputStream?.getTracks().forEach(t => t.stop())
    appLog('ERROR', `Falha ao trocar de microfone: ${err.message}`)
    toast('Não foi possível usar esse microfone.')
  }
}

// ── Mutar/desmutar meu microfone (botão da sidebar + toggle nas
//    Configurações, ambos controlam o mesmo estado) ──
export function applyMicMuteState() {
  state.localMicStream?.getAudioTracks().forEach(t => { t.enabled = !state.micMuted })

  const micBtn = $('btn-toggle-mic')
  micBtn.classList.toggle('muted', state.micMuted)
  micBtn.title = state.micMuted ? 'Ativar microfone' : 'Mutar microfone'
  micBtn.querySelector('.mic-icon').textContent = state.micMuted ? '🔇' : '🎤'

  const chk = $('chk-mic-muted')
  if (chk) chk.checked = state.micMuted
}

// Mutar sem retorno nenhum é como a pessoa acaba falando alguns segundos
// para o vazio — o som confirma sem precisar olhar para o botão.
function setMicMuted(muted) {
  state.micMuted = muted
  localStorage.setItem(MIC_MUTED_KEY, String(muted))
  applyMicMuteState()
  playSound(muted ? 'mic-mute' : 'mic-unmute')
  announceMicState()
  renderParticipants() // atualiza o meu próprio ícone na lista
}

// Avisa a sala se estou mudo. Chamado ao alternar e logo depois do
// 'room-info' (ver announceMicState em websocket.js): o mudo é lembrado
// entre sessões via localStorage, então quem entra já mutado precisa
// anunciar isso — o servidor assume False até ser corrigido.
export function announceMicState() {
  sendWS({ type: 'mic-state', payload: { muted: state.micMuted } })
}

$('btn-toggle-mic').onclick = async () => {
  if (!state.localMicStream) await ensureLocalMicStream()
  setMicMuted(!state.micMuted)
}

$('chk-mic-muted').onchange = () => setMicMuted($('chk-mic-muted').checked)
