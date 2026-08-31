import { $ } from '../core/dom.js'
import { state, CHAT_OPEN_KEY } from '../core/state.js'
import { iconSvg } from '../core/icons.js'
import { toast } from '../core/toast.js'
import { appLog } from '../core/logger.js'
import { playSound } from '../core/sounds.js'
import { sendWS } from '../websocket.js'
import { formatMessageText, formatTime, escapeHtml, avatarColor } from './format.js'
import {
  addFiles, removeDraft, clearDrafts, readyAttachmentIds, hasUploadsInFlight,
  onDraftsChange, attachmentUrl, formatBytes,
} from './uploads.js'

/* ═══════════════════════════════════════════════════════════════
   CHAT TEMPORÁRIO DA SALA

   Existe enquanto a sala existe. Como entrar na sala já é entrar na voz
   (todo mundo aqui se ouve o tempo todo), a conversa começa junto com a
   primeira pessoa que entra e o servidor a apaga alguns minutos depois de
   o último participante sair — quem volta ao mesmo código dentro desse
   prazo reencontra tudo onde parou. Ver core/chat_manager.py e
   EMPTY_ROOM_TTL_SECONDS em core/room_manager.py no backend.

   Nada é guardado nesta máquina: sem localStorage, sem cache em disco. Ao
   sair da sala a lista é esvaziada aqui também — mostrar de novo uma
   conversa que já não existe pra mais ninguém seria pior que não mostrar
   nada.

   A ORDEM das mensagens é sempre a do servidor. Mesmo a própria mensagem
   só aparece quando volta pelo eco: o campo é limpo na hora (é o que dá a
   sensação de resposta imediata), mas a linha só entra na lista com o id e
   o horário que o servidor pôs. Duas pessoas escrevendo ao mesmo tempo
   veem, assim, exatamente a mesma conversa.
═══════════════════════════════════════════════════════════════ */

// Mensagens seguidas da mesma pessoa dentro desta janela viram um bloco só,
// sem repetir avatar e nome — é o que faz uma conversa parecer conversa em
// vez de uma lista de fichas.
const JANELA_DE_AGRUPAMENTO_MS = 5 * 60 * 1000
// "Está digitando" some sozinho por relógio local: se a pessoa fechar o app
// no meio da frase, o aviso de "parei" nunca chegaria e o indicador ficaria
// preso na tela pra sempre.
const TEMPO_DE_DIGITANDO_MS = 6000
// De quanto em quanto tempo, no máximo, o aviso de digitação é reenviado
// enquanto a pessoa escreve sem parar.
const INTERVALO_AVISO_DIGITANDO_MS = 3000

/* ═══════════════════════════════════════════════════════════════
   ABRIR / FECHAR
═══════════════════════════════════════════════════════════════ */
export function setChatOpen(aberto, focar = true) {
  state.chatOpen = aberto
  localStorage.setItem(CHAT_OPEN_KEY, String(aberto))
  $('chat-panel').classList.toggle('hidden', !aberto)
  $('btn-chat-toggle').classList.toggle('active', aberto)

  if (!aberto) return
  zerarNaoLidas()
  rolarProFim()
  // `focar` existe pro estado inicial: no boot ainda se está na tela de
  // login, e focar o campo do chat roubaria o cursor do campo do nome.
  if (focar) $('chat-input').focus()
}

$('btn-chat-toggle').onclick = () => setChatOpen(!state.chatOpen)
$('btn-chat-close').onclick = () => setChatOpen(false)

function zerarNaoLidas() {
  state.chatUnread = 0
  const selo = $('chat-unread')
  selo.textContent = ''
  selo.classList.add('hidden')
}

function marcarNaoLida() {
  state.chatUnread++
  const selo = $('chat-unread')
  selo.textContent = state.chatUnread > 99 ? '99+' : String(state.chatUnread)
  selo.classList.remove('hidden')
}

