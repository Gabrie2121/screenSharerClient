/* ═══════════════════════════════════════════════════════════════
   TEXTO DA MENSAGEM — escapar primeiro, formatar depois

   Tudo o que entra aqui foi digitado por outra pessoa e vai virar
   innerHTML. A ordem não é estilo, é segurança: o texto é escapado ANTES
   de qualquer formatação, e daí em diante só se acrescenta marcação — nada
   volta a ser interpretado como HTML.

   Num app Electron o estrago de um `<img onerror>` numa mensagem não é
   "um alerta no navegador": o renderer roda com acesso ao preload. Por
   isso este arquivo é pequeno e faz uma coisa só.

   Os links NÃO viram <a href>. Um href de verdade navegaria a janela do
   app inteira pra fora (o app não tem barra de endereço nem botão de
   voltar — a pessoa ficaria presa numa página qualquer). Viram um <span>
   com o endereço num data-*, e quem clica pede ao processo principal pra
   abrir no navegador do sistema (ver abrirLink em chat.js e
   open-external em src/main/ipc.js, que confere o protocolo).
═══════════════════════════════════════════════════════════════ */

export function escapeHtml(texto) {
  return String(texto)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

// Só http/https. Sem isso, um `javascript:` ou um `file://` digitado no
// chat viraria um link clicável apontando pra dentro da máquina.
const URL_RE = /\bhttps?:\/\/[^\s<]+[^\s<.,:;"')\]]/gi

function linkificar(escapado) {
  return escapado.replace(URL_RE, (url) => {
    // `url` já veio escapado (& virou &amp;), então o rótulo pode ir
    // direto. O data-href precisa do valor ORIGINAL pra abrir certo, e vai
    // entre aspas num atributo — o escape que sobrou dá conta disso.
    const original = url.replace(/&amp;/g, '&')
    return `<span class="chat-link" data-href="${escapeHtml(original)}" title="${escapeHtml(original)}">${url}</span>`
  })
}

// Negrito e itálico à moda do Discord. Aplicados só FORA de trechos de
// código — dentro de crase, asterisco é asterisco.
function enfatizar(escapado) {
  return escapado
    .replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, '$1<em>$2</em>')
}

/* Divide em trechos de código (`assim`) e o resto. O código sai literal;
   o resto ganha link e ênfase. Fazer isso num replace só era possível,
   mas qualquer regex que tentasse "ignorar o que está entre crases"
   ficaria ilegível — e este é o arquivo onde legibilidade importa mais. */
export function formatMessageText(texto) {
  const escapado = escapeHtml(texto)
  const partes = escapado.split(/(`[^`\n]+`)/g)

  return partes.map((parte) => {
    if (parte.startsWith('`') && parte.endsWith('`') && parte.length > 2) {
      return `<code class="chat-code">${parte.slice(1, -1)}</code>`
    }
    return enfatizar(linkificar(parte))
  }).join('').replace(/\n/g, '<br />')
}

/* ── Horário ────────────────────────────────────────────────────
   O servidor manda ISO em UTC; quem converte pro fuso de quem lê é o
   próprio navegador. Só HH:MM: a conversa é temporária e nunca atravessa
   dias, então um separador de data seria enfeite. */
export function formatTime(iso) {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  return d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })
}

// Cor do avatar a partir do nome — a mesma pessoa fica com a mesma cor em
// todas as máquinas, sem o servidor precisar mandar nada. Tons pastéis
// para o nome continuar legível sobre o fundo escuro.
const CORES_AVATAR = [
  '#5865f2', '#3ba55c', '#faa61a', '#ed4245', '#9b59b6',
  '#1abc9c', '#e91e63', '#e67e22', '#00b0f4',
]

export function avatarColor(nome) {
  let soma = 0
  for (const c of String(nome || '?')) soma = (soma + c.charCodeAt(0)) % 9973
  return CORES_AVATAR[soma % CORES_AVATAR.length]
}
