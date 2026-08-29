import { appLog } from './core/logger.js'
import { state, PIP_SOURCE_KEY } from './core/state.js'
import { getSelfPreviewVideo } from './self-preview.js'

/* ═══════════════════════════════════════════════════════════════
   MINI PLAYER (PiP AO MINIMIZAR)
   Minimizou (ou fechou no X, que esconde pra bandeja) e o que você estava
   vendo continua numa janelinha flutuante do SO. Voltou pro app, ela fecha.

   COMO, E POR QUE ASSIM — três decisões, cada uma por um motivo medido:

   1. Tudo é desenhado num <canvas> e o PiP recebe UM <video> alimentado por
      canvas.captureStream(). O PiP clássico só aceita um elemento por
      documento (pedir o segundo troca o primeiro), então essa é a única
      forma de mostrar várias telas/câmeras ao mesmo tempo — e é o que dá o
      controle de trocar a fonte no meio, já que quem decide o que aparece
      é o nosso desenho.

   2. Os quadros vêm do MediaStreamTrack via MediaStreamTrackProcessor, NÃO
      de drawImage(<video>). Com a janela escondida o Chromium para de
      produzir quadros novos para os elementos <video>, e o canvas ficava
      repetindo o último para sempre — a imagem "congelava" assim que o
      mini player abria. Lendo direto da track, o desenho não depende de
      nenhum elemento estar sendo renderizado.

   3. Document Picture-in-Picture (janela HTML com vários <video>) NÃO
      FUNCIONA no Electron 30: requestWindow() resolve sem erro, mas a
      janela vem 0x0 e dispara 'pagehide' em menos de um segundo. Foi
      medido. Não reintroduza sem conferir win.innerWidth de novo.

   Depende também de o renderer não ser rebaixado em segundo plano — ver
   backgroundThrottling em src/main/window.js e as flags de linha de comando
   em src/main.js.

   Quem dispara é o processo principal, via executeJavaScript com
   userGesture: o Chromium exige *transient user activation* pra abrir o
   PiP, e minimizar pelo SO não gera nenhuma no renderer (ver attachAutoPip
   em src/main/window.js). Os botões do titlebar chamam direto do handler de
   clique, caminho mais confiável. Tudo aqui é idempotente porque as duas
   pontas disparam.
═══════════════════════════════════════════════════════════════ */

// 15 fps é de sobra pro que o mini player mostra e custa bem menos CPU que
// 30 com a janela escondida.
const PIP_FPS = 15
const CANVAS_W = 1280
const CANVAS_H = 720

let canvas = null
let ctx = null
let pipVideo = null
let drawTimer = null
let tick = 0
let sources = []
let openedByUs = false
// Guarda SÍNCRONA contra chamadas concorrentes. O PiP é disparado por duas
// pontas quase juntas (o botão do titlebar e o processo principal, ver o
// cabeçalho), e openedByUs só vira true depois do await
// requestPictureInPicture(). Nessa janela a segunda chamada passava batido,
// refazia a lista de fontes e chamava stopReaders(), cancelando os leitores
// que a primeira tinha acabado de criar — os quadros paravam de chegar e a
// imagem congelava assim que o mini player abria.
let opening = false

/* ═══════════════════════════════════════════════════════════════
   LEITURA DE QUADROS DIRETO DA TRACK
   Um leitor por MediaStream, guardado por id e reaproveitado entre
   atualizações da lista — recriar o processor a cada 2s desperdiçaria
   quadros e trabalho à toa.

   Cada VideoFrame segura memória de GPU e PRECISA ser fechada: sem o
   close() do quadro anterior, o pipeline trava depois de alguns segundos.
═══════════════════════════════════════════════════════════════ */
const readers = new Map() // streamId -> { frame, stop() }