/* ═══════════════════════════════════════════════════════════════
   ROLAGEM
   Só acompanha o fim automaticamente se a pessoa JÁ estava no fim. Quem
   subiu pra reler algo não quer ser puxado de volta a cada mensagem nova —
   ganha o botão "novas mensagens" no lugar.
═══════════════════════════════════════════════════════════════ */
const MARGEM_DE_FIM = 80

// Se a pessoa está acompanhando o fim da conversa. É um ESTADO, e não uma
// medida tirada na hora, porque as duas coisas se separam: quando a área
// da lista encolhe (a bandeja de anexos abriu, o "está digitando"
// apareceu, o campo de texto ganhou uma linha), o scrollTop fica onde
// estava e a medida passa a dizer "não está no fim" — mas a pessoa não
// rolou nada. Guardando o estado dá pra repor a rolagem no lugar.
let grudadoNoFim = true
// Último scrollTop conhecido — é a comparação com ele que distingue "a
// pessoa rolou pra cima" de "a rolagem automática aterrissou curta".
let ultimoTop = 0

function estaNoFim() {
  const el = $('chat-messages')
  return el.scrollHeight - el.scrollTop - el.clientHeight < MARGEM_DE_FIM
}

/* Atribuição direta, e nunca `scrollTo({ behavior: 'smooth' })`. A
   rolagem suave é uma animação, e animação depende de o compositor estar
   produzindo quadros: com a janela em segundo plano, minimizada ou na
   bandeja — que é metade da vida deste app — ela simplesmente não anda, e
   a conversa ficava parada onde estava enquanto as mensagens chegavam.
   Medido: 30 mensagens seguidas e um clique em "novas mensagens" deixavam
   o scrollTop em 0 com a janela fora de foco.

   A atribuição também é SÍNCRONA, o que resolve um segundo problema: o
   scrollTo só valeria no quadro seguinte, e nesse intervalo a bandeja de
   anexos ou o "está digitando" já podem ter mudado a altura da lista. */
function rolarProFim() {
  const el = $('chat-messages')
  el.scrollTop = el.scrollHeight
  ultimoTop = el.scrollTop
  grudadoNoFim = true
  $('chat-jump').classList.add('hidden')
}

/* Só um movimento PRA CIMA desgruda. Reagir a qualquer evento de scroll
   parecia mais simples e estava errado: uma rolagem automática que
   aterrissa curta (a lista encolheu entre o pedido e o quadro seguinte)
   também dispara o evento, e ali `estaNoFim()` é falso — o painel se dava
   por "a pessoa subiu pra reler" sem que ninguém tivesse tocado em nada, e
   nunca mais voltava sozinho pro fim. */
$('chat-messages').addEventListener('scroll', () => {
  const el = $('chat-messages')
  const subiu = el.scrollTop < ultimoTop - 1
  ultimoTop = el.scrollTop

  if (subiu) grudadoNoFim = estaNoFim()
  else if (estaNoFim()) grudadoNoFim = true

  if (grudadoNoFim) $('chat-jump').classList.add('hidden')
})
$('chat-jump').onclick = () => rolarProFim()

/* A lista encolheu ou cresceu sem ninguém ter rolado nada — anexar um
   arquivo era o caso mais visível: a bandeja abria, comia uns 60px de
   altura e empurrava a última mensagem pra fora da vista, bem no momento
   em que a pessoa estava prestes a mandá-la. Quem já estava no fim
   continua no fim. */
new ResizeObserver(() => {
  if (grudadoNoFim) rolarProFim()
}).observe($('chat-messages'))

