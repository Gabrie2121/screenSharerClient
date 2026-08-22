import { $, showScreen } from './core/dom.js'
import { toast } from './core/toast.js'
import { state } from './core/state.js'
import { disconnectManually } from './websocket.js'
import { stopSharing } from './webrtc/capture.js'
import { stopCamera, closeCamViewPeer } from './webrtc/camera.js'
import { renderCameraStrip } from './camera-strip.js'
import { closeVoicePeer } from './voice/peers.js'
import { destroyNoiseSuppression } from './voice/noise-suppression.js'
import { stopSpeakingLoop, clearAllVoiceAnalysers } from './voice/speaking-detection.js'
import { closeParticipantVolumePopover } from './voice/volume.js'

/* ═══════════════════════════════════════════════════════════════
   COPIAR ID
═══════════════════════════════════════════════════════════════ */
$('btn-copy-id').onclick = () => {
  navigator.clipboard.writeText(state.roomId)
  toast('Código copiado!')
}

/* ═══════════════════════════════════════════════════════════════
   SAIR DA SALA
═══════════════════════════════════════════════════════════════ */
$('btn-leave').onclick = () => {
  // Desarma o auto-reconnect e fecha o socket de propósito — sem isso,
  // uma tentativa já agendada podia disparar depois que a pessoa já tinha
  // saído da sala de propósito.
  disconnectManually()

  stopSharing()

  // Câmera — libera o dispositivo (mesma lógica do microfone abaixo: uma
  // sala nova pode ser em outro computador/dispositivo, não vale segurar a
  // captura) e derruba os dois sentidos.
  stopCamera()
  Object.keys(state.camViewPeers).forEach(uid => closeCamViewPeer(uid))
  state.camPeers = {}
  state.camViewPeers = {}
  state.camStreams = {}
  state.stagedCamId = null
  renderCameraStrip()

  state.watchPeers = {}
  state.sharePeers = {}
  state.users = {}
  state.watching.clear()
  state.connecting.clear()
  state.remoteStreams = {}
  state.focusedId = null
  state.screenSnapshots = {}
  state.viewerQuality = {}
  Object.values(state.statsIntervals).forEach(id => clearInterval(id))
  state.statsIntervals = {}
  if (document.pictureInPictureElement) document.exitPictureInPicture().catch(() => {})

  // Chat de voz — libera o microfone e fecha tudo (uma sala nova pode
  // pedir outro dispositivo, então não vale a pena manter capturado).
  Object.keys(state.voicePeers).forEach(uid => closeVoicePeer(uid))
  state.localMicInputStream?.getTracks().forEach(t => t.stop())
  state.localMicStream?.getTracks().forEach(t => t.stop())
  destroyNoiseSuppression()
  state.localMicStream = null
  state.localMicInputStream = null
  stopSpeakingLoop()
  clearAllVoiceAnalysers()
  state.speaking.clear()
  state.participantVolumes = {}
  state.participantLastVolume = {}
  closeParticipantVolumePopover()
  $('streams-grid').innerHTML = ''
  $('stage-empty').classList.remove('hidden')
  $('streams-grid').classList.add('hidden')
  $('participants-list').innerHTML = ''
  showScreen('login')
}
