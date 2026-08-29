import { $ } from './core/dom.js'
import { iconSvg } from './core/icons.js'
import { appLog } from './core/logger.js'
import { toast } from './core/toast.js'
import { state } from './core/state.js'
import { toggleFocus, updateGridLayout, tileKey } from './stage-layout.js'

/* ═══════════════════════════════════════════════════════════════
   A PRÓPRIA TELA NO PALCO

   Enquanto você transmite, a sua tela aparece no mesmo grid das outras
   (`#stage-grid`) — do mesmo tamanho, na mesma fileira. Antes ela não
   aparecia em lugar nenhum por padrão: só existia a prévia flutuante
   opcional no canto (ver js/self-preview.js), que continua funcionando e
   é outra coisa — uma janelinha arrastável por cima da interface.

   Diferenças pro card de quem você ASSISTE (ver js/stream-cards.js):
   - nunca tem som. É a mesma stream que já está saindo pra rede, e ela
     carrega o loopback do sistema: tocá-la aqui devolveria o áudio da
     máquina pra própria máquina, em loop.
   - não tem seletor de qualidade nem controle de volume. Qualidade é uma
     escolha de quem assiste (cada espectador pede a sua, ver
     applyViewerQuality) e não faz sentido pedir pra si mesmo.
═══════════════════════════════════════════════════════════════ */

const SELF_TILE_SELECTOR = '.stream-card.self-tile'

export function renderSelfTile() {
  const grid = $('stage-grid')
  const existing = grid.querySelector(SELF_TILE_SELECTOR)

  // Desligar em Configurações → Vídeo tira o tile do palco sem mexer em
  // nada do que sai pra rede: os outros continuam recebendo igual.
  if (!state.sharing || !state.localStream || !state.showSelfScreen) {
    if (existing) {
      // Sem isso, parar de transmitir deixaria uma janela de PiP (ou a tela
      // cheia) travada exibindo um vídeo que não recebe mais frame nenhum.
      const video = existing.querySelector('video')
      if (document.pictureInPictureElement === video) document.exitPictureInPicture().catch(() => {})
      if (document.fullscreenElement === existing) document.exitFullscreen().catch(() => {})
      if (state.focusedId === existing.dataset.tile) state.focusedId = null
      existing.remove()
      updateGridLayout()
    }
    return
  }

  const card = existing || buildSelfTile()
  const video = card.querySelector('video')
  // Trocar de tela em transmissão gera uma stream nova (ver switchSource em
  // webrtc/capture.js); só reatribui quando mudou de verdade, senão o
  // play() reinicia e a imagem pisca a cada re-render.
  if (video.srcObject !== state.localStream) {
    video.srcObject = state.localStream
    video.play().catch(() => {})
  }
  updateGridLayout()
}

function buildSelfTile() {
  const grid = $('stage-grid')
  const card = document.createElement('div')
  card.className = 'stream-card self-tile'
  card.dataset.stream = state.myId || 'self'
  card.dataset.tile = tileKey('screen', state.myId || 'self')
  card.innerHTML = `
    <div class="stream-header">
      <span class="stream-name">Sua tela</span>
      <div class="stream-header-actions">
        <button type="button" class="fullscreen-btn" title="Tela cheia">${iconSvg('fullscreen')}</button>
        <button type="button" class="pip-btn" title="Ver em Picture-in-Picture">${iconSvg('pip')}</button>
      </div>
    </div>
    <div class="stream-video-wrap">
      <video class="stream-video" autoplay muted playsinline></video>
    </div>
  `

  // `muted` no HTML acima já basta, mas deixar explícito no elemento evita
  // que qualquer código futuro que mexa no volume ligue o som sem querer.
  card.querySelector('video').muted = true

  card.addEventListener('click', () => {
    if (document.fullscreenElement === card) return
    toggleFocus(card.dataset.tile)
  })

  const fullscreenBtn = card.querySelector('.fullscreen-btn')
  if (document.fullscreenEnabled) {
    fullscreenBtn.addEventListener('click', async (e) => {
      e.stopPropagation()
      try {
        if (document.fullscreenElement === card) await document.exitFullscreen()
        else await card.requestFullscreen()
      } catch (err) {
        appLog('WARN', `Falha ao entrar em tela cheia na própria tela: ${err.message}`)
        toast('Não foi possível entrar em tela cheia.')
      }
    })
  } else {
    fullscreenBtn.classList.add('hidden')
  }

  card.querySelector('.pip-btn').addEventListener('click', async (e) => {
    e.stopPropagation()
    const video = card.querySelector('video')
    try {
      if (document.pictureInPictureElement === video) await document.exitPictureInPicture()
      else await video.requestPictureInPicture()
    } catch (err) {
      appLog('WARN', `Falha ao abrir PiP da própria tela: ${err.message}`)
      toast('Não foi possível abrir a janela flutuante.')
    }
  })

  grid.appendChild(card)
  return card
}