/* ═══════════════════════════════════════════════════════════════
   RENDER DAS MENSAGENS
═══════════════════════════════════════════════════════════════ */
function anexosHtml(anexos) {
  if (!anexos?.length) return ''

  const itens = anexos.map((a) => {
    const url = attachmentUrl(a.file_id)
    const nome = escapeHtml(a.name)

    if (a.kind === 'image') {
      // width/height vêm do upload (ver dimensoesDaImagem) só pra reservar
      // o espaço antes de a imagem chegar — o CSS é quem manda no tamanho
      // final. Sem eles a conversa pula a cada imagem que termina de carregar.
      const proporcao = a.width && a.height ? `${a.width} / ${a.height}` : '16 / 9'
      return `
        <button class="chat-img" data-file="${a.file_id}" data-name="${nome}"
                style="aspect-ratio:${proporcao}" title="${nome}">
          <img src="${url}" alt="${nome}" loading="lazy" />
        </button>`
    }

    return `
      <div class="chat-file">
        <span class="chat-file-icon">${iconSvg('file')}</span>
        <div class="chat-file-meta">
          <span class="chat-file-name" title="${nome}">${nome}</span>
          <span class="chat-file-size">${formatBytes(a.size)}</span>
        </div>
        <button class="chat-file-dl" data-file="${a.file_id}" data-name="${nome}"
                title="Baixar">${iconSvg('download')}</button>
      </div>`
  })

  return `<div class="chat-msg-files">${itens.join('')}</div>`
}

function criarMensagem(msg, agrupada) {
  const div = document.createElement('div')
  div.className = `chat-msg${agrupada ? ' grouped' : ''}`
  div.dataset.uid = msg.user_id
  div.dataset.ts = msg.ts
  const inicial = escapeHtml(msg.username?.[0]?.toUpperCase() || '?')

  div.innerHTML = `
    ${agrupada
      ? `<div class="chat-msg-gutter">${formatTime(msg.ts)}</div>`
      : `<div class="chat-msg-avatar" style="background:${avatarColor(msg.username)}">${inicial}</div>`}
    <div class="chat-msg-body">
      ${agrupada ? '' : `
        <div class="chat-msg-head">
          <span class="chat-msg-author">${escapeHtml(msg.username)}</span>
          <span class="chat-msg-time">${formatTime(msg.ts)}</span>
        </div>`}
      ${msg.text ? `<div class="chat-msg-text">${formatMessageText(msg.text)}</div>` : ''}
      ${anexosHtml(msg.attachments)}
    </div>`

  return div
}

// Uma mensagem continua o bloco anterior quando é da mesma pessoa e veio
// logo em seguida. `ultima` é o último .chat-msg no DOM — se o que veio
// antes foi um aviso do sistema, o bloco recomeça.
function continuaBloco(ultima, msg) {
  if (!ultima) return false
  if (ultima.dataset.uid !== msg.user_id) return false
  const dt = new Date(msg.ts) - new Date(ultima.dataset.ts)
  return dt >= 0 && dt < JANELA_DE_AGRUPAMENTO_MS
}

function inserir(msg) {
  const lista = $('chat-messages')
  // lastElementChild e não `:last-of-type`: este último olha o TIPO da tag
  // (div), então bastaria um div de aviso no fim da lista pra ele apontar
  // pra coisa errada e o agrupamento sair torto.
  const anterior = lista.lastElementChild
  const ultima = anterior?.classList.contains('chat-msg') ? anterior : null
  lista.appendChild(criarMensagem(msg, continuaBloco(ultima, msg)))
  $('chat-empty').classList.add('hidden')
}

/* ── Entradas vindas do servidor (chamadas por websocket.js) ──── */

export function loadChatHistory(mensagens) {
  state.chatMessages = mensagens || []
  const lista = $('chat-messages')
  lista.innerHTML = ''
  state.chatMessages.forEach(inserir)
  $('chat-empty').classList.toggle('hidden', state.chatMessages.length > 0)
  rolarProFim()
  zerarNaoLidas()
}

