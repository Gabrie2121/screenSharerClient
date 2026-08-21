import { RnnoiseWorkletNode, loadRnnoise } from '../../node_modules/@sapphi-red/web-noise-suppressor/dist/index.js'

/* ═══════════════════════════════════════════════════════════════
   ShareSync — Renderer
   Responsabilidades:
   - Conecta ao backend via WebSocket
   - Gerencia sinalização WebRTC (offer/answer/ICE)
   - Exibe streams de quem o usuário escolher assistir
   - Permite compartilhar a própria tela
═══════════════════════════════════════════════════════════════ */

// ──────────────────────────────────────────────
// ESTADO
// ──────────────────────────────────────────────
const SELF_PREVIEW_KEY = 'sharesync:show-self-preview'
const DEFAULT_WATCH_QUALITY_KEY = 'sharesync:default-watch-quality'
const SHARE_AUDIO_KEY = 'sharesync:share-audio'

// Chat de voz — preferências persistidas (ver seção "CHAT DE VOZ" abaixo)
const MIC_MUTED_KEY = 'sharesync:mic-muted'
const MIC_DEVICE_KEY = 'sharesync:mic-device'
const SPEAKER_DEVICE_KEY = 'sharesync:speaker-device'
const MASTER_VOLUME_KEY = 'sharesync:master-volume'
const NOISE_SUPPRESSION_KEY = 'sharesync:noise-suppression'
const NOISE_INTENSITY_KEY = 'sharesync:noise-intensity'

const state = {
  myId:      null,
  myName:    '',
  roomId:    null,
  serverUrl: '',

  // WebSocket
  ws: null,

  // Cada par de usuários pode ter DUAS conexões independentes, uma pra
  // cada sentido — "eu assisto ele" e "ele assiste eu" são coisas
  // diferentes e podem estar ativas ao mesmo tempo (assistir mútuo).
  // Antes isso dividia uma única RTCPeerConnection por usuário, e cada
  // offer recém-chegada substituía a conexão existente por baixo do pano
  // — causava colisão de sinalização (glare) e a tela ficava preta pro
  // outro lado quando os dois se assistiam ao mesmo tempo.
  // watchPeers: { userId: RTCPeerConnection } — eu sou o offerer, só recebo
  watchPeers: {},
  // sharePeers: { userId: RTCPeerConnection } — eu sou o answerer, só envio
  sharePeers: {},

  // Streams recebidos: { userId: MediaStream }
  remoteStreams: {},

  // Usuários na sala: { userId: { username, sharing } }
  users: {},

  // Quem estou assistindo (stream já chegou e está exibindo)
  watching: new Set(),

  // Quem eu pedi pra assistir mas a negociação WebRTC ainda não terminou
  // (ver toggleWatch) — importante pra não mostrar "Assistindo" antes da
  // hora: isso fazia a pessoa clicar de novo achando que travou, cancelando
  // a conexão bem na hora em que o vídeo chegava (video.play() interrompido
  // porque o card foi removido no meio do play — DOMException no console).
  connecting: new Set(),

  // Minha stream local (quando compartilho) — por padrão não aparece na
  // tela, só é usada pra enviar aos outros participantes. Opcionalmente
  // (ver checkbox "Mostrar minha tela") aparece numa prévia local mudinha
  // no canto inferior direito (ver updateSelfPreview).
  localStream: null,
  sharing: false,

  // Preferência de mostrar a autovisualização — persiste em sessionStorage
  // (SELF_PREVIEW_KEY) e vira o padrão pras próximas vezes que compartilhar.
  showSelfPreview: sessionStorage.getItem(SELF_PREVIEW_KEY) === 'true',

  // Qualidade padrão ao começar a assistir alguém (Configurações → Live) —
  // 'auto' ou uma altura em px ('360'/'480'/'720'/'1080'). Dá pra mudar na
  // hora por live, no seletor de cada card (ver upsertStreamCard).
  defaultWatchQuality: sessionStorage.getItem(DEFAULT_WATCH_QUALITY_KEY) || 'auto',

  // Stream em foco na tela (as demais ficam minimizadas embaixo)
  focusedId: null,

  // Medição de latência (ping) — histórico curto pro popover de detalhe
  // (ver ping-box no hover), últimas ~20 amostras (~1min a cada 3s)
  pingInterval: null,
  pingWaiting: false,
  pingHistory: [],

  // Timeouts de "assistir" pendente — evita loading infinito (ver toggleWatch)
  watchTimeouts: {},

  // Intervalos que leem getStats() pra mostrar resolução/bitrate reais
  // recebidos em cada card (ver upsertStreamCard) — prova concreta de que
  // o seletor de qualidade está realmente mudando o que chega pela rede.
  statsIntervals: {},

  // Últimos snapshots recebidos de cada compartilhamento — { userId: dataURL
  // jpeg }. Usado na prévia ao passar o mouse na sidebar pra quem você
  // ainda não está assistindo (ver showParticipantPreview). Quem compartilha
  // manda um novo a cada 3min (ver captureAndSendSnapshot).
  screenSnapshots: {},
  snapshotInterval: null,

  // ── CHAT DE VOZ ──
  // Uma RTCPeerConnection bidirecional por participante (mic vai e vem na
  // mesma conexão — diferente do compartilhamento de tela, que é sempre
  // uma via só). Mapas separados de watchPeers/sharePeers acima.
  voicePeers: {},
  // <audio> criado em runtime por participante, só pra tocar o mic dele
  // (ver createVoicePeer/ontrack) — nunca aparece na tela.
  voiceAudioEls: {},
  // Stream crua de cada participante, exatamente como chegou do WebRTC —
  // guardada à parte porque o <audio> às vezes toca ela diretamente e às
  // vezes toca a versão passada pelo GainNode (ver applyVoiceVolume/
  // setupVoiceAmplifier), dependendo se o volume pedido passa de 100%.
  voiceRawStreams: {},
  // Minha captura de microfone — uma só, compartilhada com todas as
  // conexões de voz (o mesmo MediaStreamTrack é adicionado em cada uma).
  localMicStream: null,
  localMicInputStream: null,
  micMuted: sessionStorage.getItem(MIC_MUTED_KEY) === 'true',
  micDeviceId: sessionStorage.getItem(MIC_DEVICE_KEY) || '',
  speakerDeviceId: sessionStorage.getItem(SPEAKER_DEVICE_KEY) || '',
  // Só o volume POR PARTICIPANTE (ver participantVolumes abaixo) amplifica
  // além de 100% — o geral serve pra abaixar tudo de uma vez, por isso fica
  // travado em 0-100 (o Math.min cobre quem tinha um valor antigo >100
  // salvo de uma versão anterior deste slider).
  masterVolume: Math.min(100, Number(sessionStorage.getItem(MASTER_VOLUME_KEY) ?? 100)),
  noiseSuppression: sessionStorage.getItem(NOISE_SUPPRESSION_KEY) !== 'false',
  noiseIntensity: Number(sessionStorage.getItem(NOISE_INTENSITY_KEY) ?? 85),
  // Volume individual que EU escolhi pra ouvir cada participante (local,
  // não afeta o que os outros ouvem) — 0-100, 100 é o padrão.
  participantVolumes: {},
  // Guarda o último volume não-zero de cada participante, pra restaurar ao
  // desmutar (mesma ideia do lastVolume nos cards de stream).
  participantLastVolume: {},
  // Quem está falando agora (chat de voz) — inclui o próprio usuário.
  // Preenchido por detecção local de volume (ver startSpeakingLoop),
  // nenhuma mensagem nova de WebSocket é necessária pra isso.
  speaking: new Set(),
}

let noiseContext = null
let noiseSource = null
let noiseNode = null
let noiseDestination = null
let noiseDryGain = null
let noiseWetGain = null
let noiseSetupPromise = null

async function createNoiseSuppressedStream(inputStream) {
  if (!state.noiseSuppression || !noiseContext?.audioWorklet) return inputStream

  try {
    noiseSource = noiseContext.createMediaStreamSource(inputStream)
    noiseNode = new RnnoiseWorkletNode(noiseContext, {
      maxChannels: 1,
      wasmBinary: await loadRnnoise({
        url: new URL('../../node_modules/@sapphi-red/web-noise-suppressor/dist/rnnoise.wasm', import.meta.url).href,
        simdUrl: new URL('../../node_modules/@sapphi-red/web-noise-suppressor/dist/rnnoise_simd.wasm', import.meta.url).href,
      }),
    })
    noiseDryGain = noiseContext.createGain()
    noiseWetGain = noiseContext.createGain()
    noiseDestination = noiseContext.createMediaStreamDestination()
    noiseSource.connect(noiseDryGain)
    noiseDryGain.connect(noiseDestination)
    noiseSource.connect(noiseNode)
    noiseNode.connect(noiseWetGain)
    noiseWetGain.connect(noiseDestination)
    updateNoiseIntensity()
    appLog('INFO', 'RNNoise ativado para o microfone')
    return noiseDestination.stream
  } catch (err) {
    appLog('WARN', `RNNoise indisponível, usando áudio original: ${err.message}`)
    destroyNoiseSuppression()
    return inputStream
  }
}

async function prepareNoiseSuppression() {
  if (!state.noiseSuppression) return
  if (!noiseSetupPromise) {
    noiseSetupPromise = (async () => {
      noiseContext = new AudioContext({ sampleRate: 48000 })
      await noiseContext.audioWorklet.addModule(new URL('../../node_modules/@sapphi-red/web-noise-suppressor/dist/rnnoise/workletProcessor.js', import.meta.url).href)
    })().catch((err) => {
      noiseSetupPromise = null
      noiseContext?.close()
      noiseContext = null
      throw err
    })
  }
  await noiseSetupPromise
}

function destroyNoiseSuppression() {
  noiseSource?.disconnect()
  noiseNode?.disconnect()
  noiseNode?.destroy()
  noiseContext?.close()
  noiseSource = null
  noiseNode = null
  noiseDestination = null
  noiseDryGain = null
  noiseWetGain = null
  noiseContext = null
  noiseSetupPromise = null
}

function updateNoiseIntensity() {
  if (!noiseContext || !noiseDryGain || !noiseWetGain) return
  const intensity = Math.max(0, Math.min(100, state.noiseIntensity)) / 100
  noiseDryGain.gain.setTargetAtTime(1.2 * (1 - intensity), noiseContext.currentTime, 0.015)
  noiseWetGain.gain.setTargetAtTime(1.2 + intensity * 0.35, noiseContext.currentTime, 0.015)
}

// ──────────────────────────────────────────────
// ICE SERVERS (STUN + TURN)
// STUN sozinho só resolve o IP público — quando as duas pontas estão em
// redes diferentes (NAT restritivo/CGNAT de operadora, por trás de
// firewall, etc.) a conexão direta não fecha e o ICE cai em "failed" sem
// um TURN pra retransmitir a mídia. As credenciais abaixo são do Open
// Relay Project (metered.ca) — gratuitas e compartilhadas, então servem
// pra destravar o uso entre amigos, mas não são garantia de uptime/banda
// pra produção. Se a instabilidade continuar, considere subir um coturn
// próprio ou um TURN pago.
// ──────────────────────────────────────────────
const ICE_CONFIG = {
  iceServers: [
    { urls: 'stun:stun.relay.metered.ca:80' },
    {
      urls: 'turn:global.relay.metered.ca:80',
      username: 'openrelayproject',
      credential: 'openrelayproject',
    },
    {
      urls: 'turn:global.relay.metered.ca:443',
      username: 'openrelayproject',
      credential: 'openrelayproject',
    },
    {
      urls: 'turn:global.relay.metered.ca:443?transport=tcp',
      username: 'openrelayproject',
      credential: 'openrelayproject',
    },
  ],
}

// ──────────────────────────────────────────────
// HELPERS UI
// ──────────────────────────────────────────────
const $ = (id) => document.getElementById(id)

// Log básico — imprime no console e grava no arquivo de log do app
// (via processo principal, ver src/main.js).
function appLog(level, message) {
  console.log(`[${level}] ${message}`)
  window.electronAPI?.log(level, message)
}

