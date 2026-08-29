import { $ } from '../core/dom.js'
import { appLog } from '../core/logger.js'
import { toast } from '../core/toast.js'
import { playSound } from '../core/sounds.js'
import { state, SHARE_AUDIO_KEY } from '../core/state.js'
import { sendWS } from '../websocket.js'
import { renderParticipants } from '../participants.js'
import { closeSharePeer, replaceSharedStream } from './screen-share-peers.js'
import { updateSelfPreview } from '../self-preview.js'
import { renderSelfTile } from '../self-tile.js'
import { startSnapshotLoop, stopSnapshotLoop } from '../snapshot.js'
import {
  startSystemAudioTrack, stopSystemAudioTrack, isSystemAudioAvailable,
  listSystemAudioApps, windowAudioPid,
} from './system-audio.js'

/* ═══════════════════════════════════════════════════════════════
   COMPARTILHAR TELA
   O botão da sidebar SEMPRE abre o seletor de fonte — inclusive já
   transmitindo, quando ele serve pra trocar de tela. Antes ele era um
   toggle cru (clicou compartilhando = parou na hora), e a única forma de
   mostrar outra tela era parar e começar de novo, o que derrubava todo
   mundo que estava assistindo. Parar agora é o botão vermelho do próprio
   modal (ver btn-stop-transmit).
═══════════════════════════════════════════════════════════════ */
$('btn-toggle-share').onclick = () => openSourcePicker()

// Qualidade de transmissão — resolução (altura, em px) e taxa de quadros.
// Escolhidas no modal de fonte, aplicadas como constraints da captura.
// Alturas de captura oferecidas no modal. 1440p (2560x1440) é o teto: é a
// resolução nativa de boa parte dos monitores ultrawide/QHD, e capturar
// acima da tela real não acrescenta detalhe nenhum — só banda.
const QUALITY_HEIGHTS = {
  720:  { width: 1280, height: 720 },
  1080: { width: 1920, height: 1080 },
  1440: { width: 2560, height: 1440 },
}
let selectedSourceId = null
let selectedQuality = {
  resolution: 1080,
  fps: 30,
  // Vem por padrão com som; se a pessoa mudar no modal, fica salvo em
  // localStorage e essa vira a escolha padrão dali pra frente.
  audio: localStorage.getItem(SHARE_AUDIO_KEY) !== 'off',
  /* De onde o som sai:
       { modo: 'exclude' }                → tudo da máquina menos o ShareSync
       { modo: 'include', pid, nome }     → só o som daquele aplicativo
     Não é lembrado entre aberturas do modal porque o PID muda a cada vez
     que o app é reiniciado — guardar um PID velho apontaria pra nada (ou,
     pior, pro processo errado). */
  audioSource: { modo: 'exclude' },
}

async function openSourcePicker() {
  // Pede ao main process a lista de fontes
  const sources = await window.electronAPI.getSources()
  selectedSourceId = null
  showSourcePicker(sources)
  // A lista de quem está com som muda o tempo todo, então é montada a cada
  // abertura — e não no boot.
  await popularFontesDeAudio()
}

/* ═══════════════════════════════════════════════════════════════
   DE ONDE VEM O SOM DA TRANSMISSÃO
   Só faz sentido com a captura por aplicativo disponível; sem ela o áudio
   é o loopback do sistema inteiro e não há o que escolher.
═══════════════════════════════════════════════════════════════ */
async function popularFontesDeAudio() {
  const grupo = $('share-audio-source-group')
  if (!await isSystemAudioAvailable()) {
    grupo.classList.add('hidden')
    selectedQuality.audioSource = { modo: 'exclude' }
    return
  }

  const select = $('share-audio-source')
  const apps = await listSystemAudioApps()
  select.innerHTML = '<option value="">Todo o sistema (sem o ShareSync)</option>'
    + apps.map(a => `<option value="${a.pid}" data-nome="${a.nome}">`
      + `Apenas ${a.nome}${a.tocando ? ' — tocando agora' : ''}</option>`).join('')
  select.value = ''
  selectedQuality.audioSource = { modo: 'exclude' }
  grupo.classList.remove('hidden')

  select.onchange = () => {
    const opcao = select.selectedOptions[0]
    selectedQuality.audioSource = select.value
      ? { modo: 'include', pid: Number(select.value), nome: opcao?.dataset.nome }
      : { modo: 'exclude' }
  }
}