export function receiveChatMessage(msg) {
  if (!msg?.id) return
  state.chatMessages.push(msg)

  // Lido ANTES de inserir: depois de a linha entrar no DOM a lista já
  // cresceu, e a medida diria "não está no fim" pra todo mundo.
  const acompanhando = grudadoNoFim
  inserir(msg)

  // Quem escreveu sempre acompanha a própria mensagem, mesmo que estivesse
  // lendo algo mais acima — apertar Enter é dizer "me leve pro fim".
  const souEu = msg.user_id === state.myId
  if (souEu || acompanhando) rolarProFim()
  else $('chat-jump').classList.remove('hidden')

  if (souEu) return

  pararDigitando(msg.user_id)
  if (!state.chatOpen) {
    marcarNaoLida()
    playSound('chat-message')
  }
}

/* ═══════════════════════════════════════════════════════════════
   "FULANO ESTÁ DIGITANDO"
═══════════════════════════════════════════════════════════════ */
export function receiveTyping(userId, username, digitando) {
  if (userId === state.myId) return

  if (!digitando) return pararDigitando(userId)

  clearTimeout(state.chatTyping[userId]?.timer)
  state.chatTyping[userId] = {
    username,
    timer: setTimeout(() => pararDigitando(userId), TEMPO_DE_DIGITANDO_MS),
  }
  renderDigitando()
}

function pararDigitando(userId) {
  clearTimeout(state.chatTyping[userId]?.timer)
  delete state.chatTyping[userId]
  renderDigitando()
}

// Chamado ao sair da sala e quando alguém desconecta — sem isso o aviso
// ficaria de pé até o timer estourar, apontando pra quem já foi embora.
export function clearTypingFor(userId) {
  pararDigitando(userId)
}

function renderDigitando() {
  const nomes = Object.values(state.chatTyping).map(t => t.username)
  const el = $('chat-typing')

  if (!nomes.length) {
    el.classList.add('hidden')
    el.textContent = ''
    return
  }

  const texto = nomes.length === 1
    ? `${nomes[0]} está digitando…`
    : nomes.length === 2
      ? `${nomes[0]} e ${nomes[1]} estão digitando…`
      : 'Várias pessoas estão digitando…'

  el.textContent = texto
  el.classList.remove('hidden')
}

let ultimoAvisoDigitando = 0
function avisarQueEstouDigitando() {
  const agora = Date.now()
  if (agora - ultimoAvisoDigitando < INTERVALO_AVISO_DIGITANDO_MS) return
  ultimoAvisoDigitando = agora
  sendWS({ type: 'chat-typing', payload: { typing: true } })
}

/* ═══════════════════════════════════════════════════════════════
   CAMPO DE TEXTO
═══════════════════════════════════════════════════════════════ */
const input = $('chat-input')
const MAX_TEXTO = 2000          // o mesmo teto do backend
const ALTURA_MAX_INPUT = 160

function ajustarAltura() {
  input.style.height = 'auto'
  input.style.height = `${Math.min(input.scrollHeight, ALTURA_MAX_INPUT)}px`
}

function atualizarBotaoEnviar() {
  const temAlgo = input.value.trim().length > 0 || readyAttachmentIds().length > 0
  $('btn-chat-send').disabled = !temAlgo
}

input.addEventListener('input', () => {
  ajustarAltura()
  atualizarBotaoEnviar()
  if (input.value.trim()) avisarQueEstouDigitando()
})

input.addEventListener('keydown', (e) => {
  // Enter envia, Shift+Enter quebra linha — a convenção de todo chat.
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault()
    enviarMensagem()
  }
})

// Colar um print direto no chat (Ctrl+V logo depois do PrintScreen) é
// metade do uso de um chat ao lado de um compartilhamento de tela.
input.addEventListener('paste', (e) => {
  const arquivos = [...(e.clipboardData?.files || [])]
  if (!arquivos.length) return
  e.preventDefault()
  addFiles(arquivos)
})