function getReader(stream) {
  const existing = readers.get(stream.id)
  if (existing) return existing

  const track = stream.getVideoTracks()[0]
  if (!track || typeof MediaStreamTrackProcessor === 'undefined') return null

  const holder = { frame: null, stopped: false, stop }
  let reader
  try {
    reader = new MediaStreamTrackProcessor({ track }).readable.getReader()
  } catch (err) {
    appLog('WARN', `[PIP] MediaStreamTrackProcessor indisponível: ${err.message}`)
    return null
  }

  ;(async () => {
    try {
      while (!holder.stopped) {
        const { value, done } = await reader.read()
        if (done) break
        holder.frame?.close()
        holder.frame = value
      }
    } catch { /* track encerrada ou leitor cancelado */ }
    holder.frame?.close()
    holder.frame = null
  })()

  function stop() {
    holder.stopped = true
    try { reader.cancel() } catch { /* já cancelado */ }
  }

  readers.set(stream.id, holder)
  return holder
}

function stopReaders(keepIds = new Set()) {
  for (const [id, holder] of readers) {
    if (keepIds.has(id)) continue
    holder.stop()
    readers.delete(id)
  }
}

/* ═══════════════════════════════════════════════════════════════
   O QUE MOSTRAR — 'auto' (tudo), 'screens' (só telas) ou 'cameras'.
   Escolhido em Configurações → Vídeo e trocável ao vivo pelos botões de
   faixa da própria janela do PiP (ver setupMediaSessionSwitching).
═══════════════════════════════════════════════════════════════ */
export const PIP_MODES = ['auto', 'screens', 'cameras']
const MODE_LABEL = { auto: 'Telas e câmeras', screens: 'Só telas', cameras: 'Só câmeras' }

export function setPipSource(mode) {
  if (!PIP_MODES.includes(mode)) return
  state.pipSource = mode
  localStorage.setItem(PIP_SOURCE_KEY, mode)
  if (openedByUs) refreshSources() // troca na hora com o app minimizado
}

// Vale como fonte se a TRACK está viva — de propósito não olha o
// readyState do elemento. Com a janela escondida o <video> para de produzir
// quadros e seu readyState deixa de ser confiável; usá-lo aqui fazia a
// lista de fontes esvaziar sozinha justamente quando o mini player abria.
// Quem entrega os quadros é o leitor da track (ver getReader).
function isUsable(video) {
  const tracks = video?.srcObject?.getVideoTracks?.() || []
  return tracks.some(t => t.readyState === 'live')
}

function collectSources() {
  const grid = document.getElementById('stage-grid')
  const screens = []
  const cameras = []
  const seen = new Set()

  const push = (list, video, label, mirrored = false) => {
    if (!isUsable(video) || seen.has(video.srcObject.id)) return
    seen.add(video.srcObject.id)
    list.push({ stream: video.srcObject, video, label, mirrored })
  }

  // O tile em foco entra primeiro na lista — é o que a pessoa escolheu
  // ver grande, então é o que deve aparecer no mini player. A chave carrega
  // o tipo ('screen:<uid>' / 'cam:<uid>'), daí o split pra tirar o uid.
  if (state.focusedId) {
    const tile = grid?.querySelector(`[data-tile="${state.focusedId}"]`)
    const [kind, uid] = state.focusedId.split(':')
    push(kind === 'cam' ? cameras : screens, tile?.querySelector('video'), nameOf(uid),
      tile?.classList.contains('mirrored'))
  }
  for (const card of grid?.querySelectorAll('.stream-card') || []) {
    push(screens, card.querySelector('video'), nameOf(card.dataset.stream))
  }
  for (const tile of document.querySelectorAll('.camera-tile')) {
    push(cameras, tile.querySelector('video'), nameOf(tile.dataset.cam),
      tile.classList.contains('mirrored'))
  }
  push(screens, getSelfPreviewVideo(), 'Sua tela')

  if (state.pipSource === 'screens') return screens
  if (state.pipSource === 'cameras') return cameras
  return [...screens, ...cameras]
}