/* Compartilhar uma JANELA já sugere o áudio daquele aplicativo: é quase
   sempre o que a pessoa quer, e evita mandar o Discord junto sem perceber.
   Fonte de tela inteira não tem processo dono, então fica no padrão. */
async function sugerirAudioDaJanela(sourceId) {
  const select = $('share-audio-source')
  if ($('share-audio-source-group').classList.contains('hidden')) return
  const pid = await windowAudioPid(sourceId)
  if (!pid) return
  const opcao = [...select.options].find(o => o.value === String(pid))
  if (!opcao) return // aquele app não tem sessão de áudio — nada a sugerir
  select.value = String(pid)
  select.onchange()
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

  updateModalMode()
  updateTransmitButton()
  $('modal-source').classList.remove('hidden')
}

// O mesmo modal serve pra começar e pra trocar de tela — o que muda é o
// título, o texto do botão principal e a presença do "Parar de transmitir".
function updateModalMode() {
  const sharing = state.sharing
  $('modal-source-title').textContent = sharing
    ? 'Trocar o que está compartilhando'
    : 'Escolher o que compartilhar'
  $('transmit-label').textContent = sharing ? 'Trocar tela' : 'Transmitir'
  $('btn-stop-transmit').classList.toggle('hidden', !sharing)
}

// Seleciona a fonte (tela/janela) sem já iniciar a transmissão — quem
// dispara é o botão "Transmitir", depois de escolher a qualidade também.
function selectSource(sourceId) {
  selectedSourceId = sourceId
  $('source-grid').querySelectorAll('.source-item').forEach(el => {
    el.classList.toggle('selected', el.dataset.sourceId === sourceId)
  })
  updateTransmitButton()
  sugerirAudioDaJanela(sourceId)
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
  // Já transmitindo = trocar de tela sem derrubar quem assiste.
  if (state.sharing) switchSource(selectedSourceId, selectedQuality)
  else captureSource(selectedSourceId, selectedQuality)
}

