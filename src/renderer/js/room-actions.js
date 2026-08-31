import { $, showScreen } from './core/dom.js'
import { toast } from './core/toast.js'
import { state } from './core/state.js'
import { disconnectManually } from './websocket.js'
import { stopSharing } from './webrtc/capture.js'
import { stopCamera, closeCamViewPeer } from './webrtc/camera.js'
import { renderCameraTiles } from './camera-tiles.js'
import { closeVoicePeer } from './voice/peers.js'
import { destroyMicPipeline } from './voice/noise-suppression.js'
import { stopSpeakingLoop, clearAllVoiceAnalysers } from './voice/speaking-detection.js'
import { stopShareAudioDuck } from './share-audio-duck.js'
import { closeParticipantVolumePopover } from './voice/volume.js'
import { resetChat } from './chat/chat.js'

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
  renderCameraTiles()

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
  destroyMicPipeline()
  state.localMicStream = null
  state.localMicInputStream = null
  stopSpeakingLoop()
  stopShareAudioDuck()
  clearAllVoiceAnalysers()
  state.speaking.clear()
  state.participantVolumes = {}
  state.participantLastVolume = {}
  closeParticipantVolumePopover()
  // A conversa não é guardada nesta máquina (ver o cabeçalho de
  // js/chat/chat.js): saindo da sala, some da tela também. Ela continua
  // no servidor por alguns minutos — voltar ao mesmo código a traz de volta.
  resetChat()
  $('stage-grid').innerHTML = ''
  $('stage-empty').classList.remove('hidden')
  $('stage-grid').classList.add('hidden')
  $('participants-list').innerHTML = ''
  showScreen('login')
}
