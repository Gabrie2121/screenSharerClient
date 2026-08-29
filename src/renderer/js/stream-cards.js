import { $ } from './core/dom.js'
import { iconSvg, setIcon } from './core/icons.js'
import { appLog } from './core/logger.js'
import { toast } from './core/toast.js'
import { state } from './core/state.js'
import { sendWS } from './websocket.js'
import { toggleFocus, updateGridLayout, tileKey } from './stage-layout.js'
import { setCardVolume } from './share-audio-duck.js'

/* ═══════════════════════════════════════════════════════════════
   STREAM CARDS
   upsertStreamCard monta o card na primeira vez que um track chega pra um
   uid (ver ontrack em webrtc/screen-share-peers.js) e só atualiza o
   <video> nas vezes seguintes. Cada pedaço da UI do card (zoom, volume,
   qualidade, stats, PiP, fullscreen) é montado por uma função auxiliar
   abaixo, chamada uma única vez na criação do card.
═══════════════════════════════════════════════════════════════ */

// Zoom com o scroll do mouse — só nessa live específica (o wheel não sobe
// pra rolar o resto da página), scroll pra cima aumenta, pra baixo
// diminui. Aplicado só no vídeo (não no card inteiro) e sempre em direção
// ao ponto onde está o cursor, pra não "fugir" a imagem.
function attachZoomControls(card) {
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
}

// Controle de volume — passar o mouse já abre o slider (CSS `:hover`, ver
// css/stream-card.css), sem precisar clicar. Clicar no ícone muta/desmuta
// direto. A porcentagem some junto com o slider quando o mouse sai —
// enquanto arrasta, aparece como um tooltip preso no próprio cursor, não
// fixo num lugar. A live sempre começa mutada (0%) — a pessoa escolhe
// ativar o som.
function attachVolumeControls(card, stream) {
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
  // fechava no meio do caminho. Um pequeno atraso ao sair (e cancelado se
  // o mouse entrar no outro elemento a tempo) resolve isso.
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

  // Transmissão sem áudio (a pessoa escolheu "Sem som" ao compartilhar, ou
  // a captura de áudio falhou) — bloqueia o controle de volume dessa live
  // específica, não tem o que ajustar.
  if (stream.getAudioTracks().length === 0) {
    slider.disabled = true
    volIcon.disabled = true
    setIcon(volIcon, 'volume-off')
    volIcon.title = 'Esta transmissão não tem áudio'
    volIcon.classList.add('muted')
  }

  function syncVolumeIcon() {
    const muted = video.muted || Number(slider.value) === 0
    setIcon(volIcon, muted ? 'volume-off' : 'volume-low')
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
      setCardVolume(video, restore)
      video.muted = false
    } else {
      lastVolume = Number(slider.value) || lastVolume
      slider.value = 0
      setCardVolume(video, 0)
      video.muted = true
    }
    syncVolumeIcon()
    if (video.paused) video.play().catch(() => {})
  })

  slider.addEventListener('click', (e) => e.stopPropagation())

  // Tooltip com a porcentagem grudado no cursor enquanto o mouse está em
  // cima do slider (arrastando ou não) — não fica fixo num canto.
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
    setCardVolume(video, v)
    // Se o autoplay mudo inicial não conseguiu desmutar sozinho (ver
    // comentário em upsertStreamCard), essa interação do usuário é um
    // gesto válido pro navegador permitir desmutar aqui.
    video.muted = v === 0
    syncVolumeIcon()
    moveVolTooltip(e)
    if (video.paused) video.play().catch(() => {})
  })
}

// Qualidade — quem assiste escolhe pra economizar banda (ver
// applyViewerQuality em webrtc/screen-share-peers.js, do lado de quem
// compartilha). `uid` aqui é quem está compartilhando, então o pedido vai
// pra ele. Começa na qualidade padrão definida em Configurações → Live (a
// pessoa ainda pode trocar na hora, só pra essa live, pelo próprio seletor).
function attachQualitySelector(card, uid) {
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
}

