import { $ } from '../core/dom.js'
import { appLog } from '../core/logger.js'
import { toast } from '../core/toast.js'
import { state, SHARE_AUDIO_KEY } from '../core/state.js'
import { sendWS } from '../websocket.js'
import { renderParticipants } from '../participants.js'
import { closeSharePeer } from './screen-share-peers.js'
import { updateSelfPreview } from '../settings-modal.js'
import { startSnapshotLoop, stopSnapshotLoop } from '../snapshot.js'

/* ═══════════════════════════════════════════════════════════════
   COMPARTILHAR TELA
═══════════════════════════════════════════════════════════════ */
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
  // localStorage e essa vira a escolha padrão dali pra frente.
  audio: localStorage.getItem(SHARE_AUDIO_KEY) !== 'off',
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
  localStorage.setItem(SHARE_AUDIO_KEY, v)
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
  // abaixo disparar o setDisplayMediaRequestHandler (src/main/window.js) —
  // sem isso, ele sempre pegava a primeira tela da lista, ignorando a
  // escolhida aqui.
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

export function stopSharing() {
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
