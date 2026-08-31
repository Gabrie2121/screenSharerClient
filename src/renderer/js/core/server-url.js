import { state } from './state.js'

/* ═══════════════════════════════════════════════════════════════
   ENDEREÇO HTTP DO SERVIDOR

   O campo do login guarda o endereço do WebSocket (`ws://host:8000`),
   porque é o que a sala usa o tempo todo. As partes REST — criar sala e os
   anexos do chat — falam no MESMO host e porta, só que por HTTP, e a
   conversão é literalmente trocar o protocolo:

     ws://  → http://        wss:// → https://

   Fica aqui, num lugar só, porque a mesma troca já era feita solta em
   js/login.js e passaria a ser feita de novo pelo chat. Duas cópias da
   mesma regra é como se descobre, meses depois, que uma delas nunca
   aprendeu a lidar com `wss://`.

   O segundo parâmetro existe pro botão "Criar sala": ali o endereço ainda
   está só no campo de texto — `state.serverUrl` só é preenchido quando a
   entrada na sala começa de fato (ver enterRoom em js/login.js).
═══════════════════════════════════════════════════════════════ */
export function httpUrl(caminho = '', servidor = null) {
  const base = (servidor ?? state.serverUrl ?? '')
    .replace(/^ws/, 'http')
    .replace(/\/+$/, '')
  return `${base}${caminho}`
}
