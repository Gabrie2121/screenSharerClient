import { $, showScreen } from './core/dom.js'
import { appLog } from './core/logger.js'
import { toast, toastTop, showError, playShareSound } from './core/toast.js'
import { state } from './core/state.js'
import { setLoginButtonsDisabled } from './login.js'
import { startPing, stopPing, handlePong } from './ping.js'
import { renderParticipants, removeUser } from './participants.js'
import { seedParticipantVolume } from './voice/volume.js'
import { removeStreamCard } from './stream-cards.js'
import {
  closeWatchPeer, stopWatchTimeout, handleOffer, handleAnswer,
  handleIceCandidate, applyViewerQuality,
} from './webrtc/screen-share-peers.js'
import {
  initVoiceChat, handleVoiceOffer, handleVoiceAnswer, handleVoiceIceCandidate,
} from './voice/peers.js'
import { clearRemoteVoiceAnalysers } from './voice/speaking-detection.js'

/* ═══════════════════════════════════════════════════════════════
   WEBSOCKET
   Se o servidor cair DEPOIS de já estar na sala, tenta reconectar sozinho a
   cada 5s até voltar (ou até a pessoa sair da sala de propósito — ver
   disconnectManually, chamado pelo botão de sair). Antes de entrar pela
   primeira vez (ver hasEnteredRoom abaixo), uma falha não entra nesse loop
   — só mostra o erro na tela de login e deixa a pessoa tentar de novo
   manualmente.
═══════════════════════════════════════════════════════════════ */

// Entrar por código não fazia nenhuma checagem de conexão — trocava pra
// tela da sala na hora, mesmo que o servidor estivesse fora do ar ou o
// endereço estivesse errado, deixando uma sala vazia e "quebrada" sem
// explicação. Agora só troca de tela quando o WebSocket realmente conecta
// (ver onopen/onclose abaixo) — hasEnteredRoom controla isso.
let hasEnteredRoom = false
let manualDisconnect = false
let reconnectTimer = null
let isReconnecting = false

// Chamado por login.js/enterRoom antes de abrir uma conexão nova.
export function prepareForNewConnection() {
  manualDisconnect = false
  hasEnteredRoom = false
}

// Chamado pelo botão "Sair da sala" — desarma o auto-reconnect e fecha o
// socket de propósito (diferente de uma queda inesperada, que tenta voltar
// sozinha, ver scheduleReconnect).
export function disconnectManually() {
  manualDisconnect = true
  clearTimeout(reconnectTimer)
  reconnectTimer = null
  isReconnecting = false
  state.ws?.close()
  stopPing()
}

function scheduleReconnect() {
  if (manualDisconnect || reconnectTimer) return
  isReconnecting = true
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null
    appLog('INFO', 'Tentando reconectar ao servidor…')
    connectWebSocket()
  }, 5000)
}

export function connectWebSocket() {
  const url = `${state.serverUrl}/ws/${state.roomId}`
  state.ws = new WebSocket(url)

  state.ws.onopen = () => {
    sendWS({ type: 'join-room', username: state.myName })

    if (!hasEnteredRoom) {
      // Primeira conexão bem-sucedida desta entrada — só agora troca de tela.
      hasEnteredRoom = true
      $('display-room-id').textContent = state.roomId
      showScreen('room')
      setLoginButtonsDisabled(false)
    }

    toast(isReconnecting ? 'Reconectado à sala!' : 'Conectado à sala!')
    isReconnecting = false
    startPing()
  }

  state.ws.onmessage = (event) => handleMessage(JSON.parse(event.data))

  state.ws.onerror = () => {
    appLog('ERROR', `Erro de conexão WebSocket com ${url}`)
    // Antes de entrar, quem avisa é o onclose (mostra erro na tela de
    // login) — evita toast duplicado pro mesmo problema.
    if (hasEnteredRoom && !isReconnecting) toast('Erro de conexão com o servidor.')
  }

  state.ws.onclose = () => {
    appLog('WARN', 'Desconectado do servidor.')
    // Limpa peers
    Object.values(state.watchPeers).forEach(pc => pc.close())
    Object.values(state.sharePeers).forEach(pc => pc.close())
    Object.values(state.voicePeers).forEach(pc => pc.close())
    state.watchPeers = {}
    state.sharePeers = {}
    state.voicePeers = {}
    // O microfone continua capturado (não precisa pedir permissão de novo
    // ao reconectar) — só as conexões de voz com cada participante caem,
    // e são refeitas quando a sala reenviar 'room-info' (ver initVoiceChat).
    Object.keys(state.voiceAudioEls).forEach(uid => state.voiceAudioEls[uid]?.remove())
    state.voiceAudioEls = {}
    clearRemoteVoiceAnalysers()
    state.speaking.clear()
    stopPing()

    if (manualDisconnect) return

    if (!hasEnteredRoom) {
      // Nunca chegou a entrar — fica na tela de login com o erro, sem
      // ficar tentando reconectar sozinho (só quando a pessoa tentar de novo).
      showError('Não foi possível conectar ao servidor. Verifique o endereço.')
      setLoginButtonsDisabled(false)
      return
    }

    // Só avisa uma vez quando cai — não fica repetindo toast a cada
    // tentativa de reconexão que falha (checa de 5 em 5s até voltar).
    if (!isReconnecting) toast('Desconectado do servidor. Tentando reconectar…')
    scheduleReconnect()
  }
}

