import { state } from '../core/state.js'
import { httpUrl } from '../core/server-url.js'
import { toast } from '../core/toast.js'
import { appLog } from '../core/logger.js'

/* ═══════════════════════════════════════════════════════════════
   ANEXOS DO CHAT — sobem por HTTP, não pelo WebSocket

   O socket da sala carrega offer/answer/ice-candidate. Um arquivo em
   base64 atravessado nele seria um frame único de dezenas de MB à frente
   dos candidatos ICE na MESMA conexão TCP: alguém mandando um vídeo
   travaria a negociação de tela e de voz de todo mundo. Por isso o binário
   vai por POST (ver routes/uploads.py no backend) e pelo socket só trafega
   o `file_id` que o servidor devolve.

   O fluxo tem duas etapas de propósito: o arquivo sobe assim que é
   escolhido (aparecendo na bandeja acima do campo de texto, com barra de
   progresso), e só quando a pessoa aperta Enter é que a MENSAGEM sai
   levando os ids. É o que permite anexar, ver a prévia, mudar de ideia e
   remover — sem nunca ter mandado nada pra sala.
═══════════════════════════════════════════════════════════════ */

// Espelha MAX_FILE_BYTES do backend. A conferência é feita AQUI, antes de
// subir, e não só lá: o servidor corta o corpo no meio do stream quando
// passa do teto, e do lado do cliente isso chega como "a conexão caiu", não
// como um erro legível. Conferir antes é o que transforma isso num aviso
// claro em vez de uma falha misteriosa depois de 30s de upload.
export const MAX_FILE_BYTES = 25 * 1024 * 1024
const MAX_ANEXOS_POR_MENSAGEM = 10

// O servidor decide o `kind` de verdade (é ele que serve o arquivo depois);
// esta lista existe só pra bandeja já mostrar a miniatura certa enquanto o
// upload acontece. Mesma lista de INLINE_IMAGE_TYPES no backend.
const TIPOS_DE_IMAGEM = new Set([
  'image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/bmp',
])

let proximoId = 1
// Quem redesenha a bandeja. Registrado por chat.js — este módulo não
// conhece o DOM do painel.
let aoMudar = () => {}

export function onDraftsChange(cb) { aoMudar = cb }

export function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

export function attachmentUrl(fileId) {
  return httpUrl(`/api/rooms/${state.roomId}/uploads/${fileId}`)
}

/* ── Dimensões da imagem ────────────────────────────────────────
   Vão junto no upload pra que o card da mensagem já nasça com a altura
   certa. Sem isso, cada imagem que termina de carregar empurra a conversa
   pra baixo e a pessoa perde a linha que estava lendo. */
function dimensoesDaImagem(file) {
  return new Promise((resolve) => {
    if (!TIPOS_DE_IMAGEM.has(file.type)) return resolve(null)
    const url = URL.createObjectURL(file)
    const img = new Image()
    img.onload = () => {
      resolve({ w: img.naturalWidth, h: img.naturalHeight })
      URL.revokeObjectURL(url)
    }
    // Uma imagem corrompida não pode impedir o envio — sobe sem dimensão.
    img.onerror = () => { resolve(null); URL.revokeObjectURL(url) }
    img.src = url
  })
}

/* ── Upload com progresso ───────────────────────────────────────
   XMLHttpRequest e não fetch: fetch ainda não reporta progresso de UPLOAD
   (só de download). Num arquivo de 20MB numa conexão doméstica isso é a
   diferença entre uma barra andando e um app que parece travado. */
function enviarArquivo(file, dims, onProgress) {
  return new Promise((resolve, reject) => {
    const params = new URLSearchParams({ name: file.name, mime: file.type || '' })
    if (dims) { params.set('w', String(dims.w)); params.set('h', String(dims.h)) }

    const xhr = new XMLHttpRequest()
    xhr.open('POST', httpUrl(`/api/rooms/${state.roomId}/uploads?${params}`))
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) onProgress(Math.round((e.loaded / e.total) * 100))
    }
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        try { resolve(JSON.parse(xhr.responseText)) }
        catch { reject(new Error('Resposta inesperada do servidor')) }
        return
      }
      let detalhe = `Erro ${xhr.status}`
      try { detalhe = JSON.parse(xhr.responseText).detail || detalhe } catch {}
      reject(new Error(detalhe))
    }
    xhr.onerror = () => reject(new Error('Falha de rede ao enviar o anexo'))
    xhr.send(file)
  })
}

/* ── Bandeja de rascunhos ─────────────────────────────────────── */

export function addFiles(fileList) {
  const arquivos = [...fileList]
  if (!arquivos.length) return

  const espaco = MAX_ANEXOS_POR_MENSAGEM - state.chatDrafts.length
  if (espaco <= 0) {
    toast(`No máximo ${MAX_ANEXOS_POR_MENSAGEM} anexos por mensagem`)
    return
  }
  if (arquivos.length > espaco) toast(`Só cabem mais ${espaco} anexo(s) nesta mensagem`)

  for (const file of arquivos.slice(0, espaco)) {
    if (file.size > MAX_FILE_BYTES) {
      toast(`"${file.name}" tem ${formatBytes(file.size)} — o limite é ${formatBytes(MAX_FILE_BYTES)}`)
      continue
    }
    if (file.size === 0) {
      toast(`"${file.name}" está vazio`)
      continue
    }
    iniciarUpload(file)
  }
  aoMudar()
}

async function iniciarUpload(file) {
  const ehImagem = TIPOS_DE_IMAGEM.has(file.type)
  const rascunho = {
    localId:  proximoId++,
    name:     file.name,
    size:     file.size,
    mime:     file.type || 'application/octet-stream',
    kind:     ehImagem ? 'image' : 'file',
    // Prévia local, sem esperar o upload — o arquivo já está na máquina.
    preview:  ehImagem ? URL.createObjectURL(file) : null,
    fileId:   null,
    progress: 0,
    erro:     null,
  }
  state.chatDrafts.push(rascunho)
  aoMudar()

  try {
    const dims = await dimensoesDaImagem(file)
    const anexo = await enviarArquivo(file, dims, (pct) => {
      rascunho.progress = pct
      aoMudar()
    })
    // Removido enquanto subia: o upload já não interessa a ninguém.
    if (!state.chatDrafts.includes(rascunho)) return
    rascunho.fileId = anexo.file_id
    rascunho.kind = anexo.kind
    rascunho.progress = 100
  } catch (err) {
    if (!state.chatDrafts.includes(rascunho)) return
    rascunho.erro = err.message
    appLog('WARN', `Falha ao enviar anexo "${file.name}": ${err.message}`)
    toast(`Não foi possível enviar "${file.name}"`)
  }
  aoMudar()
}

export function removeDraft(localId) {
  const i = state.chatDrafts.findIndex(d => d.localId === localId)
  if (i < 0) return
  const [fora] = state.chatDrafts.splice(i, 1)
  if (fora.preview) URL.revokeObjectURL(fora.preview)
  aoMudar()
}

// Ids prontos pra irem na mensagem. Os que falharam ou ainda estão subindo
// simplesmente não entram — a mensagem sai com o que deu certo.
export function readyAttachmentIds() {
  return state.chatDrafts.filter(d => d.fileId).map(d => d.fileId)
}

export function hasUploadsInFlight() {
  return state.chatDrafts.some(d => !d.fileId && !d.erro)
}

export function clearDrafts() {
  for (const d of state.chatDrafts) {
    if (d.preview) URL.revokeObjectURL(d.preview)
  }
  state.chatDrafts.length = 0
  aoMudar()
}