function enviarMensagem() {
  const texto = input.value.trim().slice(0, MAX_TEXTO)
  const anexos = readyAttachmentIds()

  if (!texto && !anexos.length) {
    // Nada pronto, mas há upload em curso: a pessoa apertou Enter cedo
    // demais. Avisar é melhor que engolir o Enter em silêncio.
    if (hasUploadsInFlight()) toast('Espere o anexo terminar de subir')
    return
  }

  /* Socket fechado (queda de servidor, reconexão em andamento): sendWS não
     faz nada em silêncio. Sem esta checagem o campo seria limpo do mesmo
     jeito e a mensagem sumiria sem deixar rastro — o pior desfecho
     possível, porque a pessoa acha que mandou. O texto fica onde está,
     pronto pra reenviar quando voltar. */
  if (state.ws?.readyState !== WebSocket.OPEN) {
    toast('Sem conexão com a sala — a mensagem não foi enviada')
    return
  }

  sendWS({ type: 'chat-message', payload: { text: texto, attachments: anexos } })

  // Limpa na hora — a linha só aparece quando o eco do servidor voltar
  // (ver o cabeçalho deste arquivo), mas o campo vazio é o retorno visual
  // imediato de "foi".
  input.value = ''
  ajustarAltura()
  clearDrafts()
  atualizarBotaoEnviar()
  ultimoAvisoDigitando = 0
  sendWS({ type: 'chat-typing', payload: { typing: false } })
}

$('btn-chat-send').onclick = enviarMensagem

/* ═══════════════════════════════════════════════════════════════
   ANEXAR — botão, arrastar e soltar
═══════════════════════════════════════════════════════════════ */
$('btn-chat-attach').onclick = () => $('chat-file-input').click()

$('chat-file-input').onchange = (e) => {
  addFiles(e.target.files)
  // Zera o valor pra que escolher O MESMO arquivo de novo dispare change
  // outra vez — sem isso, remover da bandeja e reanexar não funcionava.
  e.target.value = ''
}

{
  const painel = $('chat-panel')
  let profundidade = 0   // dragenter/dragleave disparam também nos filhos

  painel.addEventListener('dragenter', (e) => {
    if (!e.dataTransfer?.types?.includes('Files')) return
    e.preventDefault()
    profundidade++
    $('chat-drop').classList.remove('hidden')
  })
  painel.addEventListener('dragover', (e) => {
    if (e.dataTransfer?.types?.includes('Files')) e.preventDefault()
  })
  painel.addEventListener('dragleave', () => {
    profundidade = Math.max(0, profundidade - 1)
    if (!profundidade) $('chat-drop').classList.add('hidden')
  })
  painel.addEventListener('drop', (e) => {
    if (!e.dataTransfer?.files?.length) return
    e.preventDefault()
    profundidade = 0
    $('chat-drop').classList.add('hidden')
    addFiles(e.dataTransfer.files)
  })
}

/* ── Bandeja de anexos em preparo ─────────────────────────────── */
onDraftsChange(() => {
  const caixa = $('chat-drafts')
  caixa.classList.toggle('hidden', state.chatDrafts.length === 0)

  caixa.innerHTML = state.chatDrafts.map((d) => `
    <div class="chat-draft ${d.erro ? 'erro' : ''}" data-draft="${d.localId}">
      ${d.preview
        ? `<img class="chat-draft-thumb" src="${d.preview}" alt="" />`
        : `<span class="chat-draft-thumb chat-draft-icon">${iconSvg('file')}</span>`}
      <div class="chat-draft-meta">
        <span class="chat-draft-name" title="${escapeHtml(d.name)}">${escapeHtml(d.name)}</span>
        <span class="chat-draft-sub">${d.erro ? escapeHtml(d.erro) : formatBytes(d.size)}</span>
      </div>
      ${(!d.fileId && !d.erro)
        ? `<div class="chat-draft-bar"><span style="width:${d.progress}%"></span></div>`
        : ''}
      <button class="chat-draft-x" data-draft="${d.localId}" title="Remover">${iconSvg('close')}</button>
    </div>`).join('')

  atualizarBotaoEnviar()
})

