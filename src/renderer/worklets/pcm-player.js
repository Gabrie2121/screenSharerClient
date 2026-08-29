/* ═══════════════════════════════════════════════════════════════
   PCM-PLAYER — transforma os blocos de áudio do módulo nativo numa saída
   contínua de Web Audio.

   O módulo nativo (ver native/process-audio) entrega blocos de 20ms pelo
   IPC; o Web Audio consome quadros de 128 amostras num relógio próprio. O
   ring buffer no meio absorve essa diferença de ritmo.

   POR QUE UM RING BUFFER E NÃO UMA FILA DE BLOCOS: os dois relógios (o do
   dispositivo de áudio do Windows e o do AudioContext) nunca batem
   exatamente. Sem folga, qualquer atraso de IPC vira um estalo. O buffer
   guarda ~200ms e só começa a tocar quando junta um mínimo — daí em diante
   o áudio sai contínuo.
═══════════════════════════════════════════════════════════════ */

const CANAIS = 2
const TAXA = 48000
// 400ms de anel: cabe o dobro do pré-enchimento e ainda sobra pra
// engasgos de IPC sem estourar.
const TAMANHO_ANEL = TAXA * 0.4
// Só começa a tocar com 60ms acumulados — sem isso o primeiro segundo sai
// picotado, porque o consumo alcança a produção antes de ela estabilizar.
const MINIMO_PRA_COMECAR = TAXA * 0.06

class PcmPlayer extends AudioWorkletProcessor {
  constructor() {
    super()
    this.anel = Array.from({ length: CANAIS }, () => new Float32Array(TAMANHO_ANEL))
    this.escrita = 0
    this.leitura = 0
    this.disponivel = 0
    this.tocando = false
    this.port.onmessage = (e) => this.receber(e.data)
  }

  receber(intercalado) {
    const quadros = intercalado.length / CANAIS
    for (let i = 0; i < quadros; i++) {
      // Anel cheio: descarta o mais antigo. Acontece se o renderer travar
      // por um instante — perder alguns milissegundos é melhor do que
      // acumular atraso pra sempre.
      if (this.disponivel === TAMANHO_ANEL) {
        this.leitura = (this.leitura + 1) % TAMANHO_ANEL
        this.disponivel--
      }
      for (let c = 0; c < CANAIS; c++) {
        this.anel[c][this.escrita] = intercalado[i * CANAIS + c]
      }
      this.escrita = (this.escrita + 1) % TAMANHO_ANEL
      this.disponivel++
    }
  }

  process(_inputs, outputs) {
    const saida = outputs[0]
    const quadros = saida[0].length

    if (!this.tocando && this.disponivel >= MINIMO_PRA_COMECAR) this.tocando = true

    if (!this.tocando || this.disponivel < quadros) {
      // Silêncio enquanto não há o suficiente — e volta a esperar o
      // mínimo antes de retomar, senão entraria num ciclo de picotes.
      if (this.tocando && this.disponivel < quadros) this.tocando = false
      for (let c = 0; c < saida.length; c++) saida[c].fill(0)
      return true
    }

    for (let i = 0; i < quadros; i++) {
      for (let c = 0; c < saida.length; c++) {
        saida[c][i] = this.anel[Math.min(c, CANAIS - 1)][this.leitura]
      }
      this.leitura = (this.leitura + 1) % TAMANHO_ANEL
      this.disponivel--
    }
    return true
  }
}

registerProcessor('pcm-player', PcmPlayer)
