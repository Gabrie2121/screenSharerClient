/* ═══════════════════════════════════════════════════════════════
   ESTADO — objeto compartilhado, mutado in-place por todos os módulos
   que precisam dele (importe `state` e leia/grave direto nas chaves).
═══════════════════════════════════════════════════════════════ */
// O que aparece de MIM no palco (ver js/self-tile.js e js/camera-tiles.js).
// Ligados por padrão: o normal é querer se ver; quem não quiser desliga.
export const SHOW_SELF_SCREEN_KEY = 'sharesync:show-self-screen'
export const SHOW_SELF_CAMERA_KEY = 'sharesync:show-self-camera'
// Prévia FLUTUANTE da própria tela — outra coisa: uma janelinha por cima da
// interface, não um tile do palco (ver js/self-preview.js).
export const SELF_PREVIEW_KEY = 'sharesync:show-self-preview'
// Onde a autovisualização ficou por último — { left, top, width }. É posição
// de janela, não de sala: vale pra qualquer sala que a pessoa entrar depois
// (ver js/self-preview.js).
export const SELF_PREVIEW_POS_KEY = 'sharesync:self-preview-pos'
export const DEFAULT_WATCH_QUALITY_KEY = 'sharesync:default-watch-quality'
// PiP automático ao minimizar/esconder o app (ver js/auto-pip.js).
export const AUTO_PIP_KEY = 'sharesync:auto-pip'
// O que o mini player mostra: 'auto' | 'screens' | 'cameras' (ver js/auto-pip.js).
export const PIP_SOURCE_KEY = 'sharesync:pip-source'
export const SHARE_AUDIO_KEY = 'sharesync:share-audio'

// Chat de voz — preferências persistidas (ver seção "CHAT DE VOZ" em js/voice/).
export const MIC_MUTED_KEY = 'sharesync:mic-muted'
export const MIC_DEVICE_KEY = 'sharesync:mic-device'
export const SPEAKER_DEVICE_KEY = 'sharesync:speaker-device'
// Câmera escolhida em Configurações → Vídeo (ver js/webrtc/camera.js).
export const CAM_DEVICE_KEY = 'sharesync:cam-device'
export const MASTER_VOLUME_KEY = 'sharesync:master-volume'
export const NOISE_SUPPRESSION_KEY = 'sharesync:noise-suppression'
export const NOISE_INTENSITY_KEY = 'sharesync:noise-intensity'
// Abaixar o áudio das telas enquanto alguém fala (ver js/share-audio-duck.js).
export const DUCK_ENABLED_KEY = 'sharesync:duck-while-talking'
export const DUCK_AMOUNT_KEY = 'sharesync:duck-amount'

// Avisos sonoros (ver core/sounds.js) — liga/desliga e volume, separados do
// volume do chat de voz: são coisas diferentes e a pessoa costuma querer o
// aviso bem mais baixo que as vozes.
export const SOUNDS_ENABLED_KEY = 'sharesync:sounds-enabled'
export const SOUNDS_VOLUME_KEY = 'sharesync:sounds-volume'

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
  // !== 'false' e não === 'true': o padrão é ligado, então só um "false"
  // explicitamente salvo desliga.
  showSelfScreen: localStorage.getItem(SHOW_SELF_SCREEN_KEY) !== 'false',
  showSelfCamera: localStorage.getItem(SHOW_SELF_CAMERA_KEY) !== 'false',

  // Qualidade padrão ao começar a assistir alguém (Configurações → Live) —
  // 'auto' ou uma altura em px ('360'/'480'/'720'/'1080'). Dá pra mudar na
  // hora por live, no seletor de cada card (ver upsertStreamCard).
  defaultWatchQuality: localStorage.getItem(DEFAULT_WATCH_QUALITY_KEY) || 'auto',

  // Continuar vendo a tela numa janelinha flutuante do SO quando o app é
  // minimizado ou escondido pra bandeja (ver js/auto-pip.js). Ligado por
  // padrão — é o motivo de o app ir pra bandeja em vez de fechar.
  autoPip: localStorage.getItem(AUTO_PIP_KEY) !== 'false',
  // Padrão 'auto': mostra tudo o que estiver aberto, telas e câmeras.
  pipSource: localStorage.getItem(PIP_SOURCE_KEY) || 'auto',

  // Qualidade que cada espectador pediu da MINHA tela — { viewerId: altura|null }.
  // Precisa ficar guardado porque applyViewerQuality calcula o
  // scaleResolutionDownBy a partir da altura NATIVA da captura atual; ao
  // trocar de tela sem parar a transmissão (ver switchSource em
  // webrtc/capture.js) essa base muda, e sem reaplicar os pedidos guardados
  // aqui todo mundo que tinha escolhido 360p/480p voltava pra resolução cheia.
  viewerQuality: {},

  // Tile em foco no palco — as demais ficam minimizadas numa tira embaixo.
  // Guarda a CHAVE do tile ('screen:<uid>' ou 'cam:<uid>', ver tileKey em
  // js/stage-layout.js), não o user id: quem compartilha a tela e está com
  // a câmera ligada tem dois tiles ao mesmo tempo.
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

  /* ── CÂMERA (WEBCAM) ──
     Mais DOIS mapas separados, pelo mesmo motivo de watchPeers/sharePeers:
     "eu mando minha câmera pra ele" e "eu recebo a câmera dele" são
     conexões independentes e podem estar ativas ao mesmo tempo. Unificar
     traria de volta a colisão de sinalização (glare) descrita acima.

     A diferença pro compartilhamento de tela é QUEM OFERTA. Na tela, quem
     oferta é quem quer assistir (ninguém recebe stream sem clicar). Câmera
     é auto-inscrita — ligou, todo mundo vê —, então quem oferta é quem
     LIGA a câmera, pra cada participante. Só essa ponta tem mídia nova,
     então não há duas ofertas simultâneas entre o mesmo par. */
  // camPeers:     { userId: RTCPeerConnection } — eu ENVIO minha câmera (offerer)
  camPeers: {},
  // camViewPeers: { userId: RTCPeerConnection } — eu RECEBO a câmera dele (answerer)
  camViewPeers: {},
  // Câmeras recebidas: { userId: MediaStream }
  camStreams: {},

  localCamStream: null,
  cameraOn: false,
  camDeviceId: localStorage.getItem(CAM_DEVICE_KEY) || '',

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
  // 40% era o volume fixo do antigo shareSound — vira só o padrão agora.
  soundsEnabled: localStorage.getItem(SOUNDS_ENABLED_KEY) !== 'false',
  soundsVolume: Number(localStorage.getItem(SOUNDS_VOLUME_KEY) ?? 40),
  noiseIntensity: Number(localStorage.getItem(NOISE_INTENSITY_KEY) ?? 100),
  // DESLIGADO por padrão desde que a captura por processo entrou (ver
  // native/process-audio): com ela, a voz do chat nem chega a fazer parte
  // do áudio da tela, então não há eco pra abafar. Isto virou plano B pra
  // quem cai no loopback antigo — Windows anterior ao 2004, ou binário
  // nativo ausente.
  duckWhileTalking: localStorage.getItem(DUCK_ENABLED_KEY) === 'true',
  // Quanto abaixar, em %. 70 = o som da tela cai pra 30% enquanto alguém fala.
  duckAmount: Number(localStorage.getItem(DUCK_AMOUNT_KEY) ?? 70),
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
