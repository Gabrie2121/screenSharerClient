import { appLog } from './core/logger.js'
import { state } from './core/state.js'
import { getSelfPreviewVideo } from './self-preview.js'

/* ═══════════════════════════════════════════════════════════════
   PICTURE-IN-PICTURE AUTOMÁTICO AO MINIMIZAR
   Minimizou (ou fechou no X, que esconde pra bandeja) e a tela que você
   estava vendo continua numa janelinha flutuante do SO, por cima de tudo.
   Voltou pro app, o PiP fecha sozinho.

   Quem dispara é o processo principal, via executeJavaScript com
   userGesture — o Chromium só libera requestPictureInPicture() com
   *transient user activation*, e minimizar pelo SO não gera nenhuma no
   renderer (ver attachAutoPip em src/main/window.js). Por isso as duas
   funções abaixo ficam penduradas no window: são a superfície que o
   processo principal chama.

   Os botões de minimizar/fechar do titlebar custom chamam enterAutoPip()
   direto no handler de clique (ver js/titlebar.js) — ali o gesto é do
   próprio renderer, o caminho mais confiável. Como o main process também
   vai disparar logo em seguida, tudo aqui é idempotente.
═══════════════════════════════════════════════════════════════ */

// Só existe UMA janela de PiP por documento no Chromium, então é preciso
// escolher um alvo. Ordem: o que está em foco no palco → a primeira live
// que você está assistindo → a prévia da sua própria tela (pra quem está
// compartilhando sem assistir ninguém).
function pickPipTarget() {
  const grid = document.getElementById('streams-grid')

  if (state.focusedId) {
    const focused = grid?.querySelector(`[data-stream="${state.focusedId}"] video`)
    if (isUsable(focused)) return focused
  }

  for (const video of grid?.querySelectorAll('.stream-card video') || []) {
    if (isUsable(video)) return video
  }

  const own = getSelfPreviewVideo()
  return isUsable(own) ? own : null
}

// Um <video> sem stream ou ainda sem frame decodificado abre uma janela de
// PiP preta — pior que não abrir nada.
function isUsable(video) {
  return !!video && !!video.srcObject && video.readyState >= 2 && !video.disablePictureInPicture
}

// Marca se ESTE módulo abriu o PiP. Sem isso, voltar pro app fecharia
// também um PiP que a pessoa tinha aberto na mão pelo botão do card, que
// não é o que ela pediu.
let openedByUs = false

export async function enterAutoPip() {
  if (!state.autoPip) return
  if (!document.pictureInPictureEnabled) return
  if (document.pictureInPictureElement) return // já tem um aberto, deixa quieto

  const video = pickPipTarget()
  if (!video) return

  try {
    await video.requestPictureInPicture()
    openedByUs = true
    appLog('INFO', 'PiP automático aberto ao minimizar')
  } catch (err) {
    // NotAllowedError aqui significa que a activation não chegou — não é
    // fatal, o app segue minimizado normalmente, só sem janelinha.
    console.warn('[AUTO-PIP] Não foi possível abrir:', err)
    appLog('WARN', `PiP automático não pôde abrir: ${err.message}`)
  }
}

export async function exitAutoPip() {
  if (!openedByUs) return
  openedByUs = false
  if (!document.pictureInPictureElement) return
  try {
    await document.exitPictureInPicture()
  } catch (err) {
    console.warn('[AUTO-PIP] Falha ao fechar:', err)
  }
}

// Se a pessoa fechar a janelinha na mão (pelo botão da própria janela do
// SO) enquanto o app está minimizado, o app não deve reabrir nem tentar
// fechá-la de novo ao restaurar.
document.addEventListener('leavepictureinpicture', () => { openedByUs = false }, true)

// Superfície chamada pelo processo principal (ver src/main/window.js).
window.__sharesyncAutoPip = () => { enterAutoPip() }
window.__sharesyncExitPip = () => { exitAutoPip() }