function showScreen(name) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'))
  $(`screen-${name}`).classList.add('active')
}

function showError(msg) {
  const el = $('login-error')
  el.textContent = msg
  el.classList.remove('hidden')
}

function hideError() { $('login-error').classList.add('hidden') }

let toastTimer = null
function toast(msg) {
  const t = $('toast')
  t.textContent = msg
  t.classList.add('show')
  t.classList.remove('hidden')
  clearTimeout(toastTimer)
  toastTimer = setTimeout(() => t.classList.remove('show'), 2500)
}

// Toast de cima, com borda verde — separado do de baixo (que fica pra
// "alguém entrou"/erros/etc.) pra avisos de "alguém compartilhou a tela"
// não brigarem pelo mesmo espaço.
let toastTopTimer = null
function toastTop(msg) {
  const t = $('toast-top')
  t.textContent = msg
  t.classList.add('show')
  t.classList.remove('hidden')
  clearTimeout(toastTopTimer)
  toastTopTimer = setTimeout(() => t.classList.remove('show'), 3000)
}

// Aviso sonoro quando alguém começa a compartilhar — src/assets/holy.mp3
// (caminho relativo a este arquivo, src/renderer/app.js). Fica em 40% do
// volume o tempo todo e corta em 1s — o arquivo original dura mais que
// isso, mas só precisamos do começo como aviso rápido.
const shareSound = new Audio('../assets/holy.mp3')
shareSound.volume = 0.4
let shareSoundCutTimer = null

function playShareSound() {
  try {
    shareSound.currentTime = 0
    shareSound.play().catch((err) => {
      console.warn('[SOM] Falha ao tocar aviso de compartilhamento:', err)
    })
    clearTimeout(shareSoundCutTimer)
    shareSoundCutTimer = setTimeout(() => {
      shareSound.pause()
      shareSound.currentTime = 0
    }, 1000)
  } catch (err) {
    console.warn('[SOM] Falha ao tocar aviso de compartilhamento:', err)
  }
}

// ──────────────────────────────────────────────
// TITLEBAR
// ──────────────────────────────────────────────
$('btn-min').onclick   = () => window.electronAPI?.minimize()
$('btn-max').onclick   = () => window.electronAPI?.maximize()
$('btn-close').onclick = () => window.electronAPI?.close()

// ──────────────────────────────────────────────
// VERSÃO DO APP — canto inferior esquerdo, em toda a tela do sistema.
// Também funciona como botão de "verificar atualização" manual (antes só
// checava sozinho ao abrir o app, sem jeito de forçar uma nova checagem).
// ──────────────────────────────────────────────
const appVersionBtn = $('app-version')
let appVersionLabel = ''
let checkingUpdate = false

window.electronAPI?.getAppVersion().then((version) => {
  appVersionLabel = `v${version}`
  appVersionBtn.textContent = appVersionLabel
})

appVersionBtn.onclick = () => {
  if (checkingUpdate) return
  checkingUpdate = true
  appVersionBtn.textContent = 'Verificando…'
  appLog('INFO', 'Usuário pediu verificação manual de atualização')
  window.electronAPI?.checkForUpdates()
}

window.electronAPI?.onUpdateNotAvailable(() => {
  checkingUpdate = false
  appVersionBtn.textContent = appVersionLabel
  toast('Você já está na versão mais recente.')
})

// ──────────────────────────────────────────────
// ATUALIZAÇÃO DO APP
// Botão fica escondido até o processo principal avisar que há uma versão
// nova (ver src/main.js). Um clique baixa, instala e reinicia sozinho.
// ──────────────────────────────────────────────
const btnUpdate = $('btn-update')
const updateText = $('update-text')

// Depois que o download termina, a atualização só é instalada quando a
// pessoa confirma clicando de novo — reiniciar sozinho derrubaria uma
// sessão de compartilhamento em andamento sem aviso.
let updateReady = false

btnUpdate.onclick = () => {
  if (btnUpdate.disabled) return

  if (updateReady) {
    appLog('INFO', 'Usuário confirmou reinício para instalar a atualização')
    window.electronAPI?.installUpdate()
    return
  }

  btnUpdate.disabled = true
  btnUpdate.classList.remove('error')
  updateText.textContent = 'Baixando atualização…'
  appLog('INFO', 'Download de atualização iniciado pelo usuário')
  window.electronAPI?.startUpdate()
}

window.electronAPI?.onUpdateAvailable(({ version }) => {
  appLog('INFO', `Nova versão disponível: v${version}`)
  checkingUpdate = false
  appVersionBtn.textContent = appVersionLabel
  updateReady = false
  btnUpdate.classList.remove('hidden', 'error')
  btnUpdate.disabled = false
  updateText.textContent = `Atualizar para v${version}`
})

window.electronAPI?.onUpdateProgress(({ percent }) => {
  updateText.textContent = `Baixando atualização… ${percent}%`
})

window.electronAPI?.onUpdateReady(() => {
  appLog('INFO', 'Atualização baixada — aguardando confirmação para reiniciar')
  updateReady = true
  btnUpdate.classList.remove('error')
  btnUpdate.disabled = false
  updateText.textContent = 'Reiniciar para atualizar'
})

window.electronAPI?.onUpdateError(({ message }) => {
  appLog('ERROR', `Falha na atualização: ${message}`)
  // Se o erro veio de uma checagem manual (clique no badge de versão), o
  // botão de atualização ainda não apareceu — sem isso a pessoa clicava e
  // não via nenhum retorno.
  if (checkingUpdate) {
    checkingUpdate = false
    appVersionBtn.textContent = appVersionLabel
    toast(`Não foi possível verificar atualizações: ${message}`)
  }
  updateReady = false
  btnUpdate.classList.add('error')
  btnUpdate.disabled = false
  updateText.textContent = 'Erro ao atualizar — tentar de novo'
})

// ──────────────────────────────────────────────
// LOGIN
// ──────────────────────────────────────────────
// Troca o conteúdo do botão por um spinner + "Conectando…" enquanto tenta
// entrar na sala (some sozinho quando conecta ou dá erro — ver enterRoom).
function setButtonLoading(btn, loading) {
  if (loading) {
    if (btn.dataset.originalHtml === undefined) btn.dataset.originalHtml = btn.innerHTML
    btn.innerHTML = '<span class="spinner spinner-sm"></span> Conectando…'
  } else if (btn.dataset.originalHtml !== undefined) {
    btn.innerHTML = btn.dataset.originalHtml
  }
  btn.disabled = loading
}

function setLoginButtonsDisabled(disabled) {
  setButtonLoading($('btn-create-room'), disabled)
  setButtonLoading($('btn-join-room'), disabled)
}

$('btn-create-room').onclick = async () => {
  const name = $('input-name').value.trim()
  const server = $('input-server').value.trim()
  if (!name) return showError('Digite seu nome para continuar.')
  hideError()

  // Cria sala via REST
  setLoginButtonsDisabled(true)
  const httpUrl = server.replace(/^ws/, 'http')
  try {
    const res = await fetch(`${httpUrl}/api/rooms/`, { method: 'POST' })
    const data = await res.json()
    enterRoom(name, server, data.room_id)
  } catch {
    showError('Não foi possível conectar ao servidor. Verifique o endereço.')
    setLoginButtonsDisabled(false)
  }
}

$('btn-join-room').onclick = () => {
  const name   = $('input-name').value.trim()
  const server = $('input-server').value.trim()
  const roomId = $('input-room-id').value.trim()
  if (!name)   return showError('Digite seu nome.')
  if (!roomId) return showError('Digite o código da sala.')
  hideError()
  setLoginButtonsDisabled(true)
  enterRoom(name, server, roomId)
}

// ──────────────────────────────────────────────
// ENTRAR NA SALA
// ──────────────────────────────────────────────
// Entrar por código não fazia nenhuma checagem de conexão — trocava pra
// tela da sala na hora, mesmo que o servidor estivesse fora do ar ou o
// endereço estivesse errado, deixando uma sala vazia e "quebrada" sem
// explicação. Agora só troca de tela quando o WebSocket realmente conecta
// (ver onopen/onclose em connectWebSocket) — hasEnteredRoom controla isso.
let hasEnteredRoom = false

function enterRoom(name, server, roomId) {
  state.myName   = name
  state.serverUrl = server
  state.roomId   = roomId
  manualDisconnect = false
  hasEnteredRoom = false

  appLog('INFO', `Entrando na sala ${roomId} como "${name}" (servidor: ${server})`)
  connectWebSocket()
}

// ──────────────────────────────────────────────
// WEBSOCKET
// ──────────────────────────────────────────────
// Se o servidor cair DEPOIS de já estar na sala, tenta reconectar sozinho a
// cada 5s até voltar (ou até a pessoa sair da sala de propósito — ver
// btn-leave, que desarma isso). Antes de entrar pela primeira vez (ver
// hasEnteredRoom acima), uma falha não entra nesse loop — só mostra o erro
// na tela de login e deixa a pessoa tentar de novo manualmente.
let manualDisconnect = false
let reconnectTimer = null
let isReconnecting = false

function scheduleReconnect() {
  if (manualDisconnect || reconnectTimer) return
  isReconnecting = true
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null
    appLog('INFO', 'Tentando reconectar ao servidor…')
    connectWebSocket()
  }, 5000)
}