function nameOf(uid) {
  if (uid === state.myId) return `${state.myName} (você)`
  return state.users[uid]?.username || 'Usuário'
}

function refreshSources() {
  sources = collectSources()
  const live = new Set()
  for (const src of sources) {
    src.reader = getReader(src.stream)
    live.add(src.stream.id)
  }
  stopReaders(live) // solta leitores de quem saiu da lista
  updateMediaSessionTitle()
}

/* ═══════════════════════════════════════════════════════════════
   DESENHO
═══════════════════════════════════════════════════════════════ */
function ensureCanvas() {
  if (canvas) return
  canvas = document.createElement('canvas')
  canvas.width = CANVAS_W
  canvas.height = CANVAS_H
  ctx = canvas.getContext('2d')

  pipVideo = document.createElement('video')
  pipVideo.muted = true       // o áudio já toca nos elementos originais
  pipVideo.playsInline = true
  // Fora da tela em vez de display:none — um <video> não renderizado pode
  // ser descartado pelo Chromium, e o PiP precisa dele decodificando.
  pipVideo.style.cssText = 'position:fixed;left:-9999px;top:0;width:320px;height:180px;'
  document.body.append(pipVideo)

  pipVideo.addEventListener('leavepictureinpicture', () => stopCompositor())
}

// Desenha preservando proporção (equivalente do object-fit: contain), com
// o nome por cima. A fonte é o VideoFrame da track; o <video> só entra como
// reserva quando o MediaStreamTrackProcessor não está disponível.
function drawInto(src, x, y, w, h) {
  ctx.fillStyle = '#000'
  ctx.fillRect(x, y, w, h)

  const frame = src.reader?.frame
  const painted = frame || src.video
  const vw = frame ? frame.displayWidth : src.video.videoWidth
  const vh = frame ? frame.displayHeight : src.video.videoHeight

  if (vw && vh) {
    const scale = Math.min(w / vw, h / vh)
    const dw = vw * scale
    const dh = vh * scale
    const dx = x + (w - dw) / 2
    const dy = y + (h - dh) / 2
    ctx.save()
    if (src.mirrored) {
      // Espelha a própria câmera, mesma convenção da faixa de câmeras.
      ctx.translate(dx + dw, dy)
      ctx.scale(-1, 1)
      ctx.drawImage(painted, 0, 0, dw, dh)
    } else {
      ctx.drawImage(painted, dx, dy, dw, dh)
    }
    ctx.restore()
  }

  ctx.fillStyle = 'rgba(0,0,0,.6)'
  ctx.fillRect(x, y + h - 26, w, 26)
  ctx.fillStyle = '#eef1f6'
  ctx.font = '16px system-ui, sans-serif'
  ctx.fillText(src.label, x + 8, y + h - 8, w - 16)
}

function draw() {
  ctx.fillStyle = '#1a1b1e' // mesmo valor de --bg (tokens.css) — canvas não enxerga variável CSS
  ctx.fillRect(0, 0, CANVAS_W, CANVAS_H)

  if (!sources.length) {
    ctx.fillStyle = '#7b8494'
    ctx.font = '20px system-ui, sans-serif'
    ctx.fillText(`Nada para mostrar (${MODE_LABEL[state.pipSource]})`, 24, 40)
    return
  }

  const cols = Math.ceil(Math.sqrt(sources.length))
  const rows = Math.ceil(sources.length / cols)
  const cw = CANVAS_W / cols
  const ch = CANVAS_H / rows
  const gap = 3

  sources.forEach((src, i) => {
    drawInto(src, (i % cols) * cw + gap, Math.floor(i / cols) * ch + gap,
      cw - gap * 2, ch - gap * 2)
  })
}

