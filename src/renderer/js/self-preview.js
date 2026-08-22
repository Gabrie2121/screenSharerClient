import { $ } from './core/dom.js'
import { appLog } from './core/logger.js'
import { toast } from './core/toast.js'
import { state, SELF_PREVIEW_POS_KEY } from './core/state.js'

/* ═══════════════════════════════════════════════════════════════
   AUTOVISUALIZAÇÃO — a sua própria tela, opcional (ver Configurações →
   Vídeo). Antes era uma caixinha morta pregada no canto inferior direito;
   agora dá pra arrastar pra qualquer canto, redimensionar, abrir em tela
   cheia e jogar no Picture-in-Picture.

   Continua SEMPRE muda: é só uma prévia local do mesmo state.localStream
   que já vai pros outros participantes, nunca deve tocar som (o pedido era
   explícito: "que não transmita som").

   Este módulo saiu de settings-modal.js — lá ele era só o updateSelfPreview,
   e o modal de configurações não tem nada a ver com arrastar/redimensionar.
═══════════════════════════════════════════════════════════════ */

const MARGIN = 8          // respiro mínimo até a borda da janela
const DRAG_THRESHOLD = 4  // px antes de considerar arraste (ver abaixo)
const MIN_WIDTH = 140
const MAX_WIDTH = 900

const wrap = $('self-preview')
const video = $('self-preview-video')

/* ═══════════════════════════════════════════════════════════════
   POSIÇÃO E TAMANHO — persistidos por janela, não por sala
═══════════════════════════════════════════════════════════════ */
function loadPlacement() {
  try {
    const raw = localStorage.getItem(SELF_PREVIEW_POS_KEY)
    return raw ? JSON.parse(raw) : null
  } catch {
    return null // JSON corrompido de alguma versão anterior — volta pro padrão
  }
}

function savePlacement(placement) {
  localStorage.setItem(SELF_PREVIEW_POS_KEY, JSON.stringify(placement))
}

// O CSS posiciona a caixinha por `right`/`bottom`. No primeiro arraste a
// gente troca pra `left`/`top` — misturar os dois faria a largura ser
// esticada pelos dois lados em vez de mover a caixa.
function applyPlacement({ left, top, width }) {
  if (width) wrap.style.width = `${width}px`
  wrap.style.left = `${left}px`
  wrap.style.top = `${top}px`
  wrap.style.right = 'auto'
  wrap.style.bottom = 'auto'
}

// Mantém a caixinha dentro da janela. Vale tanto no arraste quanto no
// resize da janela — sem isso, encolher a janela do app deixava a prévia
// "fora da tela", inalcançável e sem jeito de trazer de volta.
function clamp(left, top) {
  const rect = wrap.getBoundingClientRect()
  const maxLeft = window.innerWidth - rect.width - MARGIN
  const maxTop = window.innerHeight - rect.height - MARGIN
  return {
    left: Math.max(MARGIN, Math.min(maxLeft, left)),
    top: Math.max(MARGIN, Math.min(maxTop, top)),
  }
}

function currentPlacement() {
  const rect = wrap.getBoundingClientRect()
  return { left: rect.left, top: rect.top, width: rect.width }
}

function restorePlacement() {
  const saved = loadPlacement()
  if (!saved) return
  // Aplica primeiro (pra largura entrar no cálculo do clamp) e só depois
  // corrige a posição contra o tamanho atual da janela.
  applyPlacement(saved)
  applyPlacement({ ...clamp(saved.left, saved.top), width: saved.width })
}

window.addEventListener('resize', () => {
  if (wrap.classList.contains('hidden') || document.fullscreenElement === wrap) return
  const { left, top } = currentPlacement()
  applyPlacement({ ...clamp(left, top) })
})

/* ═══════════════════════════════════════════════════════════════
   ARRASTAR
   Um clique que não moveu nada NÃO conta como arraste (DRAG_THRESHOLD):
   sem isso, soltar o mouse em cima de um dos botõezinhos da barra depois
   de um micro-tremor engolia o clique do botão.
═══════════════════════════════════════════════════════════════ */
let drag = null