$('btn-stop-transmit').onclick = () => {
  closeSourceModal()
  stopSharing()
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

/* ═══════════════════════════════════════════════════════════════
   ÁUDIO DO SISTEMA SEM PROCESSAMENTO
   Pedir `audio: true` faz o Chromium aplicar o processamento padrão de voz
   na track capturada: cancelamento de eco, supressão de ruído e ganho
   automático. Isso é o certo para microfone e o EXATO oposto do que se quer
   num loopback do sistema.

   O sintoma que isso causava: quem assistia ouvia o som da transmissão
   abafar, "afunilar" e sumir sempre que alguém falava no chat de voz. O
   cancelador de eco enxerga o áudio do sistema como eco a ser removido —
   afinal ele é literalmente o que está saindo nas caixas — e o ataca assim
   que detecta voz. Jogo, música e vídeo iam junto.

   Desligando os três, o som do sistema é transmitido cru, como deveria.
   Isso NÃO tem relação com excluir o áudio de um app específico da captura:
   loopback do Windows é tudo ou nada, e continua sendo.
═══════════════════════════════════════════════════════════════ */
const SHARE_AUDIO_CONSTRAINTS = {
  echoCancellation: false,
  noiseSuppression: false,
  autoGainControl: false,
}

async function captureWithSystemAudio(quality) {
  try {
    return await navigator.mediaDevices.getDisplayMedia({
      video: buildVideoConstraints(quality),
      audio: SHARE_AUDIO_CONSTRAINTS,
      systemAudio: 'include',
    })
  } catch (err) {
    // Versão do Chromium que não aceita essas constraints no áudio de tela:
    // volta ao pedido simples. O som volta a sofrer o abafamento descrito
    // acima, mas é melhor do que transmitir sem áudio nenhum.
    if (err?.name !== 'OverconstrainedError' && err?.name !== 'TypeError') throw err
    appLog('WARN', `Constraints de áudio recusadas (${err.name}) — usando áudio padrão`)
    return navigator.mediaDevices.getDisplayMedia({
      video: buildVideoConstraints(quality),
      audio: true,
      systemAudio: 'include',
    })
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

// Qual é o dispositivo de saída padrão na hora da falha — é a informação
// que decide o diagnóstico depois, e some se não for gravada agora.
async function logAudioOutputDevice() {
  try {
    const devices = await navigator.mediaDevices.enumerateDevices()
    const padrao = devices.find(d => d.kind === 'audiooutput' && d.deviceId === 'default')
    appLog('INFO', `[SHARE] saída de áudio padrão no momento da falha: ${padrao?.label || 'desconhecida'}`)
  } catch { /* enumerateDevices indisponível — segue sem essa informação */ }
}

// Captura de fato, com todo o fallback de áudio. Devolve { stream,
// audioIssue } e deixa pra quem chamou decidir o que fazer com a stream
// (começar a transmitir ou trocar a que já está no ar). Lança se nem o
// vídeo deu certo — é isso que permite ao switchSource abortar sem tocar
// na transmissão em andamento.
async function acquireStream(sourceId, quality) {
  // Avisa o processo principal qual fonte usar quando o getDisplayMedia()
  // abaixo disparar o setDisplayMediaRequestHandler (src/main/window.js) —
  // sem isso, ele sempre pegava a primeira tela da lista, ignorando a
  // escolhida aqui.
  window.electronAPI?.setCaptureSourceId(sourceId)

  let stream
  let audioIssue = null

  if (!quality.audio) {
    // Escolha explícita de "Sem som" no modal — nem tenta capturar áudio.
    stream = await captureVideoOnly(sourceId, quality)
  } else if (await isSystemAudioAvailable()) {
    /* CAMINHO PREFERIDO — captura por processo (ver webrtc/system-audio.js).
       O vídeo vem do getDisplayMedia normal e o áudio vem do módulo nativo,
       que captura a máquina inteira MENOS o próprio ShareSync. É isso que
       impede a voz do chat de voltar dentro do áudio da tela: ela sai da
       captura na origem, em vez de ser abafada depois.
       De quebra funciona em máquinas onde o loopback do Chromium nem abre,
       porque escolhe o próprio formato em vez de herdar o do endpoint. */
    stream = await captureVideoOnly(sourceId, quality)
    const trilha = await startSystemAudioTrack(quality.audioSource)
    if (trilha) {
      stream.addTrack(trilha)
    } else {
      // Disponível mas não abriu: cai pro loopback antigo antes de desistir
      // do áudio — é melhor ter som com eco do que não ter som.
      appLog('WARN', '[SHARE] captura por processo não abriu — tentando o loopback do sistema')
      try {
        const comLoopback = await captureWithSystemAudio(quality)
        stream.getTracks().forEach(t => t.stop())
        stream = comLoopback
      } catch (err) {
        await logAudioOutputDevice()
        audioIssue = err
        appLog('WARN', `[SHARE] loopback do sistema também falhou (${err.message}) — transmitindo só vídeo`)
      }
    }
  } else {
    // Sem o módulo nativo (Windows antigo, binário ausente): loopback do
    // sistema inteiro, o caminho de sempre — com o eco que ele traz junto.
    try {
      stream = await captureWithSystemAudio(quality)
    } catch (err) {
      // "Could not start audio source" é o WASAPI loopback do Windows se
      // recusando a abrir. Medido num caso real: falha em TODAS as
      // variações — tela ou janela, com ou sem constraints de áudio, com
      // 'loopback' ou 'loopbackWithMute' —, o que descarta a fonte e as
      // constraints como causa. O que sobra é o dispositivo de saída: modo
      // exclusivo ligado, formato não suportado, ou um driver virtual (o
      // caso visto foi um headset sem fio Logitech). Nada disso o app tem
      // como contornar por código — mas também não pode impedir a
      // transmissão do vídeo.
      const isAudioIssue = err?.name === 'NotReadableError' && /audio/i.test(err.message || '')
      if (!isAudioIssue) throw err

      audioIssue = err
      await logAudioOutputDevice()
      appLog('WARN', `Captura de áudio do sistema falhou (${err.message}) — transmitindo só vídeo.`
        + ' Causas conhecidas, em ordem: antivírus com proteção de captura de áudio;'
        + ' controle exclusivo ligado no dispositivo de saída; driver do dispositivo.'
        + ' Use Configurações → Avançado → "Testar áudio do sistema" para isolar.')
      stream = await captureVideoOnly(sourceId, quality)
    }
  }

  if (!stream || stream.getVideoTracks().length === 0) {
    stream?.getTracks().forEach(t => t.stop())
    throw new Error('Nenhuma track de vídeo capturada.')
  }

  return { stream, audioIssue }
}

// Para de compartilhar quando a captura morre por fora do app: a pessoa
// clicou em "Parar de compartilhar" na barrinha nativa do Chromium, ou a
// janela que estava sendo capturada foi fechada.
function watchTrackEnd(stream) {
  stream.getVideoTracks()[0].onended = () => stopSharing()
}

// Desarma o onended ANTES de parar as tracks — sem isso, descartar a
// captura antiga numa troca de tela dispararia o handler acima e
// derrubaria a transmissão inteira no meio da troca.
function discardStream(stream) {
  stream?.getTracks().forEach(t => {
    t.onended = null
    t.stop()
  })
}

async function captureSource(sourceId, quality) {
  $('modal-source').classList.add('hidden')

  try {
    const { stream, audioIssue } = await acquireStream(sourceId, quality)

    const track = stream.getVideoTracks()[0]
    console.log('Stream capturada:', track.label, track.getSettings(),
      '| áudio:', stream.getAudioTracks().length > 0)

    state.localStream = stream
    state.sharing = true

    // Botão só com ícone (a sidebar ficou estreita demais pra caber texto
    // depois que virou grid 1fr/1fr com o de configurações) — o estado
    // (compartilhando ou não) fica no title (tooltip) e na cor de fundo.
    $('btn-toggle-share').classList.add('sharing')
    $('btn-toggle-share').title = 'Trocar de tela ou parar de compartilhar'

    sendWS({ type: 'start-sharing' })
    // O aviso sonoro só tocava pra quem VIA alguém compartilhar; quem
    // compartilhava não ouvia confirmação nenhuma.
    playSound('share-start')

    watchTrackEnd(stream)

    // A própria tela entra no palco junto com as dos outros (ver
    // js/self-tile.js). A prévia flutuante do canto é outra coisa, opcional
    // em Configurações → Vídeo (ver updateSelfPreview).
    renderSelfTile()
    updateSelfPreview()
    startSnapshotLoop()
    renderParticipants()
    appLog('INFO', `Compartilhamento iniciado (áudio: ${stream.getAudioTracks().length > 0}, `
      + `qualidade: ${quality.resolution}p@${quality.fps}fps)`)
    if (audioIssue) {
      toast('Transmitindo sem o som do sistema — o Windows recusou a captura. Veja o log em Configurações → Avançado.')
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

/* ═══════════════════════════════════════════════════════════════
   TROCAR DE TELA SEM PARAR A TRANSMISSÃO
   Captura a fonte nova ANTES de mexer em qualquer coisa: se a pessoa
   cancelar o seletor nativo ou a captura falhar, a transmissão atual
   continua exatamente como estava.

   A troca em si é só replaceTrack em cada conexão de quem me assiste (ver
   replaceSharedStream em screen-share-peers.js) — nenhuma
   RTCPeerConnection é fechada e nenhuma renegociação acontece, então
   ninguém precisa clicar em "Assistir" de novo nem vê a tela piscar preta.
   Também não se manda stop-sharing/start-sharing: pros outros nenhum
   estado mudou, só o conteúdo do vídeo — sem toast repetido nem som de
   aviso tocando de novo a cada troca.
═══════════════════════════════════════════════════════════════ */
async function switchSource(sourceId, quality) {
  $('modal-source').classList.add('hidden')

  let captured
  try {
    captured = await acquireStream(sourceId, quality)
  } catch (err) {
    console.error('Erro ao trocar de tela:', err)
    appLog('ERROR', `Falha ao trocar de tela: ${err.message}`)
    toast(`Não foi possível trocar de tela: ${err.message}`)
    return // a transmissão atual segue intacta
  }

  const { stream, audioIssue } = captured
  const previous = state.localStream

  state.localStream = stream
  watchTrackEnd(stream)

  try {
    // Precisa vir DEPOIS de state.localStream = stream: applyViewerQuality
    // lê a altura nativa dali pra recalcular o scaleResolutionDownBy de
    // quem tinha pedido uma resolução específica.
    await replaceSharedStream(stream)
  } catch (err) {
    console.warn('[SHARE] Falha ao aplicar a nova tela nas conexões:', err)
    appLog('WARN', `Falha ao aplicar a nova tela em quem assiste: ${err.message}`)
  }

  // Só agora descarta a captura antiga — soltar antes deixaria quem
  // assiste alguns frames sem imagem nenhuma durante a troca.
  discardStream(previous)

  renderSelfTile()
  updateSelfPreview()
  // O <video> escondido do snapshot ainda aponta pra stream antiga.
  startSnapshotLoop()

  const viewers = Object.keys(state.sharePeers).length
  appLog('INFO', `Tela trocada em transmissão (${viewers} assistindo, áudio: `
    + `${stream.getAudioTracks().length > 0}, qualidade: ${quality.resolution}p@${quality.fps}fps)`)
  toast(audioIssue
    ? 'Tela trocada, mas sem o som do sistema — o Windows recusou a captura.'
    : 'Tela trocada!')
}

// notifyServer: false é usado quando o socket JÁ caiu (ver teardownRoomMedia
// em websocket.js) — o sendWS abaixo não chegaria a ninguém, e o toast de
// "Você parou de compartilhar" seria enganoso: quem parou foi a queda do
// servidor, não a pessoa.
export function stopSharing({ notifyServer = true } = {}) {
  if (!state.sharing) return
  discardStream(state.localStream)
  // A captura nativa é global da máquina: sem parar aqui, ela seguiria
  // lendo áudio pra ninguém depois que a transmissão acabou.
  stopSystemAudioTrack()
  state.localStream = null
  state.sharing = false
  renderSelfTile()
  updateSelfPreview()
  stopSnapshotLoop()

  $('btn-toggle-share').classList.remove('sharing')
  $('btn-toggle-share').title = 'Compartilhar tela'

  if (notifyServer) {
    sendWS({ type: 'stop-sharing' })
    playSound('share-stop')
  }

  // Só fecha as conexões em que EU estava enviando minha tela — antes
  // isso fechava também as conexões em que eu estava assistindo outras
  // pessoas (mesmo mapa pros dois sentidos), derrubando o que eu via
  // só porque eu parei de compartilhar a minha.
  Object.keys(state.sharePeers).forEach(uid => closeSharePeer(uid))

  renderParticipants()
  appLog('INFO', 'Compartilhamento encerrado')
  if (notifyServer) toast('Você parou de compartilhar.')
}
