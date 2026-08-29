import { $ } from '../core/dom.js'
import { setIcon } from '../core/icons.js'
import { appLog } from '../core/logger.js'
import { toast } from '../core/toast.js'
import { playSound } from '../core/sounds.js'
import { state, MIC_MUTED_KEY, MIC_DEVICE_KEY } from '../core/state.js'
import {
  buildMicPipeline, replaceMicInput, micCaptureConstraints,
} from './noise-suppression.js'
import { setupLocalVoiceAnalyser } from './speaking-detection.js'
import { sendWS } from '../websocket.js'
import { renderParticipants } from '../participants.js'

/* ═══════════════════════════════════════════════════════════════
   MICROFONE — captura, troca de dispositivo, mutar/desmutar

   `state.localMicInputStream` é a captura crua do getUserMedia;
   `state.localMicStream` é a SAÍDA da cadeia de áudio (ver
   voice/noise-suppression.js) e é o que vai pros peers. Fora do modo de
   emergência (Web Audio indisponível), a track de saída é criada uma única
   vez e nunca mais muda — trocar de microfone no meio de uma conversa não
   renegocia nada com ninguém.
═══════════════════════════════════════════════════════════════ */

// Captura o microfone uma única vez por sessão de sala.
export async function ensureLocalMicStream() {
  if (state.localMicStream) return state.localMicStream
  let inputStream = null
  try {
    inputStream = await navigator.mediaDevices.getUserMedia(micCaptureConstraints(state.micDeviceId))
    state.localMicInputStream = inputStream

    const stream = await buildMicPipeline(inputStream)
    stream.getAudioTracks().forEach(t => { t.enabled = !state.micMuted })
    state.localMicStream = stream

    // A análise de "quem está falando" lê a SAÍDA da cadeia, não a captura
    // crua: assim o anel verde acende pelo que os outros realmente ouvem.
    // Lendo o cru, ruído de fundo que o RNNoise apagou ainda acendia o
    // indicador — a pessoa "falando" em silêncio.
    setupLocalVoiceAnalyser(stream)
    appLog('INFO', 'Microfone capturado — chat de voz ativo')
    return stream
  } catch (err) {
    inputStream?.getTracks().forEach(t => t.stop())
    state.localMicInputStream = null
    appLog('WARN', `Não foi possível acessar o microfone: ${err.message}`)
    toast('Não foi possível acessar o microfone. O chat de voz ficará desativado.')
    return null
  }
}

export async function switchMicDevice(deviceId) {
  state.micDeviceId = deviceId
  localStorage.setItem(MIC_DEVICE_KEY, deviceId)
  if (!state.localMicStream) return // será usado na próxima vez que ensureLocalMicStream rodar

  const previousInput = state.localMicInputStream
  // Modo de emergência: sem Web Audio a cadeia devolveu a própria captura,
  // então a track que os peers recebem é a crua e precisa ser trocada de
  // verdade. Com a cadeia montada isso nunca acontece.
  const rawMode = state.localMicStream === state.localMicInputStream

  let newInput = null
  try {
    newInput = await navigator.mediaDevices.getUserMedia(micCaptureConstraints(deviceId))

    if (rawMode) {
      const newTrack = newInput.getAudioTracks()[0]
      newTrack.enabled = !state.micMuted
      for (const pc of Object.values(state.voicePeers)) {
        const sender = pc.getSenders().find(s => s.track && s.track.kind === 'audio')
        if (sender) await sender.replaceTrack(newTrack)
      }
      state.localMicStream = newInput
      setupLocalVoiceAnalyser(newInput)
    } else {
      // Caminho normal: só a origem da cadeia muda. A track de saída, os
      // senders e o analisador continuam válidos.
      replaceMicInput(newInput)
    }

    state.localMicInputStream = newInput
    // Só para a captura antiga DEPOIS que a nova já está no ar — parar
    // antes deixaria um buraco de áudio (ou silêncio permanente, se a
    // captura nova falhasse).
    previousInput?.getTracks().forEach(t => t.stop())
    appLog('INFO', 'Microfone alterado')
  } catch (err) {
    newInput?.getTracks().forEach(t => t.stop())
    appLog('ERROR', `Falha ao trocar de microfone: ${err.message}`)
    // A captura anterior nunca foi parada, então o microfone antigo
    // continua funcionando normalmente — o erro não deixa ninguém mudo.
    toast('Não foi possível usar esse microfone. O anterior continua ativo.')
  }
}

// ── Mutar/desmutar meu microfone (botão da sidebar + toggle nas
//    Configurações, ambos controlam o mesmo estado) ──
export function applyMicMuteState() {
  state.localMicStream?.getAudioTracks().forEach(t => { t.enabled = !state.micMuted })

  const micBtn = $('btn-toggle-mic')
  micBtn.classList.toggle('muted', state.micMuted)
  micBtn.title = state.micMuted ? 'Ativar microfone' : 'Mutar microfone'
  setIcon(micBtn.querySelector('.icon-box'), state.micMuted ? 'mic-off' : 'mic')

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