wrap.addEventListener('pointerdown', (e) => {
  // Botões e a alça de redimensionar têm o próprio comportamento.
  if (e.target.closest('.sp-btn') || e.target.closest('.self-preview-resize')) return
  if (document.fullscreenElement === wrap) return
  if (e.button !== 0) return

  const rect = wrap.getBoundingClientRect()
  drag = {
    pointerId: e.pointerId,
    startX: e.clientX,
    startY: e.clientY,
    offsetX: e.clientX - rect.left,
    offsetY: e.clientY - rect.top,
    moved: false,
  }
  wrap.setPointerCapture(e.pointerId)
  e.preventDefault()
})

wrap.addEventListener('pointermove', (e) => {
  if (!drag || e.pointerId !== drag.pointerId) return

  if (!drag.moved) {
    const dx = Math.abs(e.clientX - drag.startX)
    const dy = Math.abs(e.clientY - drag.startY)
    if (dx < DRAG_THRESHOLD && dy < DRAG_THRESHOLD) return
    drag.moved = true
    wrap.classList.add('dragging')
  }

  applyPlacement(clamp(e.clientX - drag.offsetX, e.clientY - drag.offsetY))
})

function endDrag(e) {
  if (!drag || e.pointerId !== drag.pointerId) return
  const moved = drag.moved
  drag = null
  wrap.classList.remove('dragging')
  wrap.releasePointerCapture?.(e.pointerId)
  if (moved) savePlacement(currentPlacement())
}

wrap.addEventListener('pointerup', endDrag)
wrap.addEventListener('pointercancel', endDrag)

/* ═══════════════════════════════════════════════════════════════
   REDIMENSIONAR — alça no canto superior esquerdo (o canto inferior
   direito é justamente pra onde a caixinha vai por padrão, ficaria em
   cima da borda da janela).
   A altura acompanha sozinha: o CSS mantém aspect-ratio 16/9.
═══════════════════════════════════════════════════════════════ */
const resizeHandle = $('self-preview-resize')
let resize = null

resizeHandle.addEventListener('pointerdown', (e) => {
  if (document.fullscreenElement === wrap) return
  const rect = wrap.getBoundingClientRect()
  resize = {
    pointerId: e.pointerId,
    startX: e.clientX,
    startWidth: rect.width,
    // O canto de baixo/direita fica parado enquanto se arrasta o de cima/esquerda.
    anchorRight: rect.right,
    anchorBottom: rect.bottom,
  }
  resizeHandle.setPointerCapture(e.pointerId)
  e.preventDefault()
  e.stopPropagation()
})

resizeHandle.addEventListener('pointermove', (e) => {
  if (!resize || e.pointerId !== resize.pointerId) return
  // Arrastar pra ESQUERDA aumenta (a alça está no canto esquerdo).
  const width = Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, resize.startWidth + (resize.startX - e.clientX)))
  const height = width * 9 / 16
  applyPlacement({
    width,
    left: resize.anchorRight - width,
    top: resize.anchorBottom - height,
  })
})

function endResize(e) {
  if (!resize || e.pointerId !== resize.pointerId) return
  resize = null
  resizeHandle.releasePointerCapture?.(e.pointerId)
  const { left, top } = currentPlacement()
  applyPlacement({ ...clamp(left, top), width: currentPlacement().width })
  savePlacement(currentPlacement())
}

resizeHandle.addEventListener('pointerup', endResize)
resizeHandle.addEventListener('pointercancel', endResize)