export function sendWS(obj) {
  if (state.ws?.readyState === WebSocket.OPEN) {
    state.ws.send(JSON.stringify(obj))
  }
}

/* ═══════════════════════════════════════════════════════════════
   MENSAGENS DO SERVIDOR
═══════════════════════════════════════════════════════════════ */
async function handleMessage(msg) {
  switch (msg.type) {

    // Entrei na sala — recebo meu ID e lista de usuários
    case 'room-info':
      state.myId = msg.user_id
      state.users = {}
      for (const [uid, u] of Object.entries(msg.users || {})) {
        if (uid !== state.myId) {
          state.users[uid] = u
          seedParticipantVolume(uid, u.username)
        }
      }
      renderParticipants()
      // Chat de voz: só quem ACABOU de entrar inicia a oferta pros que já
      // estavam na sala (ver initVoiceChat) — evita duas ofertas
      // simultâneas (glare) entre o mesmo par de usuários.
      initVoiceChat()
      break

    // Novo usuário entrou
    case 'user-joined':
      if (msg.user_id !== state.myId) {
        state.users[msg.user_id] = { username: msg.username, sharing: false }
        seedParticipantVolume(msg.user_id, msg.username)
        renderParticipants()
        toast(`${msg.username} entrou na sala`)
      }
      break

    // Usuário saiu
    case 'user-left':
      toast(`${msg.username || 'Alguém'} saiu da sala`)
      removeUser(msg.user_id)
      break

    // Alguém começou a compartilhar
    case 'user-sharing':
      if (state.users[msg.user_id]) {
        state.users[msg.user_id].sharing = true
        renderParticipants()
        // Toast de cima (borda verde) — separado do toast de baixo, que
        // fica só pra entrada/saída de gente na sala e outros avisos.
        toastTop(`${msg.username} está compartilhando a tela`)
        playShareSound()
      }
      break

    // Alguém parou de compartilhar
    case 'user-stopped-sharing':
      if (state.users[msg.user_id]) {
        state.users[msg.user_id].sharing = false
        stopWatchTimeout(msg.user_id)
        state.watching.delete(msg.user_id)
        state.connecting.delete(msg.user_id)
        delete state.screenSnapshots[msg.user_id] // não mostra prévia de uma live que já acabou
        renderParticipants()
        removeStreamCard(msg.user_id)
        // Só fecha a conexão em que EU assistia essa pessoa — se ela
        // também estiver me assistindo, essa outra conexão continua de pé.
        closeWatchPeer(msg.user_id)
      }
      break

    // Miniatura periódica da tela de quem compartilha — guarda pra
    // mostrar na prévia ao passar o mouse (sidebar), sem precisar
    // assistir. Ver captureAndSendSnapshot em js/snapshot.js.
    case 'screen-snapshot':
      if (msg.payload?.image) state.screenSnapshots[msg.user_id] = msg.payload.image
      break

    // ── WebRTC ──
    // offer/answer/ice-candidate são compartilhados entre o compartilhamento
    // de tela e o chat de voz (ver context.MD → Fluxo WebSocket); o campo
    // payload.kind === 'voice' diz qual dos dois é — sem isso, os dois
    // tipos de negociação (tela e voz) com a MESMA pessoa se confundiriam.
    case 'offer':
      if (msg.payload?.kind === 'voice') await handleVoiceOffer(msg.from, msg.payload)
      else await handleOffer(msg.from, msg.payload)
      break

    case 'answer':
      if (msg.payload?.kind === 'voice') await handleVoiceAnswer(msg.from, msg.payload)
      else await handleAnswer(msg.from, msg.payload)
      break

    case 'ice-candidate':
      if (msg.payload?.kind === 'voice') await handleVoiceIceCandidate(msg.from, msg.payload)
      else await handleIceCandidate(msg.from, msg.payload)
      break

    // Quem está assistindo pediu outra resolução (economia de banda)
    case 'set-quality':
      await applyViewerQuality(msg.from, msg.payload?.height ?? null)
      break

    // Resposta do ping — mede a latência com o servidor
    case 'pong':
      handlePong(msg.payload)
      break
  }
}
