/* ═══════════════════════════════════════════════════════════════
   ICE SERVERS (STUN + TURN)
   STUN sozinho só resolve o IP público — quando as duas pontas estão em
   redes diferentes (NAT restritivo/CGNAT de operadora, por trás de
   firewall, etc.) a conexão direta não fecha e o ICE cai em "failed" sem
   um TURN pra retransmitir a mídia. As credenciais abaixo são do Open
   Relay Project (metered.ca) — gratuitas e compartilhadas, então servem
   pra destravar o uso entre amigos, mas não são garantia de uptime/banda
   pra produção. Se a instabilidade continuar, considere subir um coturn
   próprio ou um TURN pago.
═══════════════════════════════════════════════════════════════ */
export const ICE_CONFIG = {
  iceServers: [
    { urls: 'stun:stun.relay.metered.ca:80' },
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
      urls: 'turn:global.relay.metered.ca:443?transport=tcp',
      username: 'openrelayproject',
      credential: 'openrelayproject',
    },
  ],
}