/* ═══════════════════════════════════════════════════════════════
   TELA CHEIA
   Fullscreena o wrapper inteiro (não só o <video>) pra barrinha de botões
   continuar acessível — mesma escolha dos cards de stream (ver
   attachFullscreenButton em stream-cards.js).

   O CSS de :fullscreen precisa de !important: a posição e a largura vivem
   em estilo inline (setados pelo arraste/resize acima) e inline ganha de
   regra normal, então sem isso a caixinha continuaria de 220px num canto
   com o resto da tela preto.
═══════════════════════════════════════════════════════════════ */
export async function toggleSelfPreviewFullscreen() {
  try {
    if (document.fullscreenElement === wrap) await document.exitFullscreen()
    else await wrap.requestFullscreen()
  } catch (err) {
    console.warn('[SELF-PREVIEW] Falha na tela cheia:', err)
    appLog('WARN', `Falha ao abrir a própria tela em tela cheia: ${err.message}`)
    toast('Não foi possível abrir em tela cheia.')
  }
}

$('self-preview-fs').addEventListener('click', (e) => {
  e.stopPropagation()
  toggleSelfPreviewFullscreen()
})

// Duplo clique no vídeo também entra/sai — atalho esperado em qualquer player.
wrap.addEventListener('dblclick', (e) => {
  if (e.target.closest('.sp-btn') || e.target.closest('.self-preview-resize')) return
  toggleSelfPreviewFullscreen()
})

document.addEventListener('fullscreenchange', () => {
  const isFs = document.fullscreenElement === wrap
  wrap.classList.toggle('is-fullscreen', isFs)
  const btn = $('self-preview-fs')
  btn.textContent = isFs ? '⤬' : '⛶'
  btn.title = isFs ? 'Sair da tela cheia' : 'Tela cheia'
})

/* ═══════════════════════════════════════════════════════════════
   PICTURE-IN-PICTURE — janela flutuante do SO com a própria tela. É também
   o alvo de reserva do PiP automático ao minimizar (ver js/auto-pip.js)
   pra quem está compartilhando mas não assiste ninguém.
═══════════════════════════════════════════════════════════════ */
export function getSelfPreviewVideo() {
  // Só serve de alvo de PiP se estiver de fato tocando algo.
  return video.srcObject ? video : null
}

const pipBtn = $('self-preview-pip')
if (!document.pictureInPictureEnabled) {
  pipBtn.classList.add('hidden')
} else {
  pipBtn.addEventListener('click', async (e) => {
    e.stopPropagation()
    try {
      if (document.pictureInPictureElement === video) await document.exitPictureInPicture()
      else await video.requestPictureInPicture()
    } catch (err) {
      console.warn('[SELF-PREVIEW] Falha no Picture-in-Picture:', err)
      appLog('WARN', `Falha ao abrir a própria tela em PiP: ${err.message}`)
      toast('Não foi possível abrir o Picture-in-Picture.')
    }
  })
  video.addEventListener('enterpictureinpicture', () => pipBtn.classList.add('active'))
  video.addEventListener('leavepictureinpicture', () => pipBtn.classList.remove('active'))
}

/* ═══════════════════════════════════════════════════════════════
   LIGA/DESLIGA — chamado ao começar/parar/trocar de compartilhamento (ver
   js/webrtc/capture.js) e ao mexer no checkbox das configurações.
═══════════════════════════════════════════════════════════════ */
export function updateSelfPreview() {
  const show = state.sharing && state.showSelfPreview && state.localStream

  wrap.classList.toggle('hidden', !show)

  if (!show) {
    // Sem isso, parar de compartilhar deixava uma janela de PiP (ou a tela
    // cheia) travada exibindo um vídeo que não recebe mais frame nenhum.
    if (document.pictureInPictureElement === video) document.exitPictureInPicture().catch(() => {})
    if (document.fullscreenElement === wrap) document.exitFullscreen().catch(() => {})
    video.srcObject = null
    return
  }

  restorePlacement()

  // Sempre mudo — é só uma prévia local, nunca deve tocar som. Não é
  // enviada a ninguém, é a mesma state.localStream que já vai pros outros
  // participantes.
  video.muted = true
  if (video.srcObject !== state.localStream) {
    video.srcObject = state.localStream
    video.play().catch(() => {})
  }
}