/* ═══════════════════════════════════════════════════════════════
   TROCAR DE FONTE COM O APP MINIMIZADO
   A janela do PiP não aceita UI nossa, mas o Chromium desenha nela os
   botões de faixa anterior/próxima quando existem handlers de mediaSession.
   É o único jeito de trocar sem restaurar o app; o título da sessão vira o
   rótulo do modo atual.
═══════════════════════════════════════════════════════════════ */
function updateMediaSessionTitle() {
  if (!('mediaSession' in navigator)) return
  try {
    navigator.mediaSession.metadata = new MediaMetadata({
      title: MODE_LABEL[state.pipSource] || 'Mini player',
      artist: `${sources.length} em exibição`,
    })
  } catch { /* o PiP funciona sem isso */ }
}

function cycleMode(step) {
  const i = PIP_MODES.indexOf(state.pipSource)
  setPipSource(PIP_MODES[(i + step + PIP_MODES.length) % PIP_MODES.length])
}

function setupMediaSessionSwitching() {
  if (!('mediaSession' in navigator)) return
  try {
    navigator.mediaSession.setActionHandler('nexttrack', () => cycleMode(1))
    navigator.mediaSession.setActionHandler('previoustrack', () => cycleMode(-1))
  } catch { /* sem os botões, resta o seletor em Configurações → Vídeo */ }
}

function clearMediaSession() {
  if (!('mediaSession' in navigator)) return
  try {
    navigator.mediaSession.setActionHandler('nexttrack', null)
    navigator.mediaSession.setActionHandler('previoustrack', null)
  } catch { /* ignorado */ }
}

/* ═══════════════════════════════════════════════════════════════
   ABRIR / FECHAR
═══════════════════════════════════════════════════════════════ */
export async function enterAutoPip() {
  if (!state.autoPip) return
  if (opening || openedByUs || document.pictureInPictureElement) return
  if (!document.pictureInPictureEnabled) return
  opening = true
  try {
    await openPip()
  } finally {
    opening = false
  }
}

async function openPip() {
  ensureCanvas()
  refreshSources()
  if (!sources.length) return

  // Um primeiro quadro antes de capturar: sem isso o captureStream começa
  // com o canvas em branco e o PiP abre piscando branco.
  draw()

  if (!pipVideo.srcObject) pipVideo.srcObject = canvas.captureStream(PIP_FPS)

  clearInterval(drawTimer)
  tick = 0
  drawTimer = setInterval(() => {
    // A cada ~2s relê a lista, pra refletir quem entrou, saiu ou ligou a
    // câmera enquanto o app está minimizado.
    if (++tick % (PIP_FPS * 2) === 0) refreshSources()
    draw()
  }, Math.round(1000 / PIP_FPS))

  try {
    await pipVideo.play()
    await pipVideo.requestPictureInPicture()
    openedByUs = true
    setupMediaSessionSwitching()
    const viaTrack = sources.some(s => s.reader)
    appLog('INFO', `Mini player aberto — ${sources.length} fonte(s), modo "${state.pipSource}"`
      + `, quadros via ${viaTrack ? 'track' : '<video> (reserva)'}`)
  } catch (err) {
    stopCompositor()
    console.warn('[PIP] Não foi possível abrir:', err)
    appLog('WARN', `Mini player não pôde abrir: ${err.name} ${err.message}`)
  }
}

function stopCompositor() {
  clearInterval(drawTimer)
  drawTimer = null
  stopReaders()
  sources = []
  openedByUs = false
  clearMediaSession()
}

export async function exitAutoPip() {
  if (!openedByUs) return
  const wasInPip = document.pictureInPictureElement === pipVideo
  stopCompositor()
  if (!wasInPip) return
  try {
    await document.exitPictureInPicture()
  } catch (err) {
    console.warn('[PIP] Falha ao fechar:', err)
  }
}

// Superfície chamada pelo processo principal (ver src/main/window.js).
window.__sharesyncAutoPip = () => { enterAutoPip() }
window.__sharesyncExitPip = () => { exitAutoPip() }
