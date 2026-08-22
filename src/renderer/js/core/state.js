/* ═══════════════════════════════════════════════════════════════
   ESTADO — objeto compartilhado, mutado in-place por todos os módulos
   que precisam dele (importe `state` e leia/grave direto nas chaves).
═══════════════════════════════════════════════════════════════ */
export const SELF_PREVIEW_KEY = 'sharesync:show-self-preview'
export const DEFAULT_WATCH_QUALITY_KEY = 'sharesync:default-watch-quality'
export const SHARE_AUDIO_KEY = 'sharesync:share-audio'

// Chat de voz — preferências persistidas (ver seção "CHAT DE VOZ" em js/voice/).
export const MIC_MUTED_KEY = 'sharesync:mic-muted'
export const MIC_DEVICE_KEY = 'sharesync:mic-device'
export const SPEAKER_DEVICE_KEY = 'sharesync:speaker-device'
export const MASTER_VOLUME_KEY = 'sharesync:master-volume'
export const NOISE_SUPPRESSION_KEY = 'sharesync:noise-suppression'
export const NOISE_INTENSITY_KEY = 'sharesync:noise-intensity'

// Login — últimos nome/servidor/sala usados, pra preencher os campos
// sozinho na próxima vez que o app abrir (ver js/login.js).
export const LAST_NAME_KEY = 'sharesync:last-name'
export const LAST_SERVER_KEY = 'sharesync:last-server'
export const LAST_ROOM_KEY = 'sharesync:last-room-id'

// Volume por participante — salvo pelo NOME (não pelo id de socket, que é
// gerado de novo a cada conexão e não sobreviveria a um reabrir do app).
// Mapa completo mora em localStorage como { [username]: volume }; ver
// loadVolumesByName/saveVolumeByName em js/voice/volume.js.
export const PARTICIPANT_VOLUMES_KEY = 'sharesync:participant-volumes'

export const state = {
  myId:      null,
  myName:    '',
  roomId:    null,
  serverUrl: '',

  // WebSocket
  ws: null,

  // Cada par de usuários pode ter DUAS conexões independentes, uma pra
  // cada sentido — "eu assisto ele" e "ele assiste eu" são coisas
  // diferentes e podem estar ativas ao mesmo tempo (assistir mútuo).
  // Antes isso dividia uma única RTCPeerConnection por usuário, e cada
  // offer recém-chegada substituía a conexão existente por baixo do pano
  // — causava colisão de sinalização (glare) e a tela ficava preta pro
  // outro lado quando os dois se assistiam ao mesmo tempo.
  // watchPeers: { userId: RTCPeerConnection } — eu sou o offerer, só recebo
  watchPeers: {},
  // sharePeers: { userId: RTCPeerConnection } — eu sou o answerer, só envio
  sharePeers: {},

  // Streams recebidos: { userId: MediaStream }
  remoteStreams: {},

  // Usuários na sala: { userId: { username, sharing } }
  users: {},

  // Quem estou assistindo (stream já chegou e está exibindo)
  watching: new Set(),

  // Quem eu pedi pra assistir mas a negociação WebRTC ainda não terminou
  // (ver toggleWatch) — importante pra não mostrar "Assistindo" antes da
  // hora: isso fazia a pessoa clicar de novo achando que travou, cancelando
  // a conexão bem na hora em que o vídeo chegava (video.play() interrompido
  // porque o card foi removido no meio do play — DOMException no console).
  connecting: new Set(),

  // Minha stream local (quando compartilho) — por padrão não aparece na
  // tela, só é usada pra enviar aos outros participantes. Opcionalmente
  // (ver checkbox "Mostrar minha tela") aparece numa prévia local mudinha
  // no canto inferior direito (ver updateSelfPreview).
  localStream: null,
  sharing: false,

  // Preferência de mostrar a autovisualização — persiste em localStorage
  // (SELF_PREVIEW_KEY) e vira o padrão pras próximas vezes que compartilhar.
  showSelfPreview: localStorage.getItem(SELF_PREVIEW_KEY) === 'true',

  // Qualidade padrão ao começar a assistir alguém (Configurações → Live) —
  // 'auto' ou uma altura em px ('360'/'480'/'720'/'1080'). Dá pra mudar na
  // hora por live, no seletor de cada card (ver upsertStreamCard).
  defaultWatchQuality: localStorage.getItem(DEFAULT_WATCH_QUALITY_KEY) || 'auto',

  // Stream em foco na tela (as demais ficam minimizadas embaixo)
  focusedId: null,

  // Medição de latência (ping) — histórico curto pro popover de detalhe
  // (ver ping-box no hover), últimas ~20 amostras (~1min a cada 3s)
  pingInterval: null,
  pingWaiting: false,
  pingHistory: [],

  // Timeouts de "assistir" pendente — evita loading infinito (ver toggleWatch)
  watchTimeouts: {},

  // Intervalos que leem getStats() pra mostrar resolução/bitrate reais
  // recebidos em cada card (ver upsertStreamCard) — prova concreta de que
  // o seletor de qualidade está realmente mudando o que chega pela rede.
  statsIntervals: {},

  // Últimos snapshots recebidos de cada compartilhamento — { userId: dataURL
  // jpeg }. Usado na prévia ao passar o mouse na sidebar pra quem você
  // ainda não está assistindo (ver showParticipantPreview). Quem compartilha
  // manda um novo a cada 3min (ver captureAndSendSnapshot).
  screenSnapshots: {},
  snapshotInterval: null,

  // ── CHAT DE VOZ ──
  // Uma RTCPeerConnection bidirecional por participante (mic vai e vem na
  // mesma conexão — diferente do compartilhamento de tela, que é sempre
  // uma via só). Mapas separados de watchPeers/sharePeers acima.
  voicePeers: {},
  // <audio> criado em runtime por participante, só pra tocar o mic dele
  // (ver createVoicePeer/ontrack) — nunca aparece na tela.
  voiceAudioEls: {},
  // Minha captura de microfone — uma só, compartilhada com todas as
  // conexões de voz (o mesmo MediaStreamTrack é adicionado em cada uma).
  localMicStream: null,
  localMicInputStream: null,
  micMuted: localStorage.getItem(MIC_MUTED_KEY) === 'true',
  micDeviceId: localStorage.getItem(MIC_DEVICE_KEY) || '',
  speakerDeviceId: localStorage.getItem(SPEAKER_DEVICE_KEY) || '',
  // Só o volume POR PARTICIPANTE (ver participantVolumes abaixo) amplifica
  // além de 100% — o geral serve pra abaixar tudo de uma vez, por isso fica
  // travado em 0-100 (o Math.min cobre quem tinha um valor antigo >100
  // salvo de uma versão anterior deste slider).
  masterVolume: Math.min(100, Number(localStorage.getItem(MASTER_VOLUME_KEY) ?? 100)),
  noiseSuppression: localStorage.getItem(NOISE_SUPPRESSION_KEY) !== 'false',
  noiseIntensity: Number(localStorage.getItem(NOISE_INTENSITY_KEY) ?? 85),
  // Volume individual que EU escolhi pra ouvir cada participante (local,
  // não afeta o que os outros ouvem) — 0-100, 100 é o padrão.
  participantVolumes: {},
  // Guarda o último volume não-zero de cada participante, pra restaurar ao
  // desmutar (mesma ideia do lastVolume nos cards de stream).
  participantLastVolume: {},
  // Quem está falando agora (chat de voz) — inclui o próprio usuário.
  // Preenchido por detecção local de volume (ver startSpeakingLoop),
  // nenhuma mensagem nova de WebSocket é necessária pra isso.
  speaking: new Set(),
}
