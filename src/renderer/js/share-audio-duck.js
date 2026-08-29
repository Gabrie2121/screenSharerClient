import { state } from './core/state.js'

/* ═══════════════════════════════════════════════════════════════
   ABAIXAR O SOM DA TRANSMISSÃO ENQUANTO ALGUÉM FALA

   O PROBLEMA QUE ISTO RESOLVE — vale entender antes de mexer:

   O áudio compartilhado é o loopback do Windows, ou seja, TUDO o que está
   tocando na máquina de quem transmite. E o que está tocando ali inclui o
   chat de voz: as vozes de todo mundo, que o app da pessoa está
   reproduzindo naquele instante.

   O resultado é um laço:

     você fala → sua voz chega na máquina de quem compartilha →
     o app dela toca sua voz → o loopback captura sua voz junto com o
     jogo → volta pra você dentro do áudio da tela → você se ouve,
     atrasado.

   Não é um defeito de código: é consequência de o loopback ser do sistema
   inteiro. Não existe API no Chromium/Electron pra excluir o áudio de um
   aplicativo específico da captura (ver CLAUDE.md), então a voz não tem
   como ficar de fora na origem.

   POR QUE NÃO RESOLVER COM CANCELAMENTO DE ECO: já foi tentado (ver
   SHARE_AUDIO_CONSTRAINTS em webrtc/capture.js). O cancelador do Chromium
   usa a saída do sistema como referência — e numa captura de loopback a
   referência É a própria captura, então ele cancela tudo: jogo, música e
   vídeo iam junto com a voz.

   O QUE ISTO FAZ: do lado de QUEM ASSISTE, abaixa o volume do áudio das
   telas enquanto houver alguém falando, e devolve quando o silêncio volta.
   Ataque rápido (a voz já chega junto) e retorno lento (pra não ficar
   "bombeando" entre uma frase e outra). A voz em si nunca é tocada — ela
   vem por outro caminho (ver voice/peers.js) e continua em volume cheio.

   É o mesmo princípio do "ducking" de qualquer mesa de som, e resolve o
   laço inteiro: some a sua voz repetida e a dos outros duplicada.
═══════════════════════════════════════════════════════════════ */

// Volume "de verdade" escolhido em cada card (0..1), antes do abaixamento.
// WeakMap pra não segurar vídeo nenhum na memória depois que o card sai.
const volumeBase = new WeakMap()

// Fator atual, 1 = sem abaixar. Caminha suave até o alvo (ver passo()).
let fator = 1
let timer = null

const INTERVALO_MS = 40
// Ataque rápido, retorno lento: a fala começa de repente, mas voltar o som
// no mesmo ritmo faria o jogo pulsar a cada pausa entre palavras.
const PASSO_DESCIDA = 0.22
const PASSO_SUBIDA = 0.035

function alvo() {
  if (!state.duckWhileTalking) return 1
  // state.speaking inclui o próprio usuário (ver startSpeakingLoop) — é o
  // que faz a SUA voz repetida sumir, que é o sintoma mais incômodo.
  if (state.speaking.size === 0) return 1
  return Math.max(0, Math.min(100, 100 - state.duckAmount)) / 100
}

function aplicarEmTodos() {
  document.querySelectorAll('.stream-card video').forEach((video) => {
    const base = volumeBase.get(video)
    if (base == null) return
    video.volume = base * fator
  })
}

function passo() {
  const destino = alvo()
  if (Math.abs(fator - destino) < 0.005) {
    if (fator !== destino) { fator = destino; aplicarEmTodos() }
    return
  }
  fator += fator > destino
    ? -Math.min(PASSO_DESCIDA, fator - destino)
    : Math.min(PASSO_SUBIDA, destino - fator)
  aplicarEmTodos()
}

export function startShareAudioDuck() {
  if (timer) return
  timer = setInterval(passo, INTERVALO_MS)
}

export function stopShareAudioDuck() {
  clearInterval(timer)
  timer = null
  fator = 1
  aplicarEmTodos()
}

/* ── Único caminho para mexer no volume de um card ──
   Guarda o valor escolhido pela pessoa e aplica o abaixamento por cima.
   Atribuir `video.volume` direto em qualquer outro lugar faria o próximo
   passo do ducking sobrescrever a escolha dela. */
export function setCardVolume(video, percent) {
  const base = Math.max(0, Math.min(100, Number(percent) || 0)) / 100
  volumeBase.set(video, base)
  video.volume = base * fator
}

// Volume escolhido no card, ignorando o abaixamento — usado por quem
// precisa saber o valor "real" (ver syncVolumeIcon em stream-cards.js).
export function getCardVolume(video) {
  return (volumeBase.get(video) ?? 0) * 100
}
