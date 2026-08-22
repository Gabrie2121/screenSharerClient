# Sons de aviso — placeholders

Cada arquivo aqui é um **placeholder**. O registro em
`src/renderer/js/core/sounds.js` já referencia todos os nomes abaixo; se o
arquivo não existir, o som simplesmente não toca (a entrada é marcada como
indisponível na primeira tentativa e nunca mais é procurada). Nada quebra.

Para ativar um som, basta soltar o `.mp3` aqui com o nome exato:

| Arquivo              | Quando toca                                          |
|----------------------|------------------------------------------------------|
| `share-stop.mp3`     | alguém (ou você) para de compartilhar a tela         |
| `user-join.mp3`      | alguém entra na sala                                 |
| `user-leave.mp3`     | alguém sai da sala                                   |
| `camera-on.mp3`      | você ou alguém liga a câmera                         |
| `camera-off.mp3`     | você desliga a câmera                                |
| `mic-mute.mp3`       | você muta o microfone                                |
| `mic-unmute.mp3`     | você desmuta o microfone                             |
| `viewer-joined.mp3`  | alguém começou a assistir a SUA tela (3s depois)     |

O `viewer-joined` tem atraso proposital de 3 segundos: na hora da oferta a
conexão ainda está negociando e pode nem completar. Passados alguns
segundos, a pessoa de fato já está te vendo — que é o que importa avisar.

Ainda **faltam** três: `camera-on.mp3`, `camera-off.mp3` e
`viewer-joined.mp3`. Enquanto não existirem, esses três eventos ficam
mudos — nada quebra.

O `holy.mp3`, em `src/assets/`, era o som antigo de "alguém compartilhou".
Ficou no repositório: para voltar a usá-lo, basta apontar o `src` de
`share-start` para ele no registro.

Todos são cortados no começo (ver `cut` no registro): não precisam ser
curtos, só ter um início bom.
