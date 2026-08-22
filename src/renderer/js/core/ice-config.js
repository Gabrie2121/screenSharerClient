/* ═══════════════════════════════════════════════════════════════
   ICE SERVERS (STUN + TURN)

   STUN sozinho só descobre o IP público. Quando as duas pontas estão em
   redes diferentes (NAT restritivo, CGNAT de operadora, firewall
   corporativo), a conexão direta não fecha e o ICE vai pra "failed" sem um
   TURN pra retransmitir a mídia.

   POR QUE VÁRIOS PROVEDORES DE STUN
   Antes havia só o metered.ca. Um log de uso real mostrou duas pessoas na
   mesma sala com resultados opostos: numa a coleta ICE terminava com
   "host,srflx" e a conexão fechava por srflx<->srflx; na outra a coleta
   NUNCA terminava e todas as conexões — voz, câmera e tela — morriam antes
   disso. Sintoma de STUN inalcançável naquela rede específica.

   Com um provedor só, isso deixa a pessoa sem absolutamente nada. Vários
   provedores independentes tornam o app resiliente a um deles estar fora
   do ar, bloqueado ou lento: o ICE consulta todos em paralelo e usa o que
   responder primeiro.

   SOBRE O TURN
   O Open Relay Project é gratuito e compartilhado — serve pra destravar
   uso entre amigos, sem garantia de uptime nem de banda. Ele é hoje o
   único caminho quando as duas pontas estão atrás de NAT simétrico, e por
   isso é o ponto único de falha mais sério do app. Um coturn próprio na
   mesma VPS do backend resolveria de vez; enquanto isso, os STUN extras
   pelo menos garantem que quem PODE conectar direto consiga.

   Ordem importa pouco (o ICE consulta em paralelo), mas manter os STUN
   antes dos TURN ajuda a preferir caminho direto quando ele existe —
   relay custa banda de terceiros e adiciona latência.
═══════════════════════════════════════════════════════════════ */
export const ICE_CONFIG = {
  iceServers: [
    // ── STUN: três operadores independentes ──
    // Um único urls com várias entradas conta como UM servidor pro ICE e é
    // consultado junto; provedores separados ficam em objetos separados de
    // propósito, pra falha de um não arrastar os outros.
    { urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] },
    { urls: 'stun:stun.cloudflare.com:3478' },
    { urls: 'stun:stun.relay.metered.ca:80' },

    // ── TURN (relay) — último recurso, quando não há caminho direto ──
    {
      urls: 'turn:global.relay.metered.ca:80',
      username: 'openrelayproject',
      credential: 'openrelayproject',
    },
    {
      urls: 'turn:global.relay.metered.ca:443',
      username: 'openrelayproject',
      credential: 'openrelayproject',
    },
    {
      // TCP/443 é o que atravessa firewall que bloqueia UDP — vale a
      // latência pior por ser, em muitas redes corporativas, o único
      // caminho que sobra. É também o motivo do timeout folgado de 25s ao
      // assistir (ver WATCH_TIMEOUT_MS em webrtc/screen-share-peers.js).
      urls: 'turn:global.relay.metered.ca:443?transport=tcp',
      username: 'openrelayproject',
      credential: 'openrelayproject',
    },
  ],
}