/* ═══════════════════════════════════════════════════════════════
   CLIQUES DELEGADOS — imagens, download e links

   Um handler só no container em vez de um por elemento: a lista é
   reconstruída o tempo todo e listeners individuais teriam de ser
   religados a cada mensagem nova.
═══════════════════════════════════════════════════════════════ */
$('chat-messages').addEventListener('click', (e) => {
  const imagem = e.target.closest('.chat-img')
  if (imagem) return abrirLightbox(imagem.dataset.file, imagem.dataset.name)

  const baixar = e.target.closest('.chat-file-dl')
  if (baixar) return baixarAnexo(baixar.dataset.file, baixar.dataset.name)

  const link = e.target.closest('.chat-link')
  if (link) return abrirLink(link.dataset.href)
})

$('chat-drafts').addEventListener('click', (e) => {
  const x = e.target.closest('.chat-draft-x')
  if (x) removeDraft(Number(x.dataset.draft))
})

// Links vão pro navegador do sistema, nunca pra dentro da janela do app —
// ver o cabeçalho de chat/format.js. O processo principal ainda confere o
// protocolo antes de abrir (ver open-external em src/main/ipc.js).
function abrirLink(url) {
  if (!url) return
  window.electronAPI?.openExternal(url)
}

async function baixarAnexo(fileId, nome) {
  try {
    const destino = await window.electronAPI?.downloadFile(attachmentUrl(fileId), nome)
    if (destino) toast(`Salvo em ${destino}`)
  } catch (err) {
    appLog('ERROR', `Falha ao baixar "${nome}": ${err.message}`)
    toast('Não foi possível baixar o arquivo')
  }
}

/* ═══════════════════════════════════════════════════════════════
   LIGHTBOX — imagem em tamanho grande
═══════════════════════════════════════════════════════════════ */
let arquivoNoLightbox = null

function abrirLightbox(fileId, nome) {
  arquivoNoLightbox = { fileId, nome }
  $('chat-lightbox-img').src = attachmentUrl(fileId)
  $('chat-lightbox-name').textContent = nome
  $('chat-lightbox').classList.remove('hidden')
}

function fecharLightbox() {
  $('chat-lightbox').classList.add('hidden')
  // Solta a imagem: uma foto grande continuaria decodificada na memória com
  // o lightbox fechado, e elas se acumulam a cada abertura.
  $('chat-lightbox-img').src = ''
  arquivoNoLightbox = null
}

$('btn-chat-lightbox-close').onclick = fecharLightbox
$('chat-lightbox').onclick = (e) => { if (e.target === $('chat-lightbox')) fecharLightbox() }
$('btn-chat-lightbox-download').onclick = () => {
  if (arquivoNoLightbox) baixarAnexo(arquivoNoLightbox.fileId, arquivoNoLightbox.nome)
}

document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return
  if (!$('chat-lightbox').classList.contains('hidden')) fecharLightbox()
})

/* ═══════════════════════════════════════════════════════════════
   SAIR DA SALA
═══════════════════════════════════════════════════════════════ */
export function resetChat() {
  state.chatMessages = []
  Object.keys(state.chatTyping).forEach(pararDigitando)
  clearDrafts()
  $('chat-messages').innerHTML = ''
  $('chat-empty').classList.remove('hidden')
  $('chat-jump').classList.add('hidden')
  input.value = ''
  ajustarAltura()
  atualizarBotaoEnviar()
  zerarNaoLidas()
  fecharLightbox()
}

/* ── Estado inicial ────────────────────────────────────────────
   O painel abre no estado em que ficou da última vez: é preferência de
   quem usa, não da sala. Os [data-icon] do HTML são preenchidos pelo
   renderIcons() do fim de js/main.js, que roda depois de todos os módulos;
   o markup criado aqui em runtime já sai com iconSvg(). */
setChatOpen(state.chatOpen, false)
atualizarBotaoEnviar()
