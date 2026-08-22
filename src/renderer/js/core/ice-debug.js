import { appLog } from './logger.js'

/* ═══════════════════════════════════════════════════════════════
   DIAGNÓSTICO DE ICE
   O app registrava só "a conexão falhou", sem dizer POR QUÊ — e "ICE não
   conseguiu conectar nem via TURN" era um palpite no texto da mensagem,
   não algo medido. Isso deixa impossível separar três causas muito
   diferentes que produzem exatamente o mesmo sintoma ("Conectando…" pra
   sempre):

   1. Nenhum candidato srflx/relay coletado → STUN/TURN fora do ar ou com
      credencial inválida. Só sobra o candidato host.
   2. Só candidatos host, e eles vêm ofuscados por mDNS (`.local`) → duas
      pontas em máquinas/processos diferentes não conseguem resolver o
      nome uma da outra, e nem na mesma rede local a conexão fecha.
   3. Candidatos existem dos dois lados mas nenhum par passa → firewall
      simétrico/NAT restritivo de verdade.

   Este módulo anexa a instrumentação em qualquer RTCPeerConnection e
   despeja no log do app o que foi coletado e como terminou. É barato
   (alguns Sets e um resumo por conexão) e vale ficar ligado: quando
   alguém reclamar que "não carrega a tela", o log já responde qual das
   três é.
═══════════════════════════════════════════════════════════════ */

export function attachIceDebug(pc, label) {
  // Tipos de candidato que EU gerei e os que RECEBI do outro lado — os
  // dois lados importam: se eu coleto relay e o outro não, a culpa é da
  // rede dele, e vice-versa.
  const localTypes = new Set()
  const remoteTypes = new Set()
  let mdnsLocal = 0
  let reported = false

  pc.addEventListener('icecandidate', (e) => {
    if (!e.candidate) {
      // candidate null = fim da coleta. É aqui que dá pra afirmar o que
      // NÃO apareceu.
      appLog('INFO', `[ICE ${label}] coleta encerrada — tipos locais: `
        + `${[...localTypes].join(',') || 'NENHUM'}`
        + (mdnsLocal ? ` (${mdnsLocal} host ofuscado por mDNS)` : ''))
      if (!localTypes.has('srflx') && !localTypes.has('relay')) {
        appLog('WARN', `[ICE ${label}] nenhum candidato srflx/relay — STUN e TURN não responderam. `
          + `Só resta o host, que entre redes diferentes não conecta.`)
      }
      return
    }
    localTypes.add(e.candidate.type)
    if (/\.local(\s|$)/.test(e.candidate.candidate)) mdnsLocal++
  })

  // Candidatos do outro lado passam por addIceCandidate; quem chama
  // registra aqui (ver noteRemoteCandidate).
  pc.__iceDebugRemote = (candidate) => {
    const m = /typ (\w+)/.exec(candidate?.candidate || '')
    if (m) remoteTypes.add(m[1])
  }

  pc.addEventListener('iceconnectionstatechange', async () => {
    const st = pc.iceConnectionState
    console.log(`[ICE ${label}]`, st)

    if (st === 'connected' || st === 'completed') {
      if (reported) return
      reported = true
      const pair = await selectedPair(pc)
      appLog('INFO', `[ICE ${label}] CONECTADO via ${pair || 'par desconhecido'}`)
    }

    if (st === 'failed') {
      appLog('WARN', `[ICE ${label}] FALHOU — locais: ${[...localTypes].join(',') || 'nenhum'}`
        + ` | remotos: ${[...remoteTypes].join(',') || 'nenhum'}`
        + (mdnsLocal ? ` | ${mdnsLocal} host meus vieram como .local (mDNS)` : ''))
    }
  })
}

// Registra o tipo do candidato recebido do outro lado, se a conexão
// estiver instrumentada. Silencioso quando não estiver.
export function noteRemoteCandidate(pc, candidate) {
  pc?.__iceDebugRemote?.(candidate)
}

// Descreve o par que venceu — "host <-> host", "relay <-> srflx", etc.
// É a prova concreta de por onde a mídia está passando (e se está
// custando banda de TURN).
async function selectedPair(pc) {
  try {
    const stats = await pc.getStats()
    let pairId = null
    const cands = {}
    stats.forEach(r => {
      if (r.type === 'transport' && r.selectedCandidatePairId) pairId = r.selectedCandidatePairId
      if (r.type === 'local-candidate' || r.type === 'remote-candidate') cands[r.id] = r
    })
    let pair = pairId ? stats.get(pairId) : null
    if (!pair) {
      stats.forEach(r => {
        if (r.type === 'candidate-pair' && r.state === 'succeeded' && r.nominated) pair = r
      })
    }
    if (!pair) return null
    const l = cands[pair.localCandidateId]?.candidateType || '?'
    const r = cands[pair.remoteCandidateId]?.candidateType || '?'
    return `${l} <-> ${r}`
  } catch {
    return null
  }
}
