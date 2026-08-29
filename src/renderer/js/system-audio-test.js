import { $ } from './core/dom.js'
import { appLog } from './core/logger.js'

/* ═══════════════════════════════════════════════════════════════
   TESTE DO ÁUDIO DO SISTEMA (Configurações → Avançado)

   A captura de loopback do Windows falha em algumas máquinas e o sintoma
   chega sempre igual: "transmiti e não foi som nenhum". As causas conhecidas
   são todas de fora do app — controle exclusivo do dispositivo de saída,
   driver virtual (headset sem fio, mixers), antivírus com proteção de
   áudio — e cada tentativa de arrumar exigia entrar numa sala, compartilhar
   e perguntar pra alguém se estava ouvindo.

   Aqui a mesma captura é feita na hora, sozinha, e o erro exato aparece na
   tela. A stream é descartada no mesmo instante: nada é transmitido, nada
   entra em sala nenhuma.

   Só o vídeo é pedido junto porque `getDisplayMedia` exige vídeo — o que
   interessa é se veio track de áudio.
═══════════════════════════════════════════════════════════════ */

const btn = $('btn-test-system-audio')
const resultado = $('system-audio-result')

function mostrar(texto, tipo) {
  resultado.textContent = texto
  resultado.classList.remove('hidden')
  resultado.dataset.resultado = tipo
}

btn.onclick = async () => {
  btn.disabled = true
  btn.textContent = 'Testando…'
  mostrar('Pedindo a captura ao Windows…', 'andamento')

  let stream = null
  try {
    // Mesma fonte que a transmissão usaria por padrão (a primeira tela) —
    // o processo principal resolve isso quando pendingSourceId está vazio.
    const fontes = await window.electronAPI?.getSources?.()
    const tela = fontes?.find(f => f.id.startsWith('screen:')) || fontes?.[0]
    if (tela) window.electronAPI?.setCaptureSourceId(tela.id)

    stream = await navigator.mediaDevices.getDisplayMedia({
      video: true,
      audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
      systemAudio: 'include',
    })

    const audio = stream.getAudioTracks()
    if (audio.length) {
      mostrar(`Funcionou — o som do sistema foi capturado (${audio[0].label || 'sem rótulo'}).`
        + ' Suas transmissões vão com áudio.', 'ok')
      appLog('INFO', `[TESTE] áudio do sistema OK: ${audio[0].label}`)
    } else {
      // getDisplayMedia respondeu, mas sem track de áudio: o Windows
      // entregou só o vídeo em silêncio, sem erro nenhum.
      mostrar('A captura funcionou, mas veio SEM faixa de áudio —'
        + ' o Windows entregou só o vídeo.', 'aviso')
      appLog('WARN', '[TESTE] áudio do sistema: captura sem faixa de áudio')
    }
  } catch (err) {
    const saida = await saidaPadrao()
    // Causas em ordem do que mais explicou casos reais. A do som surround
    // vem primeiro porque é a que passa despercebida: nada no Windows
    // indica que o dispositivo está em 7.1, e headsets gamer costumam vir
    // assim de fábrica pelo software do fabricante.
    mostrar(`Falhou: ${err.name} — ${err.message}.`
      + `\nSaída de áudio padrão: ${saida}.`
      + '\n\n1) Som surround (7.1) ligado na saída. A captura do Windows costuma se recusar'
      + ' a abrir dispositivos multicanal. Desligue o surround/DTS no software do fabricante'
      + ' (Logitech G HUB, SteelSeries GG, Razer Synapse) ou ponha a saída em 2 canais em'
      + ' Configurações do Windows → Som → Mais configurações de som → Reprodução →'
      + ' Propriedades → Avançado → Formato padrão.'
      + '\n\n2) Antivírus com proteção de captura de áudio (Kaspersky, ESET, Bitdefender).'
      + ' O loopback é um dispositivo de captura como qualquer outro, e essas suítes o'
      + ' bloqueiam mesmo já tendo liberado o microfone.'
      + '\n\n3) Controle exclusivo do dispositivo, na mesma aba Avançado: desmarque'
      + ' "Permitir que aplicativos assumam controle exclusivo deste dispositivo".'
      + '\n\nTeste decisivo: troque a saída padrão para outro dispositivo (um monitor, que'
      + ' costuma ser estéreo) e clique aqui de novo. Se ficar verde, o problema é a saída'
      + ' anterior — não o app nem o antivírus.', 'erro')
    appLog('ERROR', `[TESTE] áudio do sistema falhou: ${err.name} ${err.message} | saída: ${saida}`)
  } finally {
    // Sempre descarta: o teste não pode deixar uma captura de tela viva.
    stream?.getTracks().forEach(t => t.stop())
    btn.disabled = false
    btn.textContent = 'Testar agora'
  }
}

async function saidaPadrao() {
  try {
    const devices = await navigator.mediaDevices.enumerateDevices()
    const padrao = devices.find(d => d.kind === 'audiooutput' && d.deviceId === 'default')
    return padrao?.label || 'desconhecida'
  } catch {
    return 'desconhecida'
  }
}
