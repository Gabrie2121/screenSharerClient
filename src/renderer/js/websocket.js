import { $, showScreen } from './core/dom.js'
import { appLog } from './core/logger.js'
import { toast, toastTop, showError } from './core/toast.js'
import { playSound } from './core/sounds.js'
import { state } from './core/state.js'
import { setLoginButtonsDisabled } from './login.js'
import { startPing, stopPing, handlePong } from './ping.js'
import { renderParticipants, removeUser } from './participants.js'
import { seedParticipantVolume } from './voice/volume.js'
import { removeStreamCard } from './stream-cards.js'
import { stopSharing } from './webrtc/capture.js'
import {
  closeWatchPeer, stopWatchTimeout, handleOffer, handleAnswer,
  handleIceCandidate, applyViewerQuality,
} from './webrtc/screen-share-peers.js'
import {
  initVoiceChat, handleVoiceOffer, handleVoiceAnswer, handleVoiceIceCandidate,
} from './voice/peers.js'
import { announceMicState } from './voice/mic.js'
import {
  handleCamOffer, handleCamAnswer, handleCamIceCandidate,
  offerCameraTo, cleanupCameraForUser, playCameraSound, reannounceCamera,
} from './webrtc/camera.js'
import { renderCameraStrip } from './camera-strip.js'
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

  state.ws.onclose = (event) => {
    /* O código de fechamento é o que separa três causas muito diferentes
       que apareciam todas como "Desconectado do servidor":
         1000/1001 → o servidor encerrou de propósito (restart, deploy)
         1006      → queda abrupta, sem close frame: rede da pessoa, Wi-Fi
                     caindo, ou o processo do servidor morrendo
         1011      → erro interno do servidor
       Junto vai o último RTT medido: ping subindo antes da queda aponta
       rede degradando; queda com ping baixo e estável aponta o outro lado. */
    const rtt = state.pingHistory[state.pingHistory.length - 1]
    appLog('WARN', `Desconectado do servidor — código ${event?.code ?? '?'}`
      + `${event?.reason ? ` (${event.reason})` : ''}`
      + `, limpo=${event?.wasClean ?? '?'}`
      + `, último ping=${rtt != null ? rtt + 'ms' : 'n/d'}`)

    /* ── DERRUBA TODA A MÍDIA DA SALA ──
       Sem o servidor não há sinalização, então nenhuma dessas conexões tem
       como se restabelecer nem como ser renegociada. Antes daqui só as
       RTCPeerConnection eram fechadas, e o resto ficava para trás: os cards
       continuavam no palco congelados mostrando o último frame, a lista de
       participantes seguia dizendo "Assistindo", os intervalos de getStats
       ficavam rodando contra conexões mortas, e — o pior — state.sharing
       continuava ligado, com a captura de tela viva e o indicador do
       Windows aceso, dando a impressão de que você ainda estava
       transmitindo para uma sala que não existe mais.

       stopSharing com notifyServer: false porque o socket já morreu: mandar
       'stop-sharing' não chegaria a ninguém, e o toast normal ("Você parou
       de compartilhar") culparia a pessoa por algo que foi queda do
       servidor. O aviso certo é o de desconexão, logo abaixo. */
    stopSharing({ notifyServer: false })

    Object.values(state.watchPeers).forEach(pc => pc.close())
    Object.values(state.sharePeers).forEach(pc => pc.close())
    Object.values(state.voicePeers).forEach(pc => pc.close())
    Object.values(state.camPeers).forEach(pc => pc.close())
    Object.values(state.camViewPeers).forEach(pc => pc.close())
    state.watchPeers = {}
    state.sharePeers = {}
    state.voicePeers = {}

    // Tira do palco tudo o que eu estava assistindo. removeStreamCard já
    // cuida de sair do PiP/tela cheia e de limpar o statsInterval do card.
    Object.keys(state.watchTimeouts).forEach(uid => stopWatchTimeout(uid))
    state.watching.forEach(uid => removeStreamCard(uid))
    Object.keys(state.remoteStreams).forEach(uid => removeStreamCard(uid))
    state.watching.clear()
    state.connecting.clear()
    state.remoteStreams = {}
    state.viewerQuality = {}
    state.focusedId = null
    // A captura da própria câmera continua viva (state.localCamStream) —
    // como o microfone, não faz sentido pedir permissão de novo a cada
    // reconexão. Só as conexões com cada participante caem; elas são
    // refeitas quando eu reofertar depois do 'room-info'.
    state.camPeers = {}
    state.camViewPeers = {}
    state.camStreams = {}
    state.stagedCamId = null
    renderCameraStrip()
    // O microfone continua capturado (não precisa pedir permissão de novo
    // ao reconectar) — só as conexões de voz com cada participante caem,
    // e são refeitas quando a sala reenviar 'room-info' (ver initVoiceChat).
    Object.keys(state.voiceAudioEls).forEach(uid => state.voiceAudioEls[uid]?.remove())
    state.voiceAudioEls = {}
    clearRemoteVoiceAnalysers()
    state.speaking.clear()
    stopPing()
    renderParticipants()

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
          // Quem já estava com a câmera ligada vai ofertar pra mim sozinho?
          // Não: quem oferta é quem LIGA a câmera (ver js/webrtc/camera.js),
          // e isso já aconteceu antes de eu entrar. Quem me manda a oferta é
          // aquela ponta, ao receber o meu 'user-joined'. O campo `camera`
          // que vem aqui serve pra UI já mostrar o ícone certo enquanto a
          // negociação não termina.
        }
      }
      renderParticipants()
      // Chat de voz: só quem ACABOU de entrar inicia a oferta pros que já
      // estavam na sala (ver initVoiceChat) — evita duas ofertas
      // simultâneas (glare) entre o mesmo par de usuários.
      initVoiceChat()
      // Câmera: se ela já estava ligada, este room-info é uma RECONEXÃO. O
      // user_id é gerado por conexão (ver CLAUDE.md), então o servidor
      // perdeu o estado `camera` do meu usuário antigo e as conexões de
      // câmera foram todas fechadas no onclose — preciso me anunciar e
      // reofertar, senão eu ficaria "com a câmera ligada" só pra mim.
      reannounceCamera()
      // O mudo persiste entre sessões (localStorage) e o servidor assume
      // False, então quem entra já mutado precisa corrigir isso na sala.
      announceMicState()
      break

    // Novo usuário entrou
    case 'user-joined':
      if (msg.user_id !== state.myId) {
        state.users[msg.user_id] = { username: msg.username, sharing: false, camera: false, mic_muted: false }
        seedParticipantVolume(msg.user_id, msg.username)
        renderParticipants()
        toast(`${msg.username} entrou na sala`)
        playSound('user-join')
        // Minha câmera já está ligada e essa pessoa não existia quando eu
        // liguei — sem esta oferta, quem entra depois nunca veria a câmera
        // de quem já estava (quem oferta é sempre quem tem a câmera).
        offerCameraTo(msg.user_id)
      }
      break

    // Usuário saiu
    case 'user-left':
      toast(`${msg.username || 'Alguém'} saiu da sala`)
      playSound('user-leave')
      // Saiu de vez: derruba os dois sentidos da câmera (o que eu recebia
      // dela E o que eu enviava pra ela).
      cleanupCameraForUser(msg.user_id, true)
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
        playSound('share-start')
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
        playSound('share-stop')
        // Só fecha a conexão em que EU assistia essa pessoa — se ela
        // também estiver me assistindo, essa outra conexão continua de pé.
        closeWatchPeer(msg.user_id)
      }
      break

    // Alguém ligou a câmera — a oferta WebRTC dessa pessoa vem logo atrás
    // (ver offerCameraTo). Aqui é só o estado pra UI.
    case 'user-camera-on':
      if (state.users[msg.user_id]) {
        state.users[msg.user_id].camera = true
        renderParticipants()
        playCameraSound()
      }
      break

    // Alguém desligou a câmera — fecha só o sentido em que eu RECEBIA. A
    // conexão em que eu envio a MINHA câmera pra essa pessoa continua de pé.
    case 'user-camera-off':
      if (state.users[msg.user_id]) {
        state.users[msg.user_id].camera = false
        cleanupCameraForUser(msg.user_id)
        renderParticipants()
      }
      break

    // Alguém mutou ou desmutou o microfone — só estado pra UI, nenhuma
    // conexão de voz é aberta ou fechada por isso.
    case 'user-mic-state':
      if (state.users[msg.user_id]) {
        state.users[msg.user_id].mic_muted = !!msg.payload?.muted
        renderParticipants()
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
      else if (msg.payload?.kind === 'webcam') await handleCamOffer(msg.from, msg.payload)
      else await handleOffer(msg.from, msg.payload)
      break

    case 'answer':
      if (msg.payload?.kind === 'voice') await handleVoiceAnswer(msg.from, msg.payload)
      else if (msg.payload?.kind === 'webcam') await handleCamAnswer(msg.from, msg.payload)
      else await handleAnswer(msg.from, msg.payload)
      break

    case 'ice-candidate':
      if (msg.payload?.kind === 'voice') await handleVoiceIceCandidate(msg.from, msg.payload)
      else if (msg.payload?.kind === 'webcam') await handleCamIceCandidate(msg.from, msg.payload)
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