// Indicador de resolução/bitrate REAIS recebidos — prova concreta de que o
// seletor de qualidade está funcionando (a olho, no vídeo, a diferença nem
// sempre salta à vista: a caixa na tela continua do mesmo tamanho, e tela
// compartilhada comprime bem mesmo em 1080p quando tem pouco movimento).
function attachStatsOverlay(card, uid) {
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
}

// Picture-in-Picture — janela flutuante nativa do SO, independente da
// janela do app. O botão de fechar dela já é da própria janela nativa (a
// gente só escuta o evento pra manter nosso botão sincronizado).
function attachPipButton(card, uid) {
  const video = card.querySelector('video')
  const pipBtn = card.querySelector('.pip-btn')
  if (!document.pictureInPictureEnabled || video.disablePictureInPicture) {
    pipBtn.classList.add('hidden')
    return
  }
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
// via CSS `:fullscreen`, ver css/stream-card.css) em vez de sumirem. O
// sincronismo do botão e o reflow do grid ao sair ficam no listener global
// de 'fullscreenchange' (ver stage-layout.js).
function attachFullscreenButton(card, uid) {
  const fullscreenBtn = card.querySelector('.fullscreen-btn')
  if (!document.fullscreenEnabled) {
    fullscreenBtn.classList.add('hidden')
    return
  }
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

function buildStreamCard(uid, stream) {
  const username = state.users[uid]?.username || 'Usuário'
  const card = document.createElement('div')
  card.className = 'stream-card'
  card.dataset.stream = uid
  // Chave de foco compartilhada com as câmeras (ver tileKey em stage-layout.js)
  card.dataset.tile = tileKey('screen', uid)
  card.innerHTML = `
    <div class="stream-header">
      <span class="stream-name">${username}</span>
      <div class="stream-header-actions">
        <span class="stream-stats" title="Resolução e bitrate recebidos agora"></span>

        <select class="quality-select" title="Qualidade da transmissão (economiza banda)">
          <option value="auto">Automática</option>
          <option value="1440">1440p</option>
          <option value="1080">1080p</option>
          <option value="720">720p</option>
          <option value="480">480p</option>
          <option value="360">360p</option>
        </select>

        <div class="vol-control">
          <button type="button" class="vol-icon muted" title="Mutar/Desmutar">${iconSvg('volume-off')}</button>
          <div class="vol-popover">
            <input type="range" class="vol-slider" min="0" max="100" value="0" />
          </div>
          <div class="vol-tooltip hidden"></div>
        </div>

        <button type="button" class="fullscreen-btn" title="Tela cheia">${iconSvg('fullscreen')}</button>
        <button type="button" class="pip-btn" title="Ver em Picture-in-Picture">${iconSvg('pip')}</button>
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
  // não em tela cheia, onde um clique sem querer no vídeo não devia mudar
  // o foco por baixo dos panos.
  card.addEventListener('click', () => {
    if (document.fullscreenElement === card) return
    toggleFocus(card.dataset.tile)
  })

  attachZoomControls(card)
  attachVolumeControls(card, stream)
  attachQualitySelector(card, uid)
  attachStatsOverlay(card, uid)
  attachPipButton(card, uid)
  attachFullscreenButton(card, uid)

  return card
}

export function upsertStreamCard(uid, stream) {
  const grid = $('stage-grid')
  $('stage-empty').classList.add('hidden')
  grid.classList.remove('hidden')

  let card = grid.querySelector(`[data-stream="${uid}"]`)
  if (!card) {
    card = buildStreamCard(uid, stream)
    grid.appendChild(card)
  }

  const video = card.querySelector('video')
  const loading = card.querySelector('.stream-loading')

  // Tela de carregando enquanto o vídeo da pessoa ainda não chegou
  loading?.classList.remove('hidden')
  video.onloadeddata = () => loading?.classList.add('hidden')

  // Uma tela compartilhada chega em tracks separados (vídeo + áudio), cada
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
    setCardVolume(video, Number(card.querySelector('.vol-slider')?.value ?? 0))
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

export function removeStreamCard(uid) {
  clearInterval(state.statsIntervals[uid])
  delete state.statsIntervals[uid]
  const card = $('stage-grid').querySelector(`[data-stream="${uid}"]`)
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
  if (state.focusedId === tileKey('screen', uid)) state.focusedId = null
  updateGridLayout()
}