function connectWebSocket() {
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
    Object.keys(voiceAnalysers).forEach(key => { if (key !== '__self__') delete voiceAnalysers[key] })
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

function sendWS(obj) {
  if (state.ws?.readyState === WebSocket.OPEN) {
    state.ws.send(JSON.stringify(obj))
  }
}

// ──────────────────────────────────────────────
// PING — latência com o servidor (barrinhas + ms)
// ──────────────────────────────────────────────
function startPing() {
  stopPing()
  const tick = () => {
    if (state.ws?.readyState !== WebSocket.OPEN) return
    state.pingWaiting = true
    sendWS({ type: 'ping', payload: { t: Date.now() } })
  }
  tick()
  state.pingInterval = setInterval(tick, 3000)
}

function stopPing() {
  clearInterval(state.pingInterval)
  state.pingInterval = null
  updatePingUI(null)
}

function handlePong(payload) {
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

// ──────────────────────────────────────────────
// MENSAGENS DO SERVIDOR
// ──────────────────────────────────────────────
async function handleMessage(msg) {
  switch (msg.type) {

    // Entrei na sala — recebo meu ID e lista de usuários
    case 'room-info':
      state.myId = msg.user_id
      state.users = {}
      for (const [uid, u] of Object.entries(msg.users || {})) {
        if (uid !== state.myId) {
          state.users[uid] = u
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
    // assistir. Ver captureAndSendSnapshot.
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

// ──────────────────────────────────────────────
// PARTICIPANTES — RENDER
// ──────────────────────────────────────────────
function renderParticipants() {
  const list = $('participants-list')
  // Se a lista for reconstruída com a prévia de alguém aberta (ex.: outra
  // pessoa entrou/saiu bem nesse momento), o <li> antigo some do DOM sem
  // disparar mouseleave — sem isso, o intervalo do preview ficava rodando
  // pra sempre. hideParticipantPreview() limpa antes de reconstruir tudo.
  hideParticipantPreview()
  list.innerHTML = ''

  // Eu mesmo
  const meLi = makeParticipantItem(state.myId, state.myName, state.sharing, true)
  list.appendChild(meLi)

  // Outros
  for (const [uid, u] of Object.entries(state.users)) {
    const li = makeParticipantItem(uid, u.username, u.sharing, false)
    list.appendChild(li)
  }
}

function makeParticipantItem(uid, name, sharing, isMe) {
  const li = document.createElement('li')
  li.className = 'participant-item'
  li.dataset.uid = uid

  const initial = name[0]?.toUpperCase() || '?'
  const statusText = sharing
    ? (isMe ? '● Live' : '● Live')
    : (isMe ? 'Você' : '● Online')

  const watching   = state.watching.has(uid)
  const connecting = state.connecting.has(uid)
  const watchLabel = connecting ? 'Conectando…' : (watching ? 'Parar de assistir' : 'Assistir')

  const vol = getParticipantVolume(uid)

  li.innerHTML = `
    <div class="participant-avatar">${initial}</div>
    <div class="participant-info">
      <div class="participant-name">${name}${isMe ? ' (você)' : ''}</div>
      <div class="participant-status ${sharing ? 'sharing' : ''}">${statusText}</div>
    </div>
    ${!isMe
      ? `<span class="participant-vol-indicator" title="Volume: ${vol}% — clique para ajustar">${vol === 0 ? '🔇' : (vol > 100 ? '📢' : '🔊')}</span>`
      : ''}
    ${(!isMe && sharing)
      ? `<button class="btn-watch ${watching ? 'watching' : ''} ${connecting ? 'connecting' : ''}" data-uid="${uid}">
           ${watchLabel}
         </button>`
      : ''}
  `

  const watchBtn = li.querySelector('.btn-watch')
  if (watchBtn) {
    watchBtn.onclick = (e) => {
      e.stopPropagation() // não deixa isso também abrir o popover de volume (ver abaixo)
      toggleWatch(uid)
    }
  }

  // Clicar em qualquer parte do participante (menos o botão de assistir)
  // abre/fecha o popover de volume do chat de voz (ver
  // openParticipantVolumePopover — mesmo slider usado nos cards de stream).
  if (!isMe) {
    li.addEventListener('click', () => toggleParticipantVolumePopover(uid, li))
  }

  // Prévia ao passar o mouse — só funciona pra quem você já está
  // assistindo (reaproveita o frame que já está decodificando, sem custo
  // de rede nenhum). Pra quem você ainda não assiste, mostra uma dica em
  // vez de tentar simular uma prévia de verdade (exigiria abrir uma
  // conexão WebRTC só pra isso, que não seria "leve").
  if (!isMe && sharing) {
    li.addEventListener('mouseenter', () => showParticipantPreview(uid, li))
    li.addEventListener('mouseleave', hideParticipantPreview)
  }

  return li
}

let participantPreviewTimer = null

function showParticipantPreview(uid, li) {
  const preview = $('participant-preview')
  const rect = li.getBoundingClientRect()
  preview.style.left = `${rect.right + 8}px`
  preview.style.top = `${rect.top}px`
  preview.classList.remove('hidden')

  const canvas = $('participant-preview-canvas')
  const emptyMsg = $('participant-preview-empty')
  const ctx = canvas.getContext('2d')
  clearInterval(participantPreviewTimer)

  // Já assistindo — usa o frame ao vivo, mais fiel e atualiza rápido.
  const video = document.querySelector(`.stream-card[data-stream="${uid}"] video`)
  if (video && state.remoteStreams[uid]) {
    canvas.classList.remove('hidden')
    emptyMsg.classList.add('hidden')
    const draw = () => {
      try { ctx.drawImage(video, 0, 0, canvas.width, canvas.height) } catch { /* frame ainda não pronto */ }
    }
    draw()
    participantPreviewTimer = setInterval(draw, 1500) // só uma prévia, não precisa ser fluida
    return
  }

  // Não assistindo — cai pro último snapshot que essa pessoa mandou pra
  // sala (atualiza ao começar a compartilhar e a cada 3min, ver
  // captureAndSendSnapshot). É uma imagem estática, sem intervalo.
  const snapshot = state.screenSnapshots[uid]
  if (snapshot) {
    canvas.classList.remove('hidden')
    emptyMsg.classList.add('hidden')
    const img = new Image()
    img.onload = () => { try { ctx.drawImage(img, 0, 0, canvas.width, canvas.height) } catch {} }
    img.src = snapshot
    return
  }

  canvas.classList.add('hidden')
  emptyMsg.classList.remove('hidden')
}

function hideParticipantPreview() {
  clearInterval(participantPreviewTimer)
  participantPreviewTimer = null
  $('participant-preview')?.classList.add('hidden')
}

// ──────────────────────────────────────────────
// ASSISTIR / PARAR DE ASSISTIR
// ──────────────────────────────────────────────
// Precisa ser folgado o bastante pra não cancelar uma conexão que ainda
// está negociando o fallback TURN via TCP/443 (ver ICE_CONFIG acima) —
// em redes restritivas essa negociação sozinha pode levar vários segundos.
const WATCH_TIMEOUT_MS = 25000

async function toggleWatch(uid) {
  if (state.watching.has(uid)) {
    // Para de assistir (ou cancela uma conexão ainda "Conectando…") —
    // fecha só a MINHA conexão de assistir. Se essa pessoa também estiver
    // me assistindo, a conexão dela continua de pé.
    stopWatchTimeout(uid)
    state.watching.delete(uid)
    state.connecting.delete(uid)
    closeWatchPeer(uid)
    removeStreamCard(uid)
    renderParticipants()
  } else {
    // Começa a assistir — inicia negociação WebRTC. Fica em "connecting"
    // até o primeiro track chegar (ver ontrack em createPeer), pra não
    // mostrar "Assistindo" antes da hora.
    state.watching.add(uid)
    state.connecting.add(uid)
    renderParticipants()
    await startPeerConnection(uid)

    // Corrige o "carregando infinito": se em N segundos nenhum track
    // chegar (offer perdida, pessoa parou de compartilhar, ICE travado),
    // desiste, avisa e libera o botão para tentar de novo.
    stopWatchTimeout(uid)
    state.watchTimeouts[uid] = setTimeout(() => {
      delete state.watchTimeouts[uid]
      if (!state.watching.has(uid) || state.remoteStreams[uid]) return
      appLog('WARN', `Timeout esperando stream de ${uid} — cancelando`)
      state.watching.delete(uid)
      state.connecting.delete(uid)
      closeWatchPeer(uid)
      removeStreamCard(uid)
      renderParticipants()
      toast('Não foi possível carregar essa tela. Tente assistir de novo.')
    }, WATCH_TIMEOUT_MS)
  }
}

function stopWatchTimeout(uid) {
  clearTimeout(state.watchTimeouts[uid])
  delete state.watchTimeouts[uid]
}

// ──────────────────────────────────────────────
// WEBRTC — QUEM ASSISTE INICIA A OFERTA
// ──────────────────────────────────────────────
// ──────────────────────────────────────────────
// WEBRTC
// ──────────────────────────────────────────────
async function startPeerConnection(remoteId) {
  const pc = createPeer(remoteId, 'watcher')

  const offer = await pc.createOffer({
    offerToReceiveVideo: true,
    offerToReceiveAudio: true,
  })
  await pc.setLocalDescription(offer)

  sendWS({ type: 'offer', to: remoteId, payload: offer })
}

// role: 'watcher' → eu inicio a oferta pra RECEBER a tela de remoteId.
// role: 'sharer'  → eu respondo a uma oferta ENVIANDO minha tela pra remoteId.
// As duas conexões são independentes (mapas separados) porque "eu assisto
// ele" e "ele me assiste" podem estar ativos ao mesmo tempo; antes disso
// havia uma única RTCPeerConnection por usuário e a offer de um lado
// derrubava a conexão do outro lado no meio da negociação (glare),
// deixando a tela preta pra quem estava assistindo mutuamente.
function createPeer(remoteId, role) {
  const map = role === 'watcher' ? state.watchPeers : state.sharePeers
  if (map[remoteId]) {
    map[remoteId].close()
    delete map[remoteId]
  }

  const pc = new RTCPeerConnection(ICE_CONFIG)
  map[remoteId] = pc

  pc.onicecandidate = (e) => {
    if (e.candidate) {
      // Marca de qual das duas conexões esse candidato veio, pra quem
      // recebe saber em qual pc local aplicar (ver handleIceCandidate).
      sendWS({ type: 'ice-candidate', to: remoteId, payload: { candidate: e.candidate, role } })
    }
  }

  pc.oniceconnectionstatechange = () => {
    console.log(`[ICE ${role} ${remoteId}]`, pc.iceConnectionState)
  }

  pc.onconnectionstatechange = () => {
    console.log(`[CONN ${role} ${remoteId}]`, pc.connectionState)

    if (pc.connectionState === 'failed') {
      appLog('WARN', `Conexão (${role}) com ${remoteId} falhou (ICE não conseguiu conectar nem via TURN)`)

      if (role === 'watcher') {
        // Se eu estava assistindo essa pessoa, limpa o card e deixa
        // tentar de novo — sem isso o card ficava "conectado" mas preto/parado.
        if (state.watching.has(remoteId)) {
          state.watching.delete(remoteId)
          state.connecting.delete(remoteId)
          removeStreamCard(remoteId)
          renderParticipants()
          toast('A conexão com essa tela falhou. Tente assistir de novo.')
        }
        closeWatchPeer(remoteId)
      } else {
        closeSharePeer(remoteId)
      }
    }
  }

  // Só a conexão em que EU assisto (watcher) recebe stream aqui.
  if (role === 'watcher') {
    pc.ontrack = (e) => {
      console.log(`[TRACK de ${remoteId}]`, e.track.kind, e.streams)
      const stream = e.streams[0]
      if (!stream) return
      stopWatchTimeout(remoteId)
      // Só agora o botão vira "Assistindo" — antes disso ficava
      // "Conectando…" (ver makeParticipantItem) pra ninguém clicar de
      // novo achando que travou e cancelar bem na hora em que o vídeo
      // ia carregar. Um stream chega em tracks separados (vídeo + áudio),
      // então só re-renderiza a lista na primeira vez que isso muda.
      if (state.connecting.delete(remoteId)) renderParticipants()
      state.remoteStreams[remoteId] = stream
      upsertStreamCard(remoteId, stream)
    }
  }

  // Se é a conexão em que eu COMPARTILHO (sharer), adiciona tracks agora
  if (role === 'sharer' && state.sharing && state.localStream) {
    state.localStream.getTracks().forEach(track => {
      console.log('[ADD TRACK]', track.kind)
      pc.addTrack(track, state.localStream)
    })
  }

  return pc
}

// Recebe offer (alguém quer assistir minha tela) — eu respondo como sharer
async function handleOffer(fromId, offer) {
  console.log('[OFFER recebida de]', fromId, '| sharing:', state.sharing)

  if (!state.sharing || !state.localStream) {
    console.warn('Recebi offer mas não estou compartilhando, ignorando.')
    return
  }

  // Cria peer JÁ com os tracks antes de responder
  const pc = createPeer(fromId, 'sharer')

  await pc.setRemoteDescription(new RTCSessionDescription(offer))

  const answer = await pc.createAnswer()
  await pc.setLocalDescription(answer)

  console.log('[ANSWER enviado para]', fromId)
  sendWS({ type: 'answer', to: fromId, payload: answer })
}

async function handleAnswer(fromId, answer) {
  console.log('[ANSWER recebido de]', fromId)
  // Só a minha conexão de watcher fica esperando uma answer.
  const pc = state.watchPeers[fromId]
  if (!pc) return
  await pc.setRemoteDescription(new RTCSessionDescription(answer))
}

async function handleIceCandidate(fromId, payload) {
  // payload.role é o papel de QUEM ENVIOU nessa conexão específica — pra
  // mim, o candidato é da conexão oposta: se ele mandou como 'watcher'
  // (ele assistindo a mim), esse candidato é da MINHA conexão de sharer
  // com ele, e vice-versa.
  const role = payload?.role === 'watcher' ? 'sharer' : 'watcher'
  const pc = role === 'watcher' ? state.watchPeers[fromId] : state.sharePeers[fromId]
  if (!pc) {
    console.warn('[ICE] Peer não encontrado para', fromId, role)
    return
  }
  try {
    await pc.addIceCandidate(new RTCIceCandidate(payload.candidate))
  } catch (e) {
    console.warn('[ICE ERROR]', e)
  }
}

// ──────────────────────────────────────────────
// QUALIDADE POR ESPECTADOR — quem assiste escolhe 360p/480p/720p/1080p ou
// automática pra economizar banda (ver seletor em upsertStreamCard). Como
// cada par usuário↔usuário tem sua própria RTCPeerConnection
// (state.sharePeers), dá pra ajustar o encoder por espectador sem afetar
// quem está assistindo em qualidade automática/alta — não é simulcast, é
// só o mesmo vídeo sendo reescalado/recomprimido nessa conexão específica.
// ──────────────────────────────────────────────
const QUALITY_BITRATE_KBPS = { 360: 600, 480: 1000, 720: 2500, 1080: 4000 }

async function applyViewerQuality(viewerId, requestedHeight) {
  const pc = state.sharePeers[viewerId]
  if (!pc) return
  const sender = pc.getSenders().find(s => s.track && s.track.kind === 'video')
  if (!sender) return

  const nativeHeight = state.localStream?.getVideoTracks()[0]?.getSettings()?.height

  try {
    const params = sender.getParameters()
    if (!params.encodings || params.encodings.length === 0) params.encodings = [{}]

    if (!requestedHeight || !nativeHeight) {
      // "Automática" — volta a mandar na resolução nativa capturada
      delete params.encodings[0].scaleResolutionDownBy
      delete params.encodings[0].maxBitrate
    } else {
      params.encodings[0].scaleResolutionDownBy = Math.max(1, nativeHeight / requestedHeight)
      params.encodings[0].maxBitrate = (QUALITY_BITRATE_KBPS[requestedHeight] || 2000) * 1000
    }

    await sender.setParameters(params)
    appLog('INFO', `Qualidade ajustada para ${viewerId}: ${requestedHeight ? requestedHeight + 'p' : 'automática'}`)
  } catch (err) {
    console.warn('[QUALITY] Falha ao ajustar parâmetros do encoder:', err)
  }
}

function closeWatchPeer(uid) {
  state.watchPeers[uid]?.close()
  delete state.watchPeers[uid]
  delete state.remoteStreams[uid]
}

function closeSharePeer(uid) {
  state.sharePeers[uid]?.close()
  delete state.sharePeers[uid]
}

// ══════════════════════════════════════════════════════════════
// CHAT DE VOZ
// Reaproveita a mesma sinalização WebRTC do compartilhamento de tela
// (offer/answer/ice-candidate, ver context.MD → Fluxo WebSocket e o
// dispatcher em handleMessage) — o que muda é payload.kind: 'voice' e o
// fato de a conexão ser bidirecional (cada RTCPeerConnection já manda E
// recebe áudio, ao contrário de watchPeers/sharePeers que são unidirecionais).
//
// Quem inicia a oferta: só quem ACABA de entrar na sala, pra cada membro
// já existente (ver initVoiceChat, chamado no 'room-info'). Quem já
// estava na sala nunca oferta pro recém-chegado — só responde a oferta
// dele. Isso evita duas ofertas simultâneas (glare) entre o mesmo par.
// ══════════════════════════════════════════════════════════════

async function initVoiceChat() {
  await ensureLocalMicStream()
  applyMicMuteState()
  startSpeakingLoop()
  for (const uid of Object.keys(state.users)) {
    if (!state.voicePeers[uid]) startVoicePeerConnection(uid)
  }
}

// Captura o microfone uma única vez por sessão de sala — a mesma
// MediaStreamTrack é adicionada em todas as conexões de voz.
async function ensureLocalMicStream() {
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

function createVoicePeer(remoteId) {
  if (state.voicePeers[remoteId]) {
    state.voicePeers[remoteId].close()
    delete state.voicePeers[remoteId]
  }

  const pc = new RTCPeerConnection(ICE_CONFIG)
  state.voicePeers[remoteId] = pc

  if (state.localMicStream) {
    state.localMicStream.getAudioTracks().forEach(track => pc.addTrack(track, state.localMicStream))
  }

  pc.onicecandidate = (e) => {
    if (e.candidate) {
      sendWS({ type: 'ice-candidate', to: remoteId, payload: { candidate: e.candidate, kind: 'voice' } })
    }
  }

  pc.onconnectionstatechange = () => {
    console.log(`[VOICE CONN ${remoteId}]`, pc.connectionState)
    if (pc.connectionState === 'failed' || pc.connectionState === 'closed') {
      closeVoicePeer(remoteId)
    }
  }

  // Bidirecional: a mesma conexão recebe o áudio de quem está do outro lado.
  pc.ontrack = (e) => {
    const stream = e.streams[0]
    if (!stream) return

    let audioEl = state.voiceAudioEls[remoteId]
    if (!audioEl) {
      audioEl = document.createElement('audio')
      audioEl.autoplay = true
      $('voice-audio-container').appendChild(audioEl)
      state.voiceAudioEls[remoteId] = audioEl
      applyOutputDevice(audioEl)
    }

    // Guarda a stream crua e descarta qualquer cadeia de ganho antiga (uma
    // reconexão manda uma stream nova) — quem decide se toca ela direto ou
    // passa pelo GainNode é applyVoiceVolume, de acordo com o volume atual.
    state.voiceRawStreams[remoteId] = stream
    removeVoiceAmplifier(remoteId)
    applyVoiceVolume(remoteId)

    setupRemoteVoiceAnalyser(remoteId, stream)
  }

  return pc
}

async function startVoicePeerConnection(remoteId) {
  await ensureLocalMicStream()
  const pc = createVoicePeer(remoteId)
  const offer = await pc.createOffer({ offerToReceiveAudio: true })
  await pc.setLocalDescription(offer)
  sendWS({ type: 'offer', to: remoteId, payload: { ...offer, kind: 'voice' } })
}

async function handleVoiceOffer(fromId, payload) {
  await ensureLocalMicStream()
  const pc = createVoicePeer(fromId)
  await pc.setRemoteDescription(new RTCSessionDescription({ type: payload.type, sdp: payload.sdp }))
  const answer = await pc.createAnswer()
  await pc.setLocalDescription(answer)
  sendWS({ type: 'answer', to: fromId, payload: { ...answer, kind: 'voice' } })
}

async function handleVoiceAnswer(fromId, payload) {
  const pc = state.voicePeers[fromId]
  if (!pc) return
  await pc.setRemoteDescription(new RTCSessionDescription({ type: payload.type, sdp: payload.sdp }))
}

async function handleVoiceIceCandidate(fromId, payload) {
  const pc = state.voicePeers[fromId]
  if (!pc) return
  try {
    await pc.addIceCandidate(new RTCIceCandidate(payload.candidate))
  } catch (e) {
    console.warn('[VOICE ICE ERROR]', e)
  }
}

function closeVoicePeer(uid) {
  state.voicePeers[uid]?.close()
  delete state.voicePeers[uid]
  const audioEl = state.voiceAudioEls[uid]
  if (audioEl) {
    audioEl.srcObject = null
    audioEl.remove()
    delete state.voiceAudioEls[uid]
  }
  delete state.voiceRawStreams[uid]
  removeVoiceAmplifier(uid)
  removeVoiceAnalyser(uid)
  removeRemoteVoiceSource(uid)
  state.speaking.delete(uid)
  updateSpeakingIndicators()
}

// ── Mutar/desmutar meu microfone (botão da sidebar + toggle nas
//    Configurações, ambos controlam o mesmo estado) ──
function applyMicMuteState() {
  state.localMicStream?.getAudioTracks().forEach(t => { t.enabled = !state.micMuted })

  const micBtn = $('btn-toggle-mic')
  micBtn.classList.toggle('muted', state.micMuted)
  micBtn.title = state.micMuted ? 'Ativar microfone' : 'Mutar microfone'
  micBtn.querySelector('.mic-icon').textContent = state.micMuted ? '🔇' : '🎤'

  const chk = $('chk-mic-muted')
  if (chk) chk.checked = state.micMuted
}

$('btn-toggle-mic').onclick = async () => {
  if (!state.localMicStream) await ensureLocalMicStream()
  state.micMuted = !state.micMuted
  sessionStorage.setItem(MIC_MUTED_KEY, String(state.micMuted))
  applyMicMuteState()
}

$('chk-mic-muted').onchange = () => {
  state.micMuted = $('chk-mic-muted').checked
  sessionStorage.setItem(MIC_MUTED_KEY, String(state.micMuted))
  applyMicMuteState()
}

// ── Amplificador de voz — GainNode por participante, só quando precisa ──
// HTMLMediaElement.volume só aceita 0–1 (0–100%): jogar 1.5 ali dá exceção.
// Então, ATÉ 100%, o <audio> toca a stream crua do WebRTC direto — igual
// sempre funcionou — e só ganha ao Web Audio quando o volume pedido passa
// de 100% (ver applyVoiceVolume), caso em que uma cadeia
// GainNode→DynamicsCompressorNode→MediaStreamDestination amplifica de
// verdade antes de chegar no <audio> (o compressor evita estourar/distorcer
// perto de 200%). Isso mantém o caso comum (0–100%) livre de qualquer
// dependência do Web Audio, sem risco de regressão nele.
// Usa a MESMA fonte compartilhada do analisador (ver getRemoteVoiceSource
// acima) — nunca cria uma segunda fonte pra mesma stream.
// voiceGainNodes: uid -> { source, gain, compressor, dest }
const voiceGainNodes = {}

function setupVoiceAmplifier(uid, stream) {
  try {
    const ctx = getVoiceAudioContext()
    const source = getRemoteVoiceSource(uid, stream)
    const gain = ctx.createGain()
    const compressor = ctx.createDynamicsCompressor()
    const dest = ctx.createMediaStreamDestination()
    source.connect(gain)
    gain.connect(compressor)
    compressor.connect(dest)
    voiceGainNodes[uid] = { source, gain, compressor, dest }
    return dest.stream
  } catch (err) {
    console.warn(`[VOICE AMP] Falha ao montar cadeia de ganho para ${uid}, ficando limitado a 100%:`, err)
    return null
  }
}

function removeVoiceAmplifier(uid) {
  const chain = voiceGainNodes[uid]
  if (!chain) return
  // Só desconecta a ligação fonte→ganho — a fonte é compartilhada com o
  // analisador de "quem está falando" (ver getRemoteVoiceSource), então um
  // disconnect() sem alvo na fonte cortaria a análise de voz junto.
  try { chain.source.disconnect(chain.gain) } catch { /* já desconectado */ }
  try { chain.gain.disconnect() } catch { /* já desconectado */ }
  try { chain.compressor.disconnect() } catch { /* já desconectado */ }
  delete voiceGainNodes[uid]
}

// ── Volume por participante (local — não afeta o que os outros ouvem) ──
// Vai de 0% a 200%: 100% é o volume original recebido, e dali pra cima
// amplifica de verdade (não é só "desmutar mais alto") via GainNode acima.
function getParticipantVolume(uid) {
  return state.participantVolumes[uid] ?? 100
}

function applyVoiceVolume(uid) {
  const audioEl = state.voiceAudioEls[uid]
  const rawStream = state.voiceRawStreams[uid]
  if (!audioEl || !rawStream) { updateParticipantVolIndicator(uid); return }

  const vol = getParticipantVolume(uid)
  const effective = (state.masterVolume / 100) * (vol / 100)

  if (effective <= 1) {
    // Caminho direto, sem Web Audio — o mesmo que já funcionava antes do
    // amplificador existir, e continua sendo o padrão até 100%.
    removeVoiceAmplifier(uid)
    if (audioEl.srcObject !== rawStream) {
      audioEl.srcObject = rawStream
      audioEl.play().catch((err) => console.warn(`[VOICE] Autoplay bloqueado para ${uid}:`, err))
    }
    audioEl.volume = effective
  } else {
    // >100% — o <audio> sozinho não sobe daqui, precisa do GainNode.
    audioEl.volume = 1
    let chain = voiceGainNodes[uid]
    if (!chain) {
      const amplifiedStream = setupVoiceAmplifier(uid, rawStream)
      chain = voiceGainNodes[uid]
      if (amplifiedStream && audioEl.srcObject !== amplifiedStream) {
        audioEl.srcObject = amplifiedStream
        audioEl.play().catch((err) => console.warn(`[VOICE] Autoplay bloqueado para ${uid}:`, err))
      }
    }
    if (chain) chain.gain.gain.setTargetAtTime(effective, chain.gain.context.currentTime, 0.01)
  }

  audioEl.muted = effective === 0
  updateParticipantVolIndicator(uid)
}

function applyAllVoiceVolumes() {
  Object.keys(state.voiceAudioEls).forEach(applyVoiceVolume)
}

function updateParticipantVolIndicator(uid) {
  const el = document.querySelector(`.participant-item[data-uid="${uid}"] .participant-vol-indicator`)
  if (!el) return
  const vol = getParticipantVolume(uid)
  // Acima de 100% é amplificação de verdade (ganho > 1×, ver
  // setupVoiceAmplifier) — o ícone de megafone deixa isso visível de longe,
  // sem precisar abrir o popover pra ver o número.
  el.textContent = vol === 0 ? '🔇' : (vol > 100 ? '📢' : '🔊')
  el.title = vol === 0 ? 'Mutado — clique para ajustar' : `Volume: ${vol}% — clique para ajustar`
}

// Popover de volume (mesmo slider .vol-icon/.vol-slider dos cards de
// stream) — painel fixo (não preso à lista, que tem scroll próprio),
// posicionado ao lado do participante clicado.
let volumePopoverUid = null

function toggleParticipantVolumePopover(uid, li) {
  const popover = $('participant-volume-popover')
  if (volumePopoverUid === uid && !popover.classList.contains('hidden')) {
    closeParticipantVolumePopover()
  } else {
    openParticipantVolumePopover(uid, li)
  }
}

function openParticipantVolumePopover(uid, li) {
  const popover = $('participant-volume-popover')
  const rect = li.getBoundingClientRect()
  popover.style.left = `${rect.right + 8}px`
  popover.style.top = `${rect.top}px`
  popover.classList.remove('hidden')
  volumePopoverUid = uid

  $('pv-username').textContent = state.users[uid]?.username || 'Participante'
  const vol = getParticipantVolume(uid)
  $('pv-slider').value = vol
  $('pv-value').textContent = `${vol}%`
  updatePvMuteIcon(vol)
}

function closeParticipantVolumePopover() {
  $('participant-volume-popover').classList.add('hidden')
  volumePopoverUid = null
}

function updatePvMuteIcon(vol) {
  const icon = $('pv-mute-btn')
  icon.textContent = vol === 0 ? '🔇' : (vol > 100 ? '📢' : '🔊')
  icon.classList.toggle('muted', vol === 0)
}

$('pv-slider').addEventListener('click', (e) => e.stopPropagation())
$('pv-slider').addEventListener('input', () => {
  if (!volumePopoverUid) return
  const v = Number($('pv-slider').value)
  if (v > 0) state.participantLastVolume[volumePopoverUid] = v
  state.participantVolumes[volumePopoverUid] = v
  applyVoiceVolume(volumePopoverUid)
  $('pv-value').textContent = `${v}%`
  updatePvMuteIcon(v)
})

$('pv-mute-btn').addEventListener('click', (e) => {
  e.stopPropagation()
  if (!volumePopoverUid) return
  const current = getParticipantVolume(volumePopoverUid)
  if (current > 0) {
    state.participantLastVolume[volumePopoverUid] = current
    state.participantVolumes[volumePopoverUid] = 0
  } else {
    state.participantVolumes[volumePopoverUid] = state.participantLastVolume[volumePopoverUid] || 100
  }
  const newVol = state.participantVolumes[volumePopoverUid]
  applyVoiceVolume(volumePopoverUid)
  $('pv-slider').value = newVol
  $('pv-value').textContent = `${newVol}%`
  updatePvMuteIcon(newVol)
})

$('participant-volume-popover').addEventListener('click', (e) => e.stopPropagation())

// Clicar fora do popover (e fora de qualquer participante — que já tem seu
// próprio toggle) fecha o painel.
document.addEventListener('click', (e) => {
  const popover = $('participant-volume-popover')
  if (popover.classList.contains('hidden')) return
  if (e.target.closest('.participant-item')) return
  closeParticipantVolumePopover()
})

// ── Detecção de "quem está falando" — AnalyserNode local por stream de
//    voz (incluindo o próprio microfone), sem precisar de nenhuma
//    mensagem nova no WebSocket. ──
let voiceAudioCtx = null
function getVoiceAudioContext() {
  if (!voiceAudioCtx) voiceAudioCtx = new AudioContext()
  if (voiceAudioCtx.state === 'suspended') voiceAudioCtx.resume().catch(() => {})
  return voiceAudioCtx
}

const voiceAnalysers = {} // uid (ou '__self__') -> { analyser, dataArray }

function setupLocalVoiceAnalyser(stream) {
  try {
    const ctx = getVoiceAudioContext()
    const source = ctx.createMediaStreamSource(stream)
    const analyser = ctx.createAnalyser()
    analyser.fftSize = 512
    source.connect(analyser) // só análise — não conecta no destino (senão ecoaria o próprio mic)
    voiceAnalysers['__self__'] = { analyser, dataArray: new Uint8Array(analyser.fftSize) }
  } catch (err) {
    console.warn('[VAD] Falha ao configurar análise do microfone local:', err)
  }
}

// Um único MediaStreamAudioSourceNode por stream remota, compartilhado entre
// o analisador de "quem está falando" (abaixo) e o amplificador de voz (ver
// setupVoiceAmplifier) — dois source nodes puxando a MESMA MediaStream ao
// mesmo tempo é instável no Chromium (o segundo fica mudo em vez de dar
// erro), e foi exatamente isso que travava o áudio ao passar de 100%: o
// amplificador criava sua própria fonte, concorrendo com a do analisador.
// uid -> { source, stream }
const remoteVoiceSources = {}

function getRemoteVoiceSource(uid, stream) {
  const ctx = getVoiceAudioContext()
  const entry = remoteVoiceSources[uid]
  if (entry && entry.stream === stream) return entry.source
  if (entry) { try { entry.source.disconnect() } catch { /* já desconectado */ } }
  const source = ctx.createMediaStreamSource(stream)
  remoteVoiceSources[uid] = { source, stream }
  return source
}

function removeRemoteVoiceSource(uid) {
  const entry = remoteVoiceSources[uid]
  if (!entry) return
  try { entry.source.disconnect() } catch { /* já desconectado */ }
  delete remoteVoiceSources[uid]
}

function setupRemoteVoiceAnalyser(uid, stream) {
  try {
    const source = getRemoteVoiceSource(uid, stream)
    const analyser = getVoiceAudioContext().createAnalyser()
    analyser.fftSize = 512
    source.connect(analyser)
    voiceAnalysers[uid] = { analyser, dataArray: new Uint8Array(analyser.fftSize) }
  } catch (err) {
    console.warn(`[VAD] Falha ao configurar análise de voz de ${uid}:`, err)
  }
}

function removeVoiceAnalyser(uid) { delete voiceAnalysers[uid] }

const SPEAKING_THRESHOLD = 0.02 // RMS mínimo pra considerar "falando"
let speakingLoopTimer = null

function startSpeakingLoop() {
  if (speakingLoopTimer) return
  speakingLoopTimer = setInterval(() => {
    let changed = false
    for (const [key, { analyser, dataArray }] of Object.entries(voiceAnalysers)) {
      analyser.getByteTimeDomainData(dataArray)
      let sum = 0
      for (let i = 0; i < dataArray.length; i++) {
        const v = (dataArray[i] - 128) / 128
        sum += v * v
      }
      const rms = Math.sqrt(sum / dataArray.length)
      const uid = key === '__self__' ? state.myId : key
      const isSpeaking = rms > SPEAKING_THRESHOLD && (key === '__self__' ? !state.micMuted : true)
      const was = state.speaking.has(uid)
      if (isSpeaking && !was) { state.speaking.add(uid); changed = true }
      else if (!isSpeaking && was) { state.speaking.delete(uid); changed = true }
    }
    if (changed) updateSpeakingIndicators()
  }, 200)
}

function stopSpeakingLoop() {
  clearInterval(speakingLoopTimer)
  speakingLoopTimer = null
}

function updateSpeakingIndicators() {
  document.querySelectorAll('.participant-item').forEach(li => {
    const avatar = li.querySelector('.participant-avatar')
    avatar?.classList.toggle('speaking', state.speaking.has(li.dataset.uid))
  })
}

// ── Dispositivos de áudio (Configurações → Áudio) ──
async function populateAudioDeviceSelects() {
  try {
    const devices = await navigator.mediaDevices.enumerateDevices()
    const mics = devices.filter(d => d.kind === 'audioinput')
    const outputs = devices.filter(d => d.kind === 'audiooutput')

    const micSelect = $('select-mic')
    micSelect.innerHTML = '<option value="">Padrão do sistema</option>'
      + mics.map(d => `<option value="${d.deviceId}">${d.label || 'Microfone'}</option>`).join('')
    micSelect.value = state.micDeviceId || ''

    // setSinkId (escolher saída) só existe em navegadores baseados em
    // Chromium — esconde o seletor quando não suportado em vez de mostrar
    // uma opção que não faz nada.
    const outRow = $('select-speaker').closest('.settings-row')
    if (typeof HTMLMediaElement.prototype.setSinkId === 'function' && outputs.length) {
      outRow.classList.remove('hidden')
      const outSelect = $('select-speaker')
      outSelect.innerHTML = '<option value="">Padrão do sistema</option>'
        + outputs.map(d => `<option value="${d.deviceId}">${d.label || 'Saída de áudio'}</option>`).join('')
      outSelect.value = state.speakerDeviceId || ''
    } else {
      outRow.classList.add('hidden')
    }
  } catch (err) {
    appLog('WARN', `Falha ao listar dispositivos de áudio: ${err.message}`)
  }
}

// Atualiza a lista quando um dispositivo é plugado/removido enquanto o
// modal está aberto.
navigator.mediaDevices?.addEventListener?.('devicechange', () => {
  if (!$('modal-settings').classList.contains('hidden')) populateAudioDeviceSelects()
})

$('select-mic').addEventListener('change', async () => {
  await switchMicDevice($('select-mic').value)
})

async function switchMicDevice(deviceId) {
  state.micDeviceId = deviceId
  sessionStorage.setItem(MIC_DEVICE_KEY, deviceId)
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

$('select-speaker').addEventListener('change', async () => {
  state.speakerDeviceId = $('select-speaker').value
  sessionStorage.setItem(SPEAKER_DEVICE_KEY, state.speakerDeviceId)
  // Aplica no áudio de cada participante já conectado e no áudio de teste.
  await Promise.all(Object.values(state.voiceAudioEls).map(applyOutputDevice))
  await applyOutputDevice($('mic-test-audio'))
})

async function applyOutputDevice(audioEl) {
  if (!state.speakerDeviceId || typeof audioEl.setSinkId !== 'function') return
  try {
    await audioEl.setSinkId(state.speakerDeviceId)
  } catch (err) {
    console.warn('[SINK] Falha ao aplicar dispositivo de saída:', err)
  }
}

// ── Volume geral (Configurações → Áudio) ──
// Vai só de 0% a 100% — quem amplifica além disso é o volume individual de
// cada participante (ver participantVolumes/applyVoiceVolume). Este aqui só
// abaixa tudo de uma vez, sem perder o ajuste fino de cada um.
const masterVolumeSlider = $('master-volume-slider')
const masterVolumeValue = $('master-volume-value')
masterVolumeSlider.value = state.masterVolume
masterVolumeValue.textContent = `${state.masterVolume}%`
masterVolumeSlider.addEventListener('input', () => {
  state.masterVolume = Number(masterVolumeSlider.value)
  masterVolumeValue.textContent = `${state.masterVolume}%`
  sessionStorage.setItem(MASTER_VOLUME_KEY, String(state.masterVolume))
  applyAllVoiceVolumes()
})

const chkNoiseSuppression = $('chk-noise-suppression')
chkNoiseSuppression.checked = state.noiseSuppression
chkNoiseSuppression.onchange = async () => {
  state.noiseSuppression = chkNoiseSuppression.checked
  sessionStorage.setItem(NOISE_SUPPRESSION_KEY, String(state.noiseSuppression))
  if (state.localMicStream) await switchMicDevice(state.micDeviceId)
}

const noiseSuppressionSlider = $('noise-suppression-slider')
const noiseSuppressionValue = $('noise-suppression-value')
noiseSuppressionSlider.value = state.noiseIntensity
noiseSuppressionValue.value = `${state.noiseIntensity}%`
noiseSuppressionSlider.addEventListener('input', () => {
  state.noiseIntensity = Number(noiseSuppressionSlider.value)
  noiseSuppressionValue.value = `${state.noiseIntensity}%`
  sessionStorage.setItem(NOISE_INTENSITY_KEY, String(state.noiseIntensity))
  updateNoiseIntensity()
})

// ── Testar microfone e saída (loopback local, com medidor de nível) ──
let micTestStream = null
let micTestAnalyser = null
let micTestRAF = null

$('btn-test-mic').onclick = () => {
  if (micTestStream) stopMicTest()
  else startMicTest()
}

async function startMicTest() {
  try {
    const constraints = { audio: state.micDeviceId ? { deviceId: { exact: state.micDeviceId } } : true }
    micTestStream = await navigator.mediaDevices.getUserMedia(constraints)

    const audioEl = $('mic-test-audio')
    audioEl.srcObject = micTestStream
    audioEl.muted = false
    // HTMLMediaElement.volume só aceita 0–1 — o volume geral fica travado
    // em 0-100% (ver state.masterVolume), mas o Math.min é uma rede de
    // segurança pra não derrubar o teste com "IndexSizeError: value must
    // be in [0, 1]" caso sobre algum valor antigo >100 salvo no navegador.
    audioEl.volume = Math.min(1, state.masterVolume / 100)
    await applyOutputDevice(audioEl)
    await audioEl.play().catch(() => {})

    const ctx = getVoiceAudioContext()
    const source = ctx.createMediaStreamSource(micTestStream)
    micTestAnalyser = ctx.createAnalyser()
    micTestAnalyser.fftSize = 256
    source.connect(micTestAnalyser)

    $('btn-test-mic').textContent = 'Parar teste'
    $('mic-test-meter').classList.remove('hidden')
    runMicTestMeter()
  } catch (err) {
    appLog('WARN', `Falha ao testar microfone: ${err.message}`)
    toast('Não foi possível acessar o microfone para o teste.')
  }
}

function runMicTestMeter() {
  if (!micTestAnalyser) return
  const data = new Uint8Array(micTestAnalyser.fftSize)
  micTestAnalyser.getByteTimeDomainData(data)
  let sum = 0
  for (let i = 0; i < data.length; i++) {
    const v = (data[i] - 128) / 128
    sum += v * v
  }
  const rms = Math.sqrt(sum / data.length)
  $('mic-test-meter-fill').style.width = `${Math.min(100, Math.round(rms * 220))}%`
  micTestRAF = requestAnimationFrame(runMicTestMeter)
}

function stopMicTest() {
  cancelAnimationFrame(micTestRAF)
  micTestRAF = null
  micTestAnalyser = null
  micTestStream?.getTracks().forEach(t => t.stop())
  micTestStream = null

  const audioEl = $('mic-test-audio')
  audioEl.pause()
  audioEl.srcObject = null

  $('btn-test-mic').textContent = 'Testar microfone e saída'
  $('mic-test-meter').classList.add('hidden')
  $('mic-test-meter-fill').style.width = '0%'
}

function removeUser(uid) {
  delete state.users[uid]
  state.watching.delete(uid)
  state.connecting.delete(uid)
  delete state.screenSnapshots[uid]
  closeWatchPeer(uid)
  closeSharePeer(uid)
  closeVoicePeer(uid)
  delete state.participantVolumes[uid]
  delete state.participantLastVolume[uid]
  if (volumePopoverUid === uid) closeParticipantVolumePopover()
  removeStreamCard(uid)
  renderParticipants()
}

// ──────────────────────────────────────────────
// CONFIGURAÇÕES — modal com opções por seção (por enquanto só "Live").
// Botão fica meio a meio com o de compartilhar na sidebar.
// ──────────────────────────────────────────────
$('btn-settings').onclick = () => {
  $('modal-settings').classList.remove('hidden')
  populateAudioDeviceSelects()
}
$('btn-close-settings').onclick = () => {
  $('modal-settings').classList.add('hidden')
  stopMicTest() // não deixa o loopback do teste de mic tocando escondido
}
$('modal-settings').onclick = (e) => {
  if (e.target === $('modal-settings')) {
    $('modal-settings').classList.add('hidden')
    stopMicTest()
  }
}

document.querySelectorAll('.settings-tab').forEach((tab) => {
  tab.onclick = () => {
    const selectedTab = tab.dataset.settingsTab
    document.querySelectorAll('.settings-tab').forEach((item) => {
      const isActive = item === tab
      item.classList.toggle('active', isActive)
      item.setAttribute('aria-selected', String(isActive))
    })
    document.querySelectorAll('.settings-panel').forEach((panel) => {
      const isActive = panel.id === `settings-${selectedTab}`
      panel.classList.toggle('active', isActive)
      panel.hidden = !isActive
    })
  }
})

// Autovisualização — opcional, canto inferior direito, sempre mudo.
// Preferência salva em sessionStorage e usada como padrão dali pra frente.
const chkSelfPreview = $('chk-self-preview')
chkSelfPreview.checked = state.showSelfPreview

chkSelfPreview.onchange = () => {
  state.showSelfPreview = chkSelfPreview.checked
  sessionStorage.setItem(SELF_PREVIEW_KEY, String(state.showSelfPreview))
  updateSelfPreview()
}

// Qualidade padrão ao assistir — aplicada de saída a cada nova live que
// você começa a assistir; a pessoa ainda pode trocar na hora, por live, no
// seletor do próprio card (ver upsertStreamCard).
const selDefaultWatchQuality = $('default-watch-quality')
selDefaultWatchQuality.value = state.defaultWatchQuality

selDefaultWatchQuality.onchange = () => {
  state.defaultWatchQuality = selDefaultWatchQuality.value
  sessionStorage.setItem(DEFAULT_WATCH_QUALITY_KEY, state.defaultWatchQuality)
}

function updateSelfPreview() {
  const wrap = $('self-preview')
  const video = $('self-preview-video')
  const show = state.sharing && state.showSelfPreview && state.localStream

  wrap.classList.toggle('hidden', !show)

  if (!show) {
    video.srcObject = null
    return
  }

  // Sempre mudo — é só uma prévia local, nunca deve tocar som (o pedido
  // era explícito: "que não transmita som"). Não é enviada a ninguém, é a
  // mesma state.localStream que já vai pros outros participantes.
  video.muted = true
  if (video.srcObject !== state.localStream) {
    video.srcObject = state.localStream
    video.play().catch(() => {})
  }
}

// ──────────────────────────────────────────────
// SNAPSHOT PERIÓDICO — pra prévia de quem não está assistindo (sidebar)
// Manda um JPEG pequeno pra sala ao começar a compartilhar e depois a
// cada 3min. Usa um <video> escondido dedicado (#snapshot-source-video)
// em vez do vídeo da autovisualização, porque a autovisualização só
// existe quando a pessoa ativa aquela preferência opcional — o snapshot
// precisa funcionar sempre, independente disso.
// ──────────────────────────────────────────────
const SNAPSHOT_INTERVAL_MS = 3 * 60 * 1000

function startSnapshotLoop() {
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

function stopSnapshotLoop() {
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

// ──────────────────────────────────────────────
// COMPARTILHAR TELA
// ──────────────────────────────────────────────
$('btn-toggle-share').onclick = async () => {
  if (state.sharing) {
    stopSharing()
  } else {
    await startSharing()
  }
}

// Qualidade de transmissão — resolução (altura, em px) e taxa de quadros.
// Escolhidas no modal de fonte, aplicadas como constraints da captura.
const QUALITY_HEIGHTS = { 720: { width: 1280, height: 720 }, 1080: { width: 1920, height: 1080 } }
let selectedSourceId = null
let selectedQuality = {
  resolution: 1080,
  fps: 30,
  // Vem por padrão com som; se a pessoa mudar no modal, fica salvo em
  // sessionStorage e essa vira a escolha padrão dali pra frente.
  audio: sessionStorage.getItem(SHARE_AUDIO_KEY) !== 'off',
}

async function startSharing() {
  // Pede ao main process a lista de fontes
  const sources = await window.electronAPI.getSources()
  selectedSourceId = null
  showSourcePicker(sources)
}

function showSourcePicker(sources) {
  const grid = $('source-grid')
  grid.innerHTML = ''

  sources.forEach(src => {
    const div = document.createElement('div')
    div.className = 'source-item'
    div.dataset.sourceId = src.id
    div.innerHTML = `
      <img class="source-thumb" src="${src.thumbnail}" alt="${src.name}" />
      <div class="source-label">${src.name}</div>
    `
    div.onclick = () => selectSource(src.id)
    grid.appendChild(div)
  })

  updateTransmitButton()
  $('modal-source').classList.remove('hidden')
}

// Seleciona a fonte (tela/janela) sem já iniciar a transmissão — quem
// dispara é o botão "Transmitir", depois de escolher a qualidade também.
function selectSource(sourceId) {
  selectedSourceId = sourceId
  $('source-grid').querySelectorAll('.source-item').forEach(el => {
    el.classList.toggle('selected', el.dataset.sourceId === sourceId)
  })
  updateTransmitButton()
}

function updateTransmitButton() {
  $('btn-start-transmit').disabled = !selectedSourceId
}

// Grupos de botões de qualidade (resolução / FPS / áudio) — só um ativo
// por grupo. `parse` converte o data-value do botão (número pra
// resolução/fps, texto cru pro grupo de áudio).
function setupQualityGroup(containerId, onChange, parse = Number) {
  const container = $(containerId)
  container.querySelectorAll('.quality-opt').forEach(btn => {
    btn.onclick = () => {
      container.querySelectorAll('.quality-opt').forEach(b => b.classList.remove('active'))
      btn.classList.add('active')
      onChange(parse(btn.dataset.value))
    }
  })
}
setupQualityGroup('quality-resolution', (v) => { selectedQuality.resolution = v })
setupQualityGroup('quality-fps', (v) => { selectedQuality.fps = v })
setupQualityGroup('quality-audio', (v) => {
  selectedQuality.audio = v === 'on'
  sessionStorage.setItem(SHARE_AUDIO_KEY, v)
}, (v) => v)

// Reflete a preferência salva no botão certo (o HTML vem com "Com som"
// marcado por padrão; se a sessão já tiver "Sem som" salvo, troca aqui).
if (!selectedQuality.audio) {
  $('quality-audio').querySelectorAll('.quality-opt').forEach(b => {
    b.classList.toggle('active', b.dataset.value === 'off')
  })
}

function closeSourceModal() {
  $('modal-source').classList.add('hidden')
  selectedSourceId = null
}

$('btn-close-modal').onclick = () => closeSourceModal()
$('modal-source').onclick = (e) => {
  if (e.target === $('modal-source')) closeSourceModal()
}

$('btn-start-transmit').onclick = () => {
  if (!selectedSourceId) return
  captureSource(selectedSourceId, selectedQuality)
}

// Constraints de vídeo (getDisplayMedia) pra qualidade escolhida
function buildVideoConstraints({ resolution, fps }) {
  const { width, height } = QUALITY_HEIGHTS[resolution] || QUALITY_HEIGHTS[1080]
  return {
    width:     { ideal: width, max: width },
    height:    { ideal: height, max: height },
    frameRate: { ideal: fps, max: fps },
  }
}

// Constraints equivalentes no formato antigo (mandatory), usado só no
// último fallback via getUserMedia + chromeMediaSourceId.
function buildMandatoryVideoConstraints(sourceId, { resolution, fps }) {
  const { width, height } = QUALITY_HEIGHTS[resolution] || QUALITY_HEIGHTS[1080]
  return {
    mandatory: {
      chromeMediaSource: 'desktop',
      chromeMediaSourceId: sourceId,
      minWidth: width, maxWidth: width,
      minHeight: height, maxHeight: height,
      minFrameRate: fps, maxFrameRate: fps,
    },
  }
}

// Fallback comum de captura só-vídeo — usado tanto quando a pessoa escolhe
// "Sem som" no modal quanto quando a captura de áudio falha em runtime.
async function captureVideoOnly(sourceId, quality) {
  try {
    return await navigator.mediaDevices.getDisplayMedia({ video: buildVideoConstraints(quality), audio: false })
  } catch {
    // Último recurso: getUserMedia com sourceId específico, só vídeo
    return await navigator.mediaDevices.getUserMedia({
      video: buildMandatoryVideoConstraints(sourceId, quality),
    })
  }
}

async function captureSource(sourceId, quality) {
  $('modal-source').classList.add('hidden')

  // Avisa o processo principal qual fonte usar quando o getDisplayMedia()
  // abaixo disparar o setDisplayMediaRequestHandler (main.js) — sem isso,
  // ele sempre pegava a primeira tela da lista, ignorando a escolhida aqui.
  window.electronAPI?.setCaptureSourceId(sourceId)

  try {
    let stream
    let audioIssue = null

    if (!quality.audio) {
      // Escolha explícita de "Sem som" no modal — nem tenta capturar áudio.
      stream = await captureVideoOnly(sourceId, quality)
    } else {
      // Tenta primeiro com getDisplayMedia, pedindo áudio do sistema (tela toda).
      // Obs: não há API do navegador/Electron para excluir o áudio de um app
      // específico (ex.: Discord) — só é possível incluir ou não o áudio inteiro.
      try {
        stream = await navigator.mediaDevices.getDisplayMedia({
          video: buildVideoConstraints(quality),
          audio: true,
          systemAudio: 'include',
        })
      } catch (err) {
        // "Could not start audio source" é a captura de loopback do Windows
        // falhando (dispositivo de saída em modo exclusivo, desconectado,
        // mudo, etc.) — isso não deveria impedir compartilhar o vídeo.
        const isAudioIssue = err?.name === 'NotReadableError' && /audio/i.test(err.message || '')
        if (!isAudioIssue) throw err

        audioIssue = err
        appLog('WARN', `Captura de áudio do sistema falhou (${err.message}) — tentando só vídeo`)
        stream = await captureVideoOnly(sourceId, quality)
      }
    }

    if (!stream || stream.getVideoTracks().length === 0) {
      toast('Nenhuma track de vídeo capturada.')
      return
    }

    const track = stream.getVideoTracks()[0]
    console.log('Stream capturada:', track.label, track.getSettings(),
      '| áudio:', stream.getAudioTracks().length > 0)

    state.localStream = stream
    state.sharing = true

    // Botão só com ícone (a sidebar ficou estreita demais pra caber texto
    // depois que virou grid 1fr/1fr com o de configurações) — o estado
    // (compartilhando ou não) fica no title (tooltip) e na cor de fundo.
    $('btn-toggle-share').classList.add('sharing')
    $('btn-toggle-share').title = 'Desligar compartilhamento'

    sendWS({ type: 'start-sharing' })

    track.onended = () => stopSharing()

    // Por padrão a própria tela compartilhada não aparece — só os outros
    // participantes a veem. Se a preferência estiver ativa, mostra a
    // prévia local mudinha no canto inferior direito (ver updateSelfPreview).
    updateSelfPreview()
    startSnapshotLoop()
    renderParticipants()
    appLog('INFO', `Compartilhamento iniciado (áudio: ${stream.getAudioTracks().length > 0}, `
      + `qualidade: ${quality.resolution}p@${quality.fps}fps)`)
    if (audioIssue) {
      toast('Compartilhando a tela sem áudio — não foi possível capturar o áudio do sistema.')
    } else {
      toast(stream.getAudioTracks().length
        ? 'Você está compartilhando a tela com áudio!'
        : 'Você está compartilhando a tela (sem áudio).')
    }

  } catch (err) {
    console.error('Erro ao capturar:', err)
    appLog('ERROR', `Falha ao capturar tela: ${err.message}`)
    toast(`Erro: ${err.message}`)
  }
}

// ──────────────────────────────────────────────
// STREAM CARDS
// ──────────────────────────────────────────────
function upsertStreamCard(uid, stream) {
  const grid = $('streams-grid')
  $('stage-empty').classList.add('hidden')
  grid.classList.remove('hidden')

  let card = grid.querySelector(`[data-stream="${uid}"]`)

  if (!card) {
    const username = state.users[uid]?.username || 'Usuário'
    card = document.createElement('div')
    card.className = 'stream-card'
    card.dataset.stream = uid
    card.innerHTML = `
      <div class="stream-header">
        <span class="stream-name">${username}</span>
        <div class="stream-header-actions">
          <span class="stream-stats" title="Resolução e bitrate recebidos agora"></span>

          <select class="quality-select" title="Qualidade da transmissão (economiza banda)">
            <option value="auto">Automática</option>
            <option value="1080">1080p</option>
            <option value="720">720p</option>
            <option value="480">480p</option>
            <option value="360">360p</option>
          </select>

          <div class="vol-control">
            <button type="button" class="vol-icon muted" title="Mutar/Desmutar">🔇</button>
            <div class="vol-popover">
              <input type="range" class="vol-slider" min="0" max="100" value="0" />
            </div>
            <div class="vol-tooltip hidden"></div>
          </div>

          <button type="button" class="fullscreen-btn" title="Tela cheia">⛶</button>
          <button type="button" class="pip-btn" title="Ver em Picture-in-Picture">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <rect x="3" y="5" width="18" height="14" rx="2"/>
              <path d="M9 15 L16 8"/>
              <path d="M11 8 H16 V13"/>
            </svg>
          </button>
        </div>
      </div>
      <div class="stream-video-wrap">
        <video class="stream-video" autoplay muted playsinline></video>
        <div class="stream-loading">
          <div class="spinner"></div>
          <span>Carregando tela…</span>
        </div>
      </div>
    `

    // Clicar na stream coloca ela em foco (as demais minimizam embaixo) —
    // não em tela cheia, onde um clique sem querer no vídeo não devia
    // mudar o foco por baixo dos panos.
    card.addEventListener('click', () => {
      if (document.fullscreenElement === card) return
      toggleFocus(uid)
    })

    // Zoom com o scroll do mouse — só nessa live específica (o wheel não
    // sobe pra rolar o resto da página), scroll pra cima aumenta, pra
    // baixo diminui. Aplicado só no vídeo (não no card inteiro) e sempre
    // em direção ao ponto onde está o cursor, pra não "fugir" a imagem.
    const videoWrap = card.querySelector('.stream-video-wrap')
    const zoomVideo = card.querySelector('video')
    let zoomLevel = 1
    const ZOOM_MIN = 1
    const ZOOM_MAX = 3
    const ZOOM_STEP = 0.15

    videoWrap.addEventListener('wheel', (e) => {
      e.preventDefault()
      e.stopPropagation()
      const next = zoomLevel + (e.deltaY < 0 ? ZOOM_STEP : -ZOOM_STEP)
      zoomLevel = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, next))

      const rect = videoWrap.getBoundingClientRect()
      const originX = ((e.clientX - rect.left) / rect.width) * 100
      const originY = ((e.clientY - rect.top) / rect.height) * 100
      zoomVideo.style.transformOrigin = `${originX}% ${originY}%`
      zoomVideo.style.transform = zoomLevel > 1 ? `scale(${zoomLevel.toFixed(2)})` : ''
      zoomVideo.classList.toggle('zoomed', zoomLevel > 1)
    }, { passive: false })

    // Controle de volume — passar o mouse já abre o slider (CSS
    // `:hover`, ver style.css), sem precisar clicar. Clicar no ícone
    // muta/desmuta direto. A porcentagem some junto com o slider quando o
    // mouse sai — enquanto arrasta, aparece como um tooltip preso no
    // próprio cursor, não fixo num lugar. A live sempre começa mutada
    // (0%) — a pessoa escolhe ativar o som.
    const video = card.querySelector('video')
    const slider = card.querySelector('.vol-slider')
    const volIcon = card.querySelector('.vol-icon')
    const volControl = card.querySelector('.vol-control')
    const volPopover = card.querySelector('.vol-popover')
    const volTooltip = card.querySelector('.vol-tooltip')
    let lastVolume = 100 // pra restaurar ao clicar no ícone depois de mutar

    // Abre/fecha o popover por JS (não só CSS :hover) — o popover é
    // position:absolute, então geometricamente ele fica FORA da caixa do
    // ícone; com só `:hover` puro, mover o mouse do ícone até o slider
    // passava por um instante fora de qualquer um dos dois e o popover
    // fechava no meio do caminho. Um pequeno atraso ao sair (e cancelado
    // se o mouse entrar no outro elemento a tempo) resolve isso.
    let volCloseTimer = null
    const openVolPopover = () => {
      clearTimeout(volCloseTimer)
      volControl.classList.add('open')
    }
    const scheduleCloseVolPopover = () => {
      clearTimeout(volCloseTimer)
      volCloseTimer = setTimeout(() => volControl.classList.remove('open'), 250)
    }
    volControl.addEventListener('mouseenter', openVolPopover)
    volControl.addEventListener('mouseleave', scheduleCloseVolPopover)
    volPopover.addEventListener('mouseenter', openVolPopover)
    volPopover.addEventListener('mouseleave', scheduleCloseVolPopover)

    // Transmissão sem áudio (a pessoa escolheu "Sem som" ao compartilhar,
    // ou a captura de áudio falhou) — bloqueia o controle de volume dessa
    // live específica, não tem o que ajustar.
    if (stream.getAudioTracks().length === 0) {
      slider.disabled = true
      volIcon.disabled = true
      volIcon.textContent = '🔇'
      volIcon.title = 'Esta transmissão não tem áudio'
      volIcon.classList.add('muted')
    }

    function syncVolumeIcon() {
      const muted = video.muted || Number(slider.value) === 0
      volIcon.textContent = muted ? '🔇' : '🔊'
      volIcon.classList.toggle('muted', muted)
    }

    // Clique no ícone = mutar/desmutar direto (não abre nada — abrir o
    // slider agora é só passar o mouse, ver openVolPopover/.vol-control.open acima).
    volIcon.addEventListener('click', (e) => {
      e.stopPropagation()
      const isMuted = video.muted || Number(slider.value) === 0
      if (isMuted) {
        const restore = lastVolume > 0 ? lastVolume : 100
        slider.value = restore
        video.volume = restore / 100
        video.muted = false
      } else {
        lastVolume = Number(slider.value) || lastVolume
        slider.value = 0
        video.volume = 0
        video.muted = true
      }
      syncVolumeIcon()
      if (video.paused) video.play().catch(() => {})
    })

    slider.addEventListener('click', (e) => e.stopPropagation())

    // Tooltip com a porcentagem grudado no cursor enquanto o mouse está
    // em cima do slider (arrastando ou não) — não fica fixo num canto.
    function moveVolTooltip(e) {
      volTooltip.textContent = `${slider.value}%`
      volTooltip.style.left = `${e.clientX}px`
      volTooltip.style.top = `${e.clientY}px`
    }
    slider.addEventListener('mouseenter', (e) => {
      moveVolTooltip(e)
      volTooltip.classList.remove('hidden')
    })
    slider.addEventListener('mousemove', moveVolTooltip)
    slider.addEventListener('mouseleave', () => volTooltip.classList.add('hidden'))

    slider.addEventListener('input', (e) => {
      const v = Number(slider.value)
      video.volume = v / 100
      // Se o autoplay mudo inicial não conseguiu desmutar sozinho (ver
      // comentário mais abaixo), essa interação do usuário é um gesto
      // válido pro navegador permitir desmutar aqui.
      video.muted = v === 0
      syncVolumeIcon()
      moveVolTooltip(e)
      if (video.paused) video.play().catch(() => {})
    })

    // Qualidade — quem assiste escolhe pra economizar banda (ver
    // applyViewerQuality, do lado de quem compartilha). `uid` aqui é quem
    // está compartilhando, então o pedido vai pra ele. Começa na qualidade
    // padrão definida em Configurações → Live (a pessoa ainda pode trocar
    // na hora, só pra essa live, pelo próprio seletor).
    const qualitySelect = card.querySelector('.quality-select')
    qualitySelect.value = state.defaultWatchQuality
    qualitySelect.addEventListener('click', (e) => e.stopPropagation())
    qualitySelect.addEventListener('change', () => {
      const height = qualitySelect.value === 'auto' ? null : Number(qualitySelect.value)
      appLog('INFO', `Pedindo qualidade ${height ? height + 'p' : 'automática'} de ${uid}`)
      sendWS({ type: 'set-quality', to: uid, payload: { height } })
    })
    if (state.defaultWatchQuality !== 'auto') {
      sendWS({ type: 'set-quality', to: uid, payload: { height: Number(state.defaultWatchQuality) } })
    }

    // Indicador de resolução/bitrate REAIS recebidos — prova concreta de
    // que o seletor de qualidade está funcionando (a olho, no vídeo, a
    // diferença nem sempre salta à vista: a caixa na tela continua do
    // mesmo tamanho, e tela compartilhada comprime bem mesmo em 1080p
    // quando tem pouco movimento).
    const statsEl = card.querySelector('.stream-stats')
    let lastBytes = 0
    let lastStatsTime = performance.now()
    state.statsIntervals[uid] = setInterval(async () => {
      const wp = state.watchPeers[uid]
      if (!wp || !statsEl) return
      try {
        const report = await wp.getStats()
        report.forEach(r => {
          if (r.type !== 'inbound-rtp' || r.kind !== 'video') return
          const now = performance.now()
          const dtSec = (now - lastStatsTime) / 1000
          const kbps = dtSec > 0 && lastBytes
            ? Math.max(0, Math.round(((r.bytesReceived - lastBytes) * 8) / dtSec / 1000))
            : 0
          lastBytes = r.bytesReceived
          lastStatsTime = now
          statsEl.textContent = r.frameWidth
            ? `${r.frameWidth}×${r.frameHeight} · ${kbps} kbps`
            : ''
        })
      } catch { /* pc pode já ter fechado entre o tick e a leitura */ }
    }, 2000)

    // Picture-in-Picture — janela flutuante nativa do SO, independente da
    // janela do app. O botão de fechar dela já é da própria janela nativa
    // (a gente só escuta o evento pra manter nosso botão sincronizado).
    const pipBtn = card.querySelector('.pip-btn')
    if (!document.pictureInPictureEnabled || video.disablePictureInPicture) {
      pipBtn.classList.add('hidden')
    } else {
      pipBtn.addEventListener('click', async (e) => {
        e.stopPropagation()
        try {
          if (document.pictureInPictureElement === video) {
            await document.exitPictureInPicture()
          } else {
            await video.requestPictureInPicture()
          }
        } catch (err) {
          console.warn('[PIP] Falha ao abrir Picture-in-Picture:', err)
          appLog('WARN', `Falha ao abrir Picture-in-Picture para ${uid}: ${err.message}`)
          toast('Não foi possível abrir o Picture-in-Picture.')
        }
      })
      video.addEventListener('enterpictureinpicture', () => pipBtn.classList.add('active'))
      video.addEventListener('leavepictureinpicture', () => pipBtn.classList.remove('active'))
    }

    // Tela cheia — fullscreena o card inteiro (não só o <video>), assim o
    // botão de sair e o controle de volume continuam na tela (reposicionados
    // via CSS `:fullscreen`, ver style.css) em vez de sumirem. O
    // sincronismo do botão e o reflow do grid ao sair ficam no listener
    // global de 'fullscreenchange' (ver mais abaixo).
    const fullscreenBtn = card.querySelector('.fullscreen-btn')
    if (!document.fullscreenEnabled) {
      fullscreenBtn.classList.add('hidden')
    } else {
      fullscreenBtn.addEventListener('click', async (e) => {
        e.stopPropagation()
        try {
          if (document.fullscreenElement === card) {
            await document.exitFullscreen()
          } else {
            await card.requestFullscreen()
          }
        } catch (err) {
          console.warn('[FULLSCREEN] Falha:', err)
          appLog('WARN', `Falha ao entrar em tela cheia para ${uid}: ${err.message}`)
          toast('Não foi possível entrar em tela cheia.')
        }
      })
    }

    grid.appendChild(card)
  }

  const video = card.querySelector('video')
  const loading = card.querySelector('.stream-loading')

  // Tela de carregando enquanto o vídeo da pessoa ainda não chegou
  loading?.classList.remove('hidden')
  video.onloadeddata = () => loading?.classList.add('hidden')

  // Uma tela compartilhada chega em tracks separadas (vídeo + áudio), cada
  // uma disparando ontrack → upsertStreamCard pra essa MESMA stream. Sem
  // essa checagem, chamávamos video.play() duas vezes quase juntas no
  // mesmo elemento, o que pode abortar uma chamada com a outra.
  if (video.srcObject !== stream) {
    // Corrige o bug da "tela preta": desde que passamos a compartilhar áudio
    // junto do vídeo, o Chromium/Electron bloqueia o autoplay de um <video>
    // não mutado com faixa de áudio sem interação do usuário — o vídeo nunca
    // chega a tocar e fica preto. A live sempre inicia mutada (0% — ver
    // template do card acima) então o autoplay é sempre permitido aqui;
    // quem assiste ativa o som depois, pelo ícone ou pelo slider.
    video.muted = true
    video.srcObject = stream
    video.volume = Number(card.querySelector('.vol-slider')?.value ?? 0) / 100
    video.play().catch((err) => {
      // AbortError: play() interrompido porque srcObject mudou antes do
      // promise resolver (ontrack dispara para vídeo e áudio em sequência).
      // Não é bloqueio real — o play() mais recente vai rodar sozinho.
      if (err.name === 'AbortError') return
      console.warn(`[AUTOPLAY] Bloqueado para ${uid}:`, err)
      appLog('WARN', `Autoplay bloqueado para stream de ${uid}: ${err.message}`)
    })
  }

  updateGridLayout()
}

function removeStreamCard(uid) {
  clearInterval(state.statsIntervals[uid])
  delete state.statsIntervals[uid]
  const card = $('streams-grid').querySelector(`[data-stream="${uid}"]`)
  // Sem isso, a janela flutuante de Picture-in-Picture ficava travada
  // mostrando um vídeo cujo elemento acabou de sair do DOM.
  const video = card?.querySelector('video')
  if (video && document.pictureInPictureElement === video) {
    document.exitPictureInPicture().catch(() => {})
  }
  // Mesma ideia pra tela cheia — se o card que está saindo é o que está em
  // fullscreen, sai antes de removê-lo do DOM.
  if (card && document.fullscreenElement === card) {
    document.exitFullscreen().catch(() => {})
  }
  card?.remove()
  if (state.focusedId === uid) state.focusedId = null
  updateGridLayout()
}

// ──────────────────────────────────────────────
// FOCO — uma stream em destaque, as demais minimizadas
// ──────────────────────────────────────────────
function toggleFocus(uid) {
  state.focusedId = state.focusedId === uid ? null : uid
  updateGridLayout()
}

// ──────────────────────────────────────────────
// TELA CHEIA — sincroniza o botão de cada card e corrige o grid ao sair.
// Um card em :fullscreen sai do fluxo normal de layout enquanto ativo; sem
// recalcular o grid ao voltar, ele ficava com o layout desatualizado
// (bugado) até alguém entrar/sair da sala de novo.
// ──────────────────────────────────────────────
document.addEventListener('fullscreenchange', () => {
  const fsCard = document.fullscreenElement
  document.querySelectorAll('.stream-card').forEach(c => {
    const isFs = c === fsCard
    c.classList.toggle('is-fullscreen', isFs)
    c.classList.remove('controls-hidden')
    const btn = c.querySelector('.fullscreen-btn')
    if (btn) {
      btn.textContent = isFs ? '⤬' : '⛶'
      btn.title = isFs ? 'Sair da tela cheia' : 'Tela cheia'
    }
  })
  clearTimeout(hideControlsTimer)
  clearTimeout(hideHeadersTimer)
  $('streams-grid').classList.remove('headers-hidden')
  if (fsCard) {
    resetControlsHideTimer()
  } else {
    resetHeadersHideTimer()
  }
  updateGridLayout()
})

// Some com o cabeçalho/controles da tela cheia depois de 3s sem o mouse se
// mexer (padrão de player de vídeo em fullscreen) — volta a aparecer no
// primeiro movimento.
let hideControlsTimer = null
function resetControlsHideTimer() {
  const fsCard = document.fullscreenElement
  if (!fsCard || !fsCard.classList.contains('stream-card')) return
  fsCard.classList.remove('controls-hidden')
  clearTimeout(hideControlsTimer)
  hideControlsTimer = setTimeout(() => {
    fsCard.classList.add('controls-hidden')
  }, 3000)
}
// Mesma ideia fora da tela cheia, só que 5s (não está tampando o vídeo,
// então não precisa sumir tão rápido) e escondendo só o cabeçalho (os
// controles de volume/qualidade fora do fullscreen já ficam junto do card
// normalmente, sem precisar desse tratamento).
let hideHeadersTimer = null
function resetHeadersHideTimer() {
  const grid = $('streams-grid')
  grid.classList.remove('headers-hidden')
  clearTimeout(hideHeadersTimer)
  hideHeadersTimer = setTimeout(() => {
    grid.classList.add('headers-hidden')
  }, 5000)
}

document.addEventListener('mousemove', () => {
  if (document.fullscreenElement) {
    resetControlsHideTimer()
  } else {
    resetHeadersHideTimer()
  }
})

function updateGridLayout() {
  const grid = $('streams-grid')
  const cards = Array.from(grid.querySelectorAll('.stream-card'))

  if (cards.length === 0) {
    grid.className = 'streams-grid hidden'
    $('stage-empty').classList.remove('hidden')
    return
  }

  $('stage-empty').classList.add('hidden')
  grid.classList.remove('hidden')

  // Se a stream em foco não existe mais, limpa o foco
  if (state.focusedId && !cards.some(c => c.dataset.stream === state.focusedId)) {
    state.focusedId = null
  }

  if (state.focusedId) {
    grid.className = 'streams-grid has-focus'
    cards.forEach(c => {
      const isFocused = c.dataset.stream === state.focusedId
      c.classList.toggle('focused', isFocused)
      c.classList.toggle('minimized', !isFocused)
    })
  } else {
    grid.className = `streams-grid count-${Math.min(cards.length, 4)}`
    cards.forEach(c => c.classList.remove('focused', 'minimized'))
  }
}

// ──────────────────────────────────────────────
// COPIAR ID
// ──────────────────────────────────────────────
$('btn-copy-id').onclick = () => {
  navigator.clipboard.writeText(state.roomId)
  toast('Código copiado!')
}
function stopSharing() {
  if (!state.sharing) return
  state.localStream?.getTracks().forEach(t => t.stop())
  state.localStream = null
  state.sharing = false
  updateSelfPreview()
  stopSnapshotLoop()

  $('btn-toggle-share').classList.remove('sharing')
  $('btn-toggle-share').title = 'Compartilhar tela'

  sendWS({ type: 'stop-sharing' })

  // Só fecha as conexões em que EU estava enviando minha tela — antes
  // isso fechava também as conexões em que eu estava assistindo outras
  // pessoas (mesmo mapa pros dois sentidos), derrubando o que eu via
  // só porque eu parei de compartilhar a minha.
  Object.keys(state.sharePeers).forEach(uid => closeSharePeer(uid))

  renderParticipants()
  appLog('INFO', 'Compartilhamento encerrado')
  toast('Você parou de compartilhar.')
}
// ──────────────────────────────────────────────
// SAIR DA SALA
// ──────────────────────────────────────────────
$('btn-leave').onclick = () => {
  // Desarma o auto-reconnect — sem isso, uma tentativa já agendada podia
  // disparar depois que a pessoa já tinha saído da sala de propósito.
  manualDisconnect = true
  clearTimeout(reconnectTimer)
  reconnectTimer = null
  isReconnecting = false

  stopSharing()
  state.ws?.close()
  stopPing()
  state.watchPeers = {}
  state.sharePeers = {}
  state.users = {}
  state.watching.clear()
  state.connecting.clear()
  state.remoteStreams = {}
  state.focusedId = null
  state.screenSnapshots = {}
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
  Object.keys(voiceAnalysers).forEach(key => delete voiceAnalysers[key])
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